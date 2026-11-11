// Order intake: new Shopify orders of the stores become an Unfulfilled
// Orders Log record (an order for us) or a Pending Intake record (the store
// may still have the pair). Replaces the Make scenarios "Phase 6.1.2: New
// Shopify Orders to Airtable (...)"; the per-store rules live in
// orderIntakeStores.js.
//
// Which stores run, per store in Merchants "Order Intake Automation":
//   Make (or empty)   the engine leaves the store alone
//   Engine (test)     reads and decides, writes nothing
//   Engine            imports (turn the store's Make scenario off first)
// ORDER_INTAKE_ENABLED=false stops the whole job.

import { config } from "../config.js";
import {
  createRecord,
  deleteRecord,
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
import { normalizeSize } from "../utils/sizes.js";
import {
  STORES,
  lineSkipReason,
  orderPaymentStatus,
} from "./orderIntakeStores.js";

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

// A shoe size as normalizeSize leaves it: "42", "42.5", "38 2/3", or a
// US/UK label. "PlayStation5 Pro Console" has a digit but is no size.
const SHOE_SIZE = /^(?:(?:US|UK)\s?)?\d{1,2}(?:\.\d|\s?\d\/\d)?$/i;

/**
 * @param {object}   options
 * @param {string}   options.source
 * @param {boolean}  options.dryRun          never write, whatever the env says
 * @param {string[]} options.stores          store keys (manual runs); default:
 *   every store set to Engine or Engine (test) in Merchants
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
  const summary = {
    source,
    mode: manualReadOnly ? (compare ? "compare" : "dry run") : "per store",
    startedAt: startedAt.toISOString(),
    stores: {},
    decisions: [],
  };

  try {
    const modes = await loadStoreModes();
    const keys = stores?.length ? stores : [...modes.keys()];

    for (const key of keys) {
      const store = STORES[key];

      if (!store) {
        summary.stores[key] = { error: modes.unknown?.[key] || "unknown store key" };
        continue;
      }

      const mode = modes.get(key) || "Make";
      const write = !manualReadOnly && mode === "Engine";

      try {
        summary.stores[key] = { mode, ...(await runStore({
          key,
          store,
          write,
          compare,
          lookbackMinutes,
          decisions: summary.decisions,
        })) };
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
  // Test stores keep their decisions so /health shows what would happen.
  if (source === "scheduler") {
    summary.decisions = summary.decisions.filter(
      d => summary.stores[d.store]?.mode !== "Engine"
    );
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

  const merchantRecord = await getRecord(
    config.mainBaseId,
    config.merchantsTableId,
    store.merchantId
  );
  const m = merchantRecord?.fields || {};

  if (store.requireLocationSync && !m["Location Sync"]) {
    return { ...stats, skipped: "Location Sync is off" };
  }

  // Merchants "Pending Intake Skip Keywords" count for the intake too: a
  // store whose orders go straight to UOL never reaches the Pending Intake
  // queue, where that field used to do its work (Madonnina: Fear of God).
  const settings = {
    ...store,
    excludeWords: [
      ...store.excludeWords,
      ...String(m["Pending Intake Skip Keywords"] || "")
        .split(/[\r\n,]+/)
        .map((w) => w.trim())
        .filter(Boolean),
    ],
  };

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

  // Orders only come in between 07:00 and midnight (Amsterdam). At night
  // nobody looks, and a UOL record starts its clocks the moment it exists:
  // the Quick Deal payout climbs from Outsource Start Time, and a store's
  // Order Hold Hours (Select) would run out before the store can cancel.
  // The runs in the 07:00 hour look back far enough to pick up the night.
  if (!lookbackMinutes && !withinHours(DAY_HOURS)) {
    return { ...stats, skipped: "night: picked up from 07:00" };
  }

  const minutes =
    lookbackMinutes ||
    (amsterdamHour() === DAY_HOURS.from
      ? Math.max(store.lookbackMinutes, NIGHT_LOOKBACK_MINUTES)
      : store.lookbackMinutes);
  const updatedAtMin = new Date(Date.now() - minutes * 60000).toISOString();

  // 1. Candidate lines, through the store's settings.
  const candidates = [];

  const orders = await listIntakeOrders({
    ...shop,
    query: { financial_status: "any", updated_at_min: updatedAtMin },
  });

  stats.orders += orders.length;

  for (const order of orders) {
    const paymentStatus = orderPaymentStatus(store, order);

    for (const line of order.line_items || []) {
      stats.lines += 1;

      if (!paymentStatus || lineSkipReason(settings, line)) {
        stats.filteredOut += 1;
        continue;
      }

      candidates.push({ order, line, paymentStatus });
    }
  }

  if (!candidates.length) {
    return stats;
  }

  // 2. What already exists, in two queries instead of two per line.
  const existing = await loadExisting(
    [...new Set(candidates.map(c => String(c.order.id)))]
  );

  const rate =
    store.currency && store.currency !== "EUR" ? await eurRate(store.currency) : 1;
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
        price: decision?.price ?? null,
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

  // The listing holds the size as the Active Products sync read it; without
  // a listing the same reader runs on the variant title.
  const size = String(
    (listing?.size || normalizeSize(line.variant_title)) ?? ""
  ).trim();

  if (!size) {
    return { target: null, reason: "no size", size: null };
  }

  if (store.shoesOnly && !SHOE_SIZE.test(size)) {
    return { target: null, reason: `not a shoe size: ${size}`, size };
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

  // Only a store that keeps stock in Shopify and has no auto accept needs the
  // check; every other line is an order for us.
  if (store.stockCheck) {
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

  const target =
    store.stockCheck &&
    store.stockCheck.ownLocations.includes(assigned) &&
    available != null &&
    available >= 0
      ? "pending"
      : "uol";

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

  const withPicture = p.picture
    ? { ...fields, [f.picture]: [{ url: p.picture }] }
    : fields;

  try {
    await createWithoutDuplicate(tableId, withPicture, order.id, line.variant_id);
  } catch (error) {
    // Make's fallback: a picture URL Airtable refuses should not cost the order.
    if (!p.picture || !isRefusal(error)) throw error;
    await createWithoutDuplicate(tableId, fields, order.id, line.variant_id);
  }
}

// Airtable answered and said no: the record was not created.
function isRefusal(error) {
  return Boolean(error?.status) && error.status < 500 && error.status !== 408 && error.status !== 429;
}

// Create once. When the outcome is unknown (timeout, 5xx, 429) the record
// may exist anyway - 11-11 a request that timed out had already written the
// record and the blind retry made a second one - so look before trying again.
async function createWithoutDuplicate(tableId, fields, orderId, variantId) {
  const once = () =>
    createRecord(config.mainBaseId, tableId, fields, { retries: 0, timeoutMs: 60000 });

  const formula =
    `AND({Shopify Order ID}='${escapeFormulaString(String(orderId))}',` +
    `{Shopify Variant ID}='${escapeFormulaString(String(variantId))}')`;
  const findAll = () =>
    listRecords(config.mainBaseId, tableId, { formula, fields: ["Shopify Order ID"] });

  let created;

  try {
    created = await once();
  } catch (error) {
    if (isRefusal(error)) throw error;
    console.warn("[order-intake] create outcome unknown, checking", error.message);

    await new Promise(resolve => setTimeout(resolve, 5000));
    if ((await findAll()).length) return;
    created = await once();
  }

  await keepOnlyOldest(tableId, created?.id, findAll);
}

// Last line of defence when two engine instances ran at once (a deploy):
// each looks again shortly after creating, and an instance whose record is
// not the oldest of the copies deletes its own. It never touches a record it
// did not make, so of N copies exactly the oldest survives.
async function keepOnlyOldest(tableId, ownId, findAll) {
  if (!ownId) return;
  await new Promise(resolve => setTimeout(resolve, 4000));

  const copies = await findAll();
  if (copies.length < 2) return;

  copies.sort((a, b) =>
    String(a.createdTime).localeCompare(String(b.createdTime)) ||
    String(a.id).localeCompare(String(b.id))
  );

  if (copies[0].id !== ownId && copies.some(c => c.id === ownId)) {
    console.warn("[order-intake] duplicate of", copies[0].id, "- deleting own copy", ownId);
    await deleteRecord(config.mainBaseId, tableId, ownId);
  }
}

const DAY_HOURS = { from: 7, to: 24 };
const NIGHT_LOOKBACK_MINUTES = 565;

function amsterdamHour() {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Europe/Amsterdam",
    }).format(new Date())
  );
}

function withinHours({ from, to }) {
  const hour = amsterdamHour();
  return hour >= from && hour < to;
}

const STORE_KEY_BY_MERCHANT = new Map(
  Object.entries(STORES).map(([key, store]) => [store.merchantId, key])
);

// Store key -> "Engine" / "Engine (test)", from Merchants.
async function loadStoreModes() {
  const records = await listRecords(config.mainBaseId, config.merchantsTableId, {
    formula:
      "OR({Order Intake Automation}='Engine',{Order Intake Automation}='Engine (test)')",
    fields: ["Store Name", "Order Intake Automation"],
  });

  const modes = new Map();
  modes.unknown = {};

  for (const record of records) {
    const key = STORE_KEY_BY_MERCHANT.get(record.id);
    const mode = record.fields["Order Intake Automation"];

    if (key) {
      modes.set(key, mode);
    } else {
      // Set in Merchants but no intake settings for it in the code yet.
      const name = record.fields["Store Name"] || record.id;
      modes.set(name, mode);
      modes.unknown[name] = "no intake settings for this store yet";
    }
  }

  return modes;
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

