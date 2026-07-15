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

export async function listShopifyOrdersUpdatedSince({
  storeUrl,
  accessToken,
  apiVersion,
  updatedAtMin,
}) {
  const baseUrl = normalizeStoreUrl(storeUrl);

  assertShopifyCredentials({
    baseUrl,
    accessToken,
  });

  const params = new URLSearchParams({
    status: "any",
    updated_at_min: updatedAtMin,
    fields:
      "id,name,order_number,fulfillment_status,closed_at,cancelled_at,updated_at",
    limit: "250",
    order: "updated_at asc",
  });

  let nextUrl =
    `${baseUrl}/admin/api/${apiVersion}/orders.json?` +
    params.toString();

  const allOrders = [];

  while (nextUrl) {
    const page = await shopifyRequestWithHeaders({
      url: nextUrl,
      accessToken,
    });

    const orders = page.body?.orders;

    if (!Array.isArray(orders)) {
      throw new Error(
        "Shopify response did not contain an orders array"
      );
    }

    allOrders.push(...orders);

    nextUrl = getNextPageUrl(
      page.headers.get("link")
    );
  }

  return allOrders;
}

export async function getShopifyFulfillmentOrders({
  storeUrl,
  accessToken,
  orderId,
  apiVersion,
}) {
  const baseUrl = normalizeStoreUrl(storeUrl);

  assertShopifyCredentials({
    baseUrl,
    accessToken,
  });

  if (!orderId) {
    throw new Error(
      "Missing Shopify Order ID for fulfillment order lookup"
    );
  }

  const url =
    `${baseUrl}/admin/api/${apiVersion}/orders/` +
    `${encodeURIComponent(String(orderId))}/` +
    "fulfillment_orders.json";

  const response = await shopifyRequestWithHeaders({
    url,
    accessToken,
  });

  const fulfillmentOrders =
    response.body?.fulfillment_orders;

  if (!Array.isArray(fulfillmentOrders)) {
    throw new Error(
      "Shopify response did not contain fulfillment_orders"
    );
  }

  return fulfillmentOrders;
}

function normalizeStoreUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function assertShopifyCredentials({
  baseUrl,
  accessToken,
}) {
  if (!baseUrl) {
    throw new Error(
      "Merchant is missing Shopify Store URL"
    );
  }

  if (!accessToken) {
    throw new Error(
      "Merchant is missing Shopify Token"
    );
  }
}

async function shopifyRequestWithHeaders({
  url,
  accessToken,
  maxRetries = 4,
}) {
  let lastError;

  for (
    let attempt = 0;
    attempt <= maxRetries;
    attempt += 1
  ) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Shopify-Access-Token":
            accessToken,
          "Content-Type":
            "application/json",
        },
      });

      const text = await response.text();

      let body = null;

      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = {
            raw: text,
          };
        }
      }

      if (response.ok) {
        return {
          body,
          headers: response.headers,
        };
      }

      const error = new Error(
        `Shopify HTTP ${response.status}`
      );

      error.status = response.status;
      error.body = body;
      error.headers = response.headers;

      throw error;
    } catch (error) {
      lastError = error;

      const retryable =
        error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504 ||
        error.name === "TypeError";

      if (
        !retryable ||
        attempt === maxRetries
      ) {
        throw error;
      }

      const retryAfterSeconds = Number(
        error.headers?.get?.("retry-after")
      );

      const waitMs =
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : Math.min(
              10000,
              1000 * 2 ** attempt
            );

      console.warn(
        `[shopify] request failed; retrying in ${waitMs}ms`,
        {
          status: error.status,
          attempt:
            `${attempt + 1}/${maxRetries}`,
          url,
        }
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const links = String(linkHeader).split(",");

  for (const link of links) {
    const match = link.match(
      /<([^>]+)>;\s*rel="([^"]+)"/
    );

    if (
      match &&
      match[2] === "next"
    ) {
      return match[1];
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}
