// Order intake: new Shopify orders of the stores become an Unfulfilled
// Orders Log record (an order for us) or a Pending Intake record (the store
// may still have the pair). Replaces the Make scenarios "Phase 6.1.2: New
// Shopify Orders to Airtable (...)"; the per-store rules live in
// orderIntakeStores.js.
//
// Safety:
//   ORDER_INTAKE_ENABLED=false        job does nothing on the clock
//   ORDER_INTAKE_SHADOW_MODE=true     reads and decides, writes nothing
//   ORDER_INTAKE_STORES=sneakerask,…  only these stores (switch one by one,
//                                     after turning its Make scenario off)

import { config } from "../config.js";
import {
  createRecord,
  getRecord,
  listRecords,
} from "../services/airtable.js";
import {
  connectInventoryToLocation,
  getInventoryAvailable,
  getShopifyFulfillmentOrders,
  getShopifyProduct,
  getShopifyVariant,
  listIntakeOrders,
} from "../services/shopify.js";
import { findStoreListing } from "../services/supabase.js";
import { searchStockxFirst } from "../services/retailed.js";
import { escapeFormulaString } from "../utils/http.js";
import { STORES } from "./orderIntakeStores.js";

let running = false;

const UOL = {
  size: "fld4EK5IUQuE9JRUR",
  brand: "fld5Mgi6qLvztiTbe",
  orderNumber: "fld66by2b61AL1riV",
  productId: "fld9i081GjElO3tcw",
  fulfillmentStatus: "fldFuzoNdPUXhL1hC",
  paymentStatus: "fldGocZz5iiUI5tfa",
  orderDate: "fldHD8PP8aaXVJnxW",
  quantity: "fldMLPYnjolidAV0h",
  productName: "fldQjEfTPRIgl2IQ6",
  orderId: "fldSLzIKVlbAA3oz9",
  orderSource: "fldcdx8iqfqbI5ICB",
  risk: "fldgwIGmRHz8tmRFC",
  sku: "fldiHiufptaUhyfKc",
  picture: "fldoPipK0LavsYYrP",
  variantId: "fldruCZdOnJUlhmcV",
  shopifyProductName: "fldsGdXMRXV6CPJm0",
  client: "fldtFYYuutWDgbWRv",
  price: "flduclYxpxKgYXRot",
};

const PENDING = {
  risk: "fld0s0D0Oa6XcP0p2",
  fulfillmentStatus: "fld3EW8HqpNx4p0RX",
  paymentStatus: "fld4yzJtiSbuvJsPv",
  orderDate: "fld5NvzJlK3xInm7h",
  orderSource: "fldAnUScDPjLvJHcW",
  orderNumber: "fldMKfxojM1qbGKmG",
  variantId: "fldPEZJ71XCu8VlMg",
  shopifyProductName: "fldQQAHG4xOGptIWl",
  client: "fldRPlIoH3Pd3PVrQ",
  productName: "fldSQ0QAoUmlNXEDp",
  quantity: "fldaVcIhwYeS0eUAC",
  notes: "flddouB9FbTv0hfxG",
  orderId: "fldgVWsE8V4anHn9u",
  price: "fldj79xEYra3GvJAM",
  picture: "fldjgS5bWTipvUOSx",
  sku: "fldsLufWfXCbwZlm2",
  size: "fldsO7PC7qneWnQuc",
  brand: "fldty3wTwj0g4FvDD",
  productId: "fldxsnSVTTxVBHsMR",
};

const RISK_LEVELS = new Set(["Low", "Medium", "High"]);

/**
 * @param {object}   options
 * @param {string}   options.source
 * @param {boolean}  options.dryRun          never write, whatever the env says
 * @param {string[]} options.stores          store keys; default ORDER_INTAKE_STORES
 * @param {number}   options.lookbackMinutes override per-store lookback
 * @param {boolean}  options.compare         also decide lines that already
 *   exist and report what Make made of them (parity check, implies dryRun)
 */
