// getShopifyToken.js

import axios from 'axios';
 
let cachedToken = null;

let tokenExpiry = 0;
 
export async function getShopifyToken() {

  const now = Date.now();
 
  // If token exists and hasn't expired, return it

  if (cachedToken && now < tokenExpiry) {

    return cachedToken;

  }
 
  // Request a new token

  const url = `https://${process.env.SHOP}/admin/oauth/access_token`;
 
  const payload = {

    client_id: process.env.SHOPIFY_CLIENT_ID,

    client_secret: process.env.SHOPIFY_CLIENT_SECRET,

    grant_type: "client_credentials"

  };
 
  const response = await axios.post(url, payload, {

    headers: { "Content-Type": "application/json" }

  });
 
  cachedToken = response.data.access_token;

  tokenExpiry = now + (response.data.expires_in * 1000); // 24 hours
 
  return cachedToken;

}

 
