import express from "express";
import fetch from "node-fetch";
import { getShopifyToken } from "./getShopifyToken.js";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP;
const API_VERSION = process.env.API_VERSION || "2026-04";
// ============================================================
// 🧠 Local In-Memory Lock (Prevents Race Conditions)
// ============================================================
const localLocks = new Map();
if (!SHOP) {
  console.error("❌ Missing required env var: SHOP");
}

const shopBaseUrl = `https://${SHOP}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Check HTTP errors; only repeat POST requests after an explicit rate limit.
async function checkedShopifyFetch(url, options = {}, retries = 5) {
  const method = options.method || "GET";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await getShopifyToken();
    if (!token) throw new Error("Shopify access token is missing");
    const resp = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}), "X-Shopify-Access-Token": token },
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (resp.ok) {
      if (!data || typeof data !== "object") throw new Error(`Invalid JSON from Shopify: ${url}`);
      return data;
    }
    console.error("❌ Shopify API request failed:", { url, status: resp.status, response: data || text });
    const err = new Error(`Shopify request failed (${resp.status}): ${url}`);
    err.status = resp.status;
    const retryable = resp.status === 429 || (["GET", "PUT"].includes(method) && [500, 502, 503, 504].includes(resp.status));
    if (!retryable || attempt === retries) throw err;
    const header = resp.headers.get("retry-after");
    const seconds = header === null ? NaN : Number(header);
    await sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000 * (attempt + 1));
  }
}

async function readOrderMetafield(orderId, key) {
  const query = new URLSearchParams({ namespace: "custom", key, limit: "250" });
  const data = await checkedShopifyFetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json?${query}`);
  if (!Array.isArray(data.metafields)) throw new Error(`Invalid metafield response for order ${orderId}`);
  return data.metafields.find(m => m.namespace === "custom" && m.key === key) || null;
}