export async function runOrderIntakeSync({
  source = "scheduler",
  dryRun = false,
  stores,
  lookbackMinutes,
  compare = false,
} = {}) {
  const manualReadOnly = dryRun || compare;

  if (!config.engineEnabled || (!config.orderIntakeEnabled && !manualReadOnly)) {
    return { skipped: true, reason: "disabled" };
  }

  if (running) {
    return { skipped: true, reason: "already running" };
  }

  running = true;
  const startedAt = new Date();
  const write = !manualReadOnly && !config.orderIntakeShadowMode;
  const keys = stores?.length ? stores : config.orderIntakeStores;

  const summary = {
    source,
    mode: write ? "live" : compare ? "compare" : "shadow",
    startedAt: startedAt.toISOString(),
    stores: {},
    decisions: [],
  };

  try {
    for (const key of keys) {
      const store = STORES[key];

      if (!store) {
        summary.stores[key] = { error: "unknown store key" };
        continue;
      }

      try {
        summary.stores[key] = await runStore({
          key,
          store,
          write,
          compare,
          lookbackMinutes,
          decisions: summary.decisions,
        });
      } catch (error) {
        console.error(`[order-intake] ${key} failed`, error);
        summary.stores[key] = { error: error.message };
      }
    }
  } finally {
    running = false;
  }

  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startedAt.getTime();

  // Keep the response small on the clock; show everything when asked.
  if (source === "scheduler" && write) {
    summary.decisions = summary.decisions.length;
  }

  return summary;
}

async function runStore({ key, store, write, compare, lookbackMinutes, decisions }) {
  const stats = {
    orders: 0,
    lines: 0,
    filteredOut: 0,
    alreadyImported: 0,
    createdUol: 0,
    createdPending: 0,
    noTarget: 0,
    errors: 0,
  };

  if (store.activeHours && !withinHours(store.activeHours)) {
    return { ...stats, skipped: "outside active hours" };
  }

  const merchantRecord = await getRecord(
    config.mainBaseId,
    config.merchantsTableId,
    store.merchantId
  );
  const m = merchantRecord?.fields || {};

  if (store.requireLocationSync && !m["Location Sync"]) {
    return { ...stats, skipped: "Location Sync is off" };
  }

  const merchant = {
    id: store.merchantId,
    name: m["Store Name"] || store.name,
    storeUrl: m["Shopify Store URL"],
    token: m["Shopify Token"],
    ourLocation: String(m["Shopify Location ID"] ?? "").trim(),
  };

  const shop = {
    storeUrl: merchant.storeUrl,
    accessToken: merchant.token,
    apiVersion: config.shopifyApiVersion,
  };

  const minutes = lookbackMinutes || store.lookbackMinutes;
  const updatedAtMin = new Date(Date.now() - minutes * 60000).toISOString();

  // 1. Candidate lines, through the same filters as Make.
  const candidates = [];

  for (const query of store.queries) {
    const { paymentStatus = "Paid", orderFilter, ...shopifyQuery } = query;
    const orders = await listIntakeOrders({
      ...shop,
      query: { ...shopifyQuery, updated_at_min: updatedAtMin },
    });

    stats.orders += orders.length;

    for (const order of orders) {
      if (store.orderFilter && !store.orderFilter(order)) continue;
      if (orderFilter && !orderFilter(order)) continue;

      for (const line of order.line_items || []) {
        stats.lines += 1;

        if (!store.lineFilter(line)) {
          stats.filteredOut += 1;
          continue;
        }

        candidates.push({ order, line, paymentStatus });
      }
    }
  }

  if (!candidates.length) {
    return stats;
  }

  // 2. What already exists, in two queries instead of two per line.
  const existing = await loadExisting(
    [...new Set(candidates.map(c => String(c.order.id)))]
  );

  const rate = store.currency ? await eurRate(store.currency) : 1;
  const fulfillmentCache = new Map();

  for (const candidate of candidates) {
    const { order, line } = candidate;
    const dedupeKey = `${order.id}|${line.variant_id}`;
    const madeBy = existing.get(dedupeKey);

    if (madeBy && !compare) {
      stats.alreadyImported += 1;
      continue;
    }

    try {
      const decision = await decideLine({
        store,
        merchant,
        shop,
        candidate,
        rate,
        fulfillmentCache,
        write,
      });

      decisions.push({
        store: key,
        order: order.name || order.order_number,
        orderId: String(order.id),
        variantId: String(line.variant_id),
        title: line.title,
        size: decision?.size ?? null,
        sku: decision?.product?.sku ?? null,
        risk: decision?.product?.risk ?? null,
        via: decision?.via ?? null,
        target: decision?.target ?? "skip",
        reason: decision?.reason,
        ...(compare ? { make: madeBy || "none" } : {}),
      });

      if (madeBy) {
        stats.alreadyImported += 1;
        continue;
      }

      if (!decision || !decision.target) {
        stats.noTarget += 1;
        continue;
      }

      if (write) {
        await createIntakeRecord({ decision, merchant, candidate });
      }

      existing.set(dedupeKey, decision.target);

      if (decision.target === "uol") stats.createdUol += 1;
      else stats.createdPending += 1;
    } catch (error) {
      stats.errors += 1;
      console.error(
        `[order-intake] ${key} order ${order.name} variant ${line.variant_id}`,
        error.message
      );
      decisions.push({
        store: key,
        order: order.name || order.order_number,
        variantId: String(line.variant_id),
        title: line.title,
        target: "error",
        reason: error.message,
      });
    }
  }

  return stats;
}

