import { fetchJson } from "../utils/http.js";

export async function getShopifyOrder({
  storeUrl,
  accessToken,
  orderId,
  apiVersion,
}) {
  const baseUrl = String(storeUrl || "").replace(/\/$/, "");

  if (!baseUrl) {
    throw new Error("Merchant is missing Shopify Store URL");
  }

  if (!accessToken) {
    throw new Error("Merchant is missing Shopify Token");
  }

  if (!orderId) {
    throw new Error(
      "Pending Intake record is missing Shopify Order ID"
    );
  }

  const url =
    `${baseUrl}/admin/api/${apiVersion}/orders/` +
    `${encodeURIComponent(String(orderId))}.json`;

  const body = await fetchJson(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!body?.order) {
    throw new Error(
      "Shopify response did not contain an order"
    );
  }

  return body.order;
}
