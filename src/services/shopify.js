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

// ---------------------------------------------------------------------------
// Order intake (replaces Make 6.1.2)
// ---------------------------------------------------------------------------

function intakeBase(storeUrl, accessToken) {
  const baseUrl = normalizeStoreUrl(storeUrl);
  assertShopifyCredentials({ baseUrl, accessToken });
  return baseUrl;
}

// Full orders (with line_items) for the intake. `query` holds the same
// filters the Make scenario put on orders.json; pages are followed, where
// Make stopped at 250.
export async function listIntakeOrders({
  storeUrl,
  accessToken,
  apiVersion,
  query,
}) {
  const baseUrl = intakeBase(storeUrl, accessToken);
  const params = new URLSearchParams({ limit: "250", ...query });

  let nextUrl =
    `${baseUrl}/admin/api/${apiVersion}/orders.json?${params}`;

  const orders = [];

  while (nextUrl) {
    const page = await shopifyRequestWithHeaders({
      url: nextUrl,
      accessToken,
    });

    if (!Array.isArray(page.body?.orders)) {
      throw new Error("Shopify response did not contain an orders array");
    }

    orders.push(...page.body.orders);
    nextUrl = getNextPageUrl(page.headers.get("link"));
  }

  return orders;
}

export async function getShopifyVariant({
  storeUrl,
  accessToken,
  apiVersion,
  variantId,
}) {
  const baseUrl = intakeBase(storeUrl, accessToken);
  const { body } = await shopifyRequestWithHeaders({
    url: `${baseUrl}/admin/api/${apiVersion}/variants/${encodeURIComponent(String(variantId))}.json`,
    accessToken,
  });
  return body?.variant || null;
}

export async function getShopifyProduct({
  storeUrl,
  accessToken,
  apiVersion,
  productId,
}) {
  const baseUrl = intakeBase(storeUrl, accessToken);
  const { body } = await shopifyRequestWithHeaders({
    url: `${baseUrl}/admin/api/${apiVersion}/products/${encodeURIComponent(String(productId))}.json`,
    accessToken,
  });
  return body?.product || null;
}

// "available" of one inventory item at one location; null when the item is
// not stocked (or not tracked) there, which is what Make saw as "not exist".
export async function getInventoryAvailable({
  storeUrl,
  accessToken,
  apiVersion,
  inventoryItemId,
  locationId,
}) {
  const baseUrl = intakeBase(storeUrl, accessToken);
  const params = new URLSearchParams({
    inventory_item_ids: String(inventoryItemId),
    location_ids: String(locationId),
  });
  const { body } = await shopifyRequestWithHeaders({
    url: `${baseUrl}/admin/api/${apiVersion}/inventory_levels.json?${params}`,
    accessToken,
  });
  const level = body?.inventory_levels?.[0];
  if (!level || level.available == null) {
    return null;
  }
  const available = Number(level.available);
  return Number.isFinite(available) ? available : null;
}

// Stocks the item at our location in the store's Shopify, as Make did
// before routing. Make ignored a failure here, so the caller does too.
export async function connectInventoryToLocation({
  storeUrl,
  accessToken,
  apiVersion,
  inventoryItemId,
  locationId,
}) {
  const baseUrl = intakeBase(storeUrl, accessToken);
  await shopifyRequestWithHeaders({
    url: `${baseUrl}/admin/api/${apiVersion}/inventory_levels/connect.json`,
    accessToken,
    method: "POST",
    requestBody: {
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      relocate_if_necessary: true,
    },
    maxRetries: 1,
  });
}

async function shopifyRequestWithHeaders({
  url,
  accessToken,
  method = "GET",
  requestBody,
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
        method,
        headers: {
          "X-Shopify-Access-Token":
            accessToken,
          "Content-Type":
            "application/json",
        },
        body:
          requestBody === undefined
            ? undefined
            : JSON.stringify(requestBody),
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