async function decideLine({ store, merchant, shop, candidate, rate, fulfillmentCache, write }) {
  const { order, line } = candidate;

  const listing = await findStoreListing({
    merchantRecordId: merchant.id,
    shopifyProductId: String(line.product_id),
    shopifyVariantId: String(line.variant_id),
  });

  // Size first: when a store's size pattern finds nothing, Make dropped the
  // line (except where a listing supplies the size).
  const size =
    store.sizeFromListing && listing ? listing.size : store.size(line);

  if (!size) {
    return { target: null, reason: "no size in variant title", size: null };
  }

  let product;
  let inventoryItemId;
  let via;

  if (listing) {
    via = "listing";
    inventoryItemId = listing.shopify_inventory_item_id;
    product = {
      name: listing.stockx_product_name,
      brand: listing.brand,
      sku: listing.sku,
      picture: listing.picture_url,
      risk: listing.match_risk_level,
      productId: listing.shopify_product_id,
      variantId: listing.shopify_variant_id,
    };
  } else {
    via = "retailed";
    const variant = await getShopifyVariant({ ...shop, variantId: line.variant_id });

    if (!variant) {
      throw new Error("Shopify variant not found");
    }

    inventoryItemId = variant.inventory_item_id;

    let sku = line.sku;
    let title = line.title;

    if (store.skuSource === "product") {
      const shopifyProduct = await getShopifyProduct({
        ...shop,
        productId: variant.product_id,
      });
      sku = shopifyProduct?.variants?.[0]?.sku;
      title = shopifyProduct?.title || line.title;
    }

    product = {
      ...(await matchViaRetailed(sku, title)),
      productId: String(line.product_id),
      variantId: String(line.variant_id),
    };
  }

  if (write && store.connectInventory && inventoryItemId && merchant.ourLocation) {
    try {
      await connectInventoryToLocation({
        ...shop,
        inventoryItemId,
        locationId: merchant.ourLocation,
      });
    } catch (error) {
      // Make resumed past this one as well.
      console.warn("[order-intake] connect inventory failed", error.message);
    }
  }

  let assigned = "";
  let available = null;

  if (store.needsLocation !== false) {
    const orderKey = String(order.id);

    if (!fulfillmentCache.has(orderKey)) {
      fulfillmentCache.set(
        orderKey,
        await getShopifyFulfillmentOrders({ ...shop, orderId: order.id })
      );
    }

    const fulfillmentOrders = fulfillmentCache.get(orderKey);
    const forLine =
      fulfillmentOrders.find(fo =>
        (fo.line_items || []).some(li => String(li.line_item_id) === String(line.id))
      ) || fulfillmentOrders[0];

    assigned = String(forLine?.assigned_location_id ?? "");

    if (assigned && inventoryItemId) {
      available = await getInventoryAvailable({
        ...shop,
        inventoryItemId,
        locationId: assigned,
      });
    }
  }

  const target = store.route({
    assigned,
    ourLocation: merchant.ourLocation,
    available,
  });

  return {
    target,
    reason: `assigned=${assigned || "-"} ours=${merchant.ourLocation} available=${available ?? "n/a"}`,
    via,
    size: String(size).trim(),
    product,
    price: Math.round(Number(line.price) * rate * 100) / 100,
    paymentStatus: candidate.paymentStatus,
  };
}

