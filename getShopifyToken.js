import fetch from "node-fetch";
 
let cachedToken = null;
let tokenExpiry = 0;
 
export async function getShopifyToken() {
  const now = Date.now();
 
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }
 
  const url = `https://${process.env.SHOP}/admin/oauth/access_token`;
 
  const payload = {
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    grant_type: "client_credentials"
  };
 
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
 
  const data = await resp.json();
 
  cachedToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000;
 
  return cachedToken;
}