// Repair only this metafield, then verify it. Never creates a child order.
async function saveVerifiedMetafield(orderId, key, type, value) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const existing = await readOrderMetafield(orderId, key);
      if (existing?.value !== value || existing?.type !== type) {
        const url = existing?.id
          ? `${shopBaseUrl}/admin/api/${API_VERSION}/metafields/${existing.id}.json`
          : `${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json`;
        const metafield = existing?.id ? { id: existing.id, type, value } : { namespace: "custom", key, type, value };
        await checkedShopifyFetch(url, { method: existing?.id ? "PUT" : "POST", body: JSON.stringify({ metafield }) });
      }
      const saved = await readOrderMetafield(orderId, key);
      if (saved?.value !== value || saved?.type !== type) throw new Error(`Readback mismatch for order ${orderId}, custom.${key}: expected ${value}, got ${saved?.value ?? "missing"}`);
      console.log(`✅ Verified custom.${key} for order ${orderId}: ${value} (attempt ${attempt})`);
      return;
    } catch (err) {
      lastError = err;
      console.error(`❌ Verification failed for order ${orderId}, custom.${key}, attempt ${attempt}/3: ${err.message}`);
      if ([400, 401, 403, 422].includes(err.status)) break;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

// Normalize dates
function normalizeDate(input) {
  if (!input || typeof input !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
// Fetch parent pickup location
async function getParentPickupLocation(orderId) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/fulfillment_orders.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await getShopifyToken(),
    },
  });
  const data = await resp.json();
  const assignedLocationId = data?.fulfillment_orders?.[0]?.assigned_location_id || null;
  console.log(`📍 Parent assigned location: ${assignedLocationId}`);
  return assignedLocationId;
}
// Extract parent pickup date
function getParentPickupDate(order) {
  const pickupDateFromNotes = Array.isArray(order.note_attributes)
    ? order.note_attributes.find(attr => attr.name === "Pickup Date")?.value || null
    : null;
  const pickupDateFallback = Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
    ? order.line_items[0].properties.find(p => p.name === "Pickup Date")?.value || null
    : null;
  return normalizeDate(pickupDateFromNotes || pickupDateFallback);
}
// Fetch latest parent order
async function getParentOrder(orderId) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": await getShopifyToken(),
    },
  });
  const data = await resp.json();
  return data.order;
}
// ============================================================
// 🔒 Metafield Lock Helpers (custom.processing_lock)
// ============================================================
async function getProcessingLock(orderId) {
  return (await readOrderMetafield(orderId, "processing_lock"))?.value || null;
}
async function setProcessingLock(orderId, value) {
  await saveVerifiedMetafield(orderId, "processing_lock", "single_line_text_field", value);
  console.log(`🔒 Lock for order ${orderId} set to: ${value}`);
}
async function assertLockAvailable(orderId) {
  const lock = await getProcessingLock(orderId);
  if (lock === "in_progress") {
    console.log(`⛔ Split already in progress for ${orderId}. Skipping.`);
    return false;
  }
  if (lock === "failed") {
    console.log(`⛔ Parent ${orderId} previously failed. Manual review required; not recreating children.`);
    return false;
  }
  if (lock === "done") {
    console.log(`⛔ Split already completed for ${orderId}. Skipping.`);
    return false;
  }
  return true;
}
app.post("/webhook/orders/create", async (req, res) => {
   const order = req.body;
  // ============================================================
  // ⚠️ SAFETY GUARD — malformed or empty webhook payload
  // ============================================================
  if (!order || !order.id) {
    console.log("⚠️ Webhook received with no order payload. Skipping.");
    return res.status(200).send("No order payload");
  }
  // ============================================================
  // 🔒 EARLY LOCAL LOCK — MUST BE FIRST, BEFORE ANY AWAIT
  // ============================================================
  if (localLocks.get(order.id)) {
    console.log(`⛔ Local lock active for ${order.id}. Skipping.`);
    return res.status(200).send("Local lock skip");
  }
  localLocks.set(order.id, true);
  console.log(`🔒 Local lock engaged for ${order.id}`);

   // Normalize Shopify tags into an array
   const tagsArray = Array.isArray(order.tags)
     ? order.tags
     : typeof order.tags === "string"
       ? order.tags.split(",").map(t => t.trim())
       : [];
   let processingStarted = false;
   try {
     console.log(`🔔 Webhook fired for order ${order.id}`);

    // 🚧 Diff Entry #23 — Prevent child webhooks from interrupting parent split
    // This must run BEFORE any splitting logic.
    // 1. If this order is a child, skip immediately.
    if (order.tags && order.tags.includes("Split-Child")) {
        console.log(`↩️ Child order ${order.id} detected at webhook entry. Skipping.`);
        return res.status(200).send("Child order skipped");
    }
    // 2. If the parent split is already in progress, skip ALL webhooks except the parent itself.
    const lockState = await getProcessingLock(order.id);
if (lockState === "in_progress" && !tagsArray.some(t => t.startsWith("Parent-#"))) {
        console.log(`⛔ Split already in progress for ${order.id}. Skipping webhook.`);
        return res.status(200).send("Parent split in progress");
    }

    // ============================================================
    // 🔒 Duplicate Webhook Guard + Initial Lock Write
    // ============================================================
    // 1. Check if lock is available
    const lockAvailable = await assertLockAvailable(order.id);
    if (!lockAvailable) {
      console.log(`⛔ Lock prevents processing for ${order.id}. Exiting early.`);
      return res.status(200).send("Split skipped due to lock");
    }
    // 🚫 Skip child orders immediately
    if ((order.tags || "").includes("Split-Child")) {
      console.log("↩️ Child order detected. Skipping split.");
      return res.status(200).send("Child order skipped");
    }
    // ✅ Double-check parent order tags from Shopify before splitting
    const latestParent = await getParentOrder(order.id);
    if ((latestParent.tags || "").includes("Split-Processed") || (latestParent.tags || "").includes("Truckload-Ready")) {
      console.log("↩️ Parent already marked as processed. Skipping split.");
      return res.status(200).send("Already processed");
    }
    processingStarted = true;
    await setProcessingLock(order.id, "in_progress");
    // 🏷️ Tag parent immediately to prevent duplicate splits
    const newTags = order.tags ? `${order.tags}, Split-Processed` : "Split-Processed";
    await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getShopifyToken(),
      },
      body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
    });
    console.log(`🏷️ Parent ${order.name} tagged as Split-Processed before child creation`);
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) {
      console.log("⚠️ No line items found on order");
      await setProcessingLock(order.id, "done");
      return res.status(200).send("No line items");
    }
    // Fetch parent pickup context
    const parentLocationId = await getParentPickupLocation(order.id);
    const parentPickupDate = getParentPickupDate(order);
    let childOrdersCreated = false;
    // Outer loop over line items
    const multipleProducts = lineItems.length > 1;
    // ============================================================
    // 📦 SPLIT LOGIC — Outer loop over line items
    // ============================================================
    for (const item of lineItems) {
      if (!item?.product_id || !item?.variant_id) continue;
      const metaResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await getShopifyToken(),
        },
      });
      const metaData = await metaResp.json();
      const truckloadMeta = Array.isArray(metaData?.metafields)
        ? metaData.metafields.find(m => m.key === "truckload_capacity" && ["custom", "logistics"].includes(m.namespace))
        : null;
      const truckloadCapacity = parseInt(truckloadMeta?.value ?? "0", 10);
      let splitQuantities = [];
      console.log(`🔍 Checking item ${item.title} (qty ${item.quantity}) with truckloadCapacity=${truckloadCapacity}`);
      if (!Number.isFinite(truckloadCapacity) || truckloadCapacity <= 0) {
        console.log(`⚠️ Skipping ${item.title} — invalid truckloadCapacity`);
        continue;
      }
      // Case: quantity less than capacity → still create one child order
      if (item.quantity < truckloadCapacity) {
        console.log(`📦 Qty ${item.quantity} < capacity ${truckloadCapacity} — creating one child order`);
        splitQuantities = [item.quantity];
      }
      // Case: quantity equals capacity
      if (item.quantity === truckloadCapacity) {
        if (multipleProducts) {
          console.log(`✅ Equal capacity for ${item.title}, creating one child order since parent has multiple products`);
          splitQuantities = [item.quantity];
        } else {
          console.log(`🏷️ Parent-only product ${item.title} at capacity, tagging parent as Truckload-Ready`);
          const newTags = order.tags ? `${order.tags}, Truckload-Ready` : "Truckload-Ready";
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": await getShopifyToken(),
            },
            body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
          });
          continue;
        }
      }
      // Case: quantity greater than capacity → normal split
      if (item.quantity > truckloadCapacity) {
        const fullLoads = Math.floor(item.quantity / truckloadCapacity);
        const remainder = item.quantity % truckloadCapacity;
        splitQuantities = Array(fullLoads).fill(truckloadCapacity);
        if (remainder > 0) splitQuantities.push(remainder);
      }
      console.log(`Split quantities for ${item.title}:`, splitQuantities);
      // ============================================================
      // 📦 Inner loop — Create each child order
      // ============================================================
      for (let i = 0; i < splitQuantities.length; i++) {
        const qty = splitQuantities[i];
const projectName = Array.isArray(item.properties)
  ? item.properties.find(p => p.name === "Project Name")?.value || null
  : null;

const pickupDateRaw = Array.isArray(item.properties)
  ? item.properties.find(p => p.name === "Pickup Date")?.value || null
  : null;

const pickupDateNormalized = normalizeDate(pickupDateRaw);

// 🔹 Extract per-item warehouse instructions from line item property "Customer Note"
const warehouseInstructionsRaw = Array.isArray(item.properties)
  ? item.properties.find(p => p.name === "Customer Note")?.value || null
  : null;

const warehouseInstructions = warehouseInstructionsRaw?.trim() || null;

// Build child note
let childNoteParts = [];
if (pickupDateNormalized) childNoteParts.push(`Pickup Date: ${pickupDateNormalized}`);
if (warehouseInstructions) childNoteParts.push(`Warehouse Instructions: ${warehouseInstructions}`);

const childNote = childNoteParts.join(" | ");
console.log(`🔎 Child order ${i + 1} — Note: ${childNote}`);


        const newOrderPayload = {
          order: {
            line_items: [{
              variant_id: item.variant_id,
              quantity: qty,
              location_id: parentLocationId,
            }],
            customer: order.customer ?? undefined,
            shipping_address: order.shipping_address ?? undefined,
            billing_address: order.billing_address ?? undefined,
            email: order.email ?? undefined,
            note: childNote || null,
            tags: [
              `Split-Child`,
              `Truckload ${i + 1}`,
              `Parent-${order.name}`,
              `Product-${item.product_id}`,
              `LineItem-${item.id}`
            ],
            purchase_order_number: projectName,
            metafields: [],
            fulfillment_status: "unfulfilled",
          },
        };
        console.log("🧾 Creating child order payload:", JSON.stringify(newOrderPayload, null, 2));
        const createdOrder = await checkedShopifyFetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
          method: "POST",
          body: JSON.stringify(newOrderPayload),
        });
        if (!createdOrder.order?.id) throw new Error(`Child creation returned no ID for parent ${order.id}; review before retrying`);
        console.log(`✅ Created child order ${createdOrder.order.id} with tags: ${createdOrder.order.tags}`);
        childOrdersCreated = true;
        // Attach project name metafield
        if (projectName) {
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": await getShopifyToken(),
            },
            body: JSON.stringify({
              metafield: {
                namespace: "custom",
                key: "project_name",
                type: "single_line_text_field",
                value: projectName,
                owner_id: createdOrder.order.id,
                owner_resource: "order",
              },
            }),
          });
        }
        // Attach pickup date metafield
        const effectivePickupDate = pickupDateNormalized || parentPickupDate;
        if (effectivePickupDate) {
          await saveVerifiedMetafield(createdOrder.order.id, "pickup_date", "date", effectivePickupDate);
        } else {
          console.warn(`⚠️ Child ${createdOrder.order.id}: no pickup date in line item or parent`);
        }
        await sleep(500);
      }
    }
        // ============================================================
    // 🏷️ Parent project name metafield
    // ============================================================
    const projectNameFromNotes = Array.isArray(order.note_attributes)
      ? order.note_attributes.find(attr => attr.name === "Project Name")?.value || null
      : null;
    const projectNameFallback = Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
      ? order.line_items[0].properties.find(p => p.name === "Project Name")?.value || null
      : null;
    const parentProjectName = projectNameFromNotes || projectNameFallback;
    if (parentProjectName) {
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await getShopifyToken(),
        },
        body: JSON.stringify({
          metafield: {
            namespace: "custom",
            key: "project_name",
            type: "single_line_text_field",
            value: parentProjectName,
            owner_id: order.id,
            owner_resource: "order",
          },
        }),
      });
    }
    // ============================================================
    // 📅 Parent pickup date metafield
    // ============================================================
    if (parentPickupDate) {
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await getShopifyToken(),
        },
        body: JSON.stringify({
          metafield: {
            namespace: "custom",
            key: "pickup_date",
            type: "date",
            value: parentPickupDate,
            owner_id: order.id,
            owner_resource: "order",
          },
        }),
      });
    }
    // ============================================================
    // 🔒 FINAL LOCK COMPLETION — after child date verification
    // ============================================================
    // ============================================================
    // 🏷️ Final parent tagging logic
    // ============================================================
    if (!childOrdersCreated) {
      const newTagsFinal = order.tags ? `${order.tags}, Truckload-Ready` : "Truckload-Ready";
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": await getShopifyToken(),
        },
        body: JSON.stringify({ order: { id: order.id, tags: newTagsFinal } }),
      });
      console.log(`🏷️ Parent ${order.name} tagged as Truckload-Ready (no child orders created)`);
    }
    await setProcessingLock(order.id, "done");
    console.log(`🔒 Split completed with expected child dates verified for ${order.id}`);
    res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    if (processingStarted) {
      try { await setProcessingLock(order.id, "failed"); }
      catch (lockError) { console.error(`❌ Could not save failed lock for parent ${order.id}; manual review required:`, lockError); }
    }
    res.status(500).send("Error");
  } finally {
    // ============================================================
    // 🔓 ALWAYS Release Local Lock
    // ============================================================
    if (order?.id && localLocks.get(order.id)) {
      localLocks.delete(order.id);
      console.log(`🔓 Local lock released for ${order.id}`);
    }
  }
});
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