// The Retailed branch of Make: match on the SKU when the first StockX hit
// carries that SKU, otherwise take the first hit for the product title.
// Nothing found means a High risk line without product details.
async function matchViaRetailed(sku, title) {
  const cleanSku = String(sku ?? "").trim();

  if (cleanSku) {
    const bySku = await searchStockxFirst(cleanSku);

    if (bySku && sameSku(bySku.sku, cleanSku)) {
      return fromHit(bySku, cleanSku);
    }

    const byTitle = await searchStockxFirst(title);
    return byTitle ? fromHit(byTitle, cleanSku) : { sku: cleanSku, risk: "High" };
  }

  const byTitle = await searchStockxFirst(title);
  return byTitle ? fromHit(byTitle, byTitle.sku) : { risk: "High" };
}

function fromHit(hit, sku) {
  return {
    name: [hit.name, hit.colorway].filter(Boolean).join(" ").trim(),
    brand: hit.brand,
    sku,
    picture: hit.image,
    risk: null,
  };
}

function sameSku(a, b) {
  return String(a ?? "").trim().toUpperCase() === String(b ?? "").trim().toUpperCase();
}

async function createIntakeRecord({ decision, merchant, candidate }) {
  const { order, line } = candidate;
  const f = decision.target === "uol" ? UOL : PENDING;
  const p = decision.product;

  const fields = {
    [f.orderNumber]: String(order.order_number),
    [f.orderId]: String(order.id),
    [f.productId]: String(p.productId ?? line.product_id),
    [f.variantId]: String(p.variantId ?? line.variant_id),
    [f.shopifyProductName]: line.title,
    [f.orderDate]: order.created_at,
    [f.quantity]: Number(line.fulfillable_quantity ?? line.quantity),
    [f.price]: decision.price,
    [f.size]: decision.size,
    [f.fulfillmentStatus]: "Pending",
    [f.paymentStatus]: decision.paymentStatus,
    [f.orderSource]: "Shopify",
    [f.client]: [merchant.id],
  };

  if (p.name) fields[f.productName] = p.name;
  if (p.brand) fields[f.brand] = p.brand;
  if (p.sku) fields[f.sku] = p.sku;
  if (RISK_LEVELS.has(p.risk)) fields[f.risk] = p.risk;
  if (decision.target === "pending") fields[f.notes] = "Store might have stock";

  const tableId =
    decision.target === "uol" ? config.uolTableId : config.pendingIntakeTableId;

  try {
    await createRecord(config.mainBaseId, tableId, {
      ...fields,
      ...(p.picture ? { [f.picture]: [{ url: p.picture }] } : {}),
    });
  } catch (error) {
    // Make's fallback: a picture URL Airtable refuses should not cost the order.
    if (!p.picture) throw error;
    await createRecord(config.mainBaseId, tableId, fields);
  }
}

async function loadExisting(orderIds) {
  const existing = new Map();

  for (let i = 0; i < orderIds.length; i += 40) {
    const chunk = orderIds.slice(i, i + 40);
    const formula =
      "OR(" +
      chunk.map(id => `{Shopify Order ID}='${escapeFormulaString(id)}'`).join(",") +
      ")";

    for (const [tableId, label] of [
      [config.uolTableId, "uol"],
      [config.pendingIntakeTableId, "pending"],
    ]) {
      const records = await listRecords(config.mainBaseId, tableId, {
        formula,
        fields: ["Shopify Order ID", "Shopify Variant ID"],
      });

      for (const record of records) {
        const key =
          `${record.fields["Shopify Order ID"]}|${record.fields["Shopify Variant ID"]}`;
        if (!existing.has(key)) existing.set(key, label);
      }
    }
  }

  return existing;
}

const rateCache = new Map();

// Make converted PLN and RON with its currency module; ECB rates via
// Frankfurter do the same here, cached for an hour.
async function eurRate(currency) {
  const cached = rateCache.get(currency);

  if (cached && Date.now() - cached.at < 3600000) {
    return cached.rate;
  }

  const response = await fetch(
    `https://api.frankfurter.app/latest?from=${currency}&to=EUR`,
    { signal: AbortSignal.timeout(15000) }
  );

  if (!response.ok) {
    throw new Error(`Exchange rate ${currency}->EUR: HTTP ${response.status}`);
  }

  const rate = Number((await response.json())?.rates?.EUR);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Exchange rate ${currency}->EUR missing`);
  }

  rateCache.set(currency, { rate, at: Date.now() });
  return rate;
}

function withinHours({ from, to }) {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Europe/Amsterdam",
    }).format(new Date())
  );
  return hour >= from && hour < to;
}
