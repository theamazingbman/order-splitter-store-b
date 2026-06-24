import fetch from "node-fetch";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export async function getShopifyToken() {
  const shop = process.env.SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

  if (!shop) {
    throw new Error("Missing SHOP in Render environment");
  }

  if (!clientId) {
    throw new Error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_API_KEY in Render environment");
  }

  if (!clientSecret) {
    throw new Error("Missing SHOPIFY_CLIENT_SECRET or SHOPIFY_API_SECRET in Render environment");
  }

  const cleanShop = shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const tokenUrl = `https://${cleanShop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });

  const text = await resp.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    console.error("❌ Shopify token endpoint returned non-JSON:", {
      status: resp.status,
      statusText: resp.statusText,
      contentType: resp.headers.get("content-type"),
      bodyStart: text.slice(0, 500),
    });

    throw new Error(
      `Shopify token endpoint did not return JSON. Status ${resp.status}. Body starts with: ${text.slice(0, 120)}`
    );
  }

  if (!resp.ok || !data.access_token) {
    console.error("❌ Shopify token request failed:", {
      status: resp.status,
      statusText: resp.statusText,
      response: data,
    });

    throw new Error(`Shopify token request failed with status ${resp.status}`);
  }

  cachedToken = data.access_token;

  const expiresInSeconds = Number(data.expires_in || 86399);
  cachedTokenExpiresAt = Date.now() + expiresInSeconds * 1000;

  console.log("✅ Shopify access token generated", {
    scope: data.scope,
    expiresInSeconds,
  });

  return cachedToken;
}
