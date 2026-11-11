// Per-store settings of the order intake.
//
// Every store has the same handful of settings, so they can move to a
// settings page later without code:
//
//   minPrice            a line must cost more than this, in the store's own
//                       currency (PLN for APLUG, RON for Sosu)
//   currency            converted to euro for Airtable; default EUR
//   excludeWords        a line is skipped when its product name or variant
//                       title contains one of these (case does not matter).
//                       Variant words mark stock the store ships itself:
//                       APLUG "48H"/"72H", SNEAKEREGEER "⚡".
//   excludeSkus         a line is skipped when its SKU contains one of these
//   shoesOnly           skip lines whose size has no number (clothing)
//   excludeOrderTags    skip whole orders carrying one of these tags
//   excludeRoundPrices  skip lines priced at a whole amount (SneakerAsk)
//   paidOnly            only paid orders, plus cash on delivery
//   stockCheck          null: every line is an order for us (UOL).
//                       { ownLocations }: when Shopify assigned the line to
//                       one of these locations and the store still has stock
//                       there, the store looks first (Pending Intake).
//   connectInventory    stock the item at our location in their Shopify,
//                       so "Move to our location" can work later
//   skuSource           only for lines without a store listing: "product"
//                       takes the product's SKU (variant SKUs of these
//                       stores carry the size), "line" the line's own SKU
//
// Size and SKU come from the store listing; without one, the size is read
// with normalizeSize (the same reader as the Active Products sync) and the
// product is matched through Retailed.

const defaults = {
  minPrice: 50,
  currency: "EUR",
  excludeWords: [],
  excludeSkus: [],
  shoesOnly: false,
  excludeOrderTags: [],
  excludeRoundPrices: false,
  paidOnly: false,
  stockCheck: null,
  connectInventory: true,
  skuSource: "product",
  requireLocationSync: true,
  lookbackMinutes: 145,
};

const store = settings => ({ ...defaults, ...settings });

export const STORES = {
  goldenbean: store({
    merchantId: "recUCsNjUkAbw0QuC",
    name: "The Golden Bean Coffee & Kicks",
    minPrice: 0,
    excludeOrderTags: ["FLOWSTOCK"],
  }),

  fastcop: store({
    merchantId: "recnfpGr6MrJbEvwX",
    name: "FastCop Store",
    minPrice: 0,
    excludeOrderTags: ["FLOWSTOCK"],
  }),

  sneakeregeer: store({
    merchantId: "rechUAQ4tLIp19QV9",
    name: "SNEAKEREGEER",
    excludeWords: ["cadeaubon", "giftcard", "⚡"],
    excludeOrderTags: ["FLOWSTOCK"],
  }),

  aplug: store({
    merchantId: "recj8Fr1aP7q3ks3J",
    name: "APLUG.PL",
    minPrice: 215,
    currency: "PLN",
    excludeWords: ["cadeaubon", "giftcard", "Fear of God", "Pop Mart", "48H", "72H"],
    shoesOnly: true,
    skuSource: "line",
  }),

  genky: store({
    merchantId: "recNqfgpqHFppbkeT",
    name: "Genky Sneakers",
    excludeWords: ["cadeaubon", "giftcard", "Fear of God", "Pop Mart"],
    shoesOnly: true,
  }),

  mentastore: store({
    merchantId: "recmfT0GbMwQEQsJw",
    name: "Mentastore V.O.F.",
    excludeWords: ["cadeaubon", "giftcard", "Fear of God", "Pop Mart"],
    shoesOnly: true,
  }),

  madonnina: store({
    merchantId: "recYPJ2d0pqJhrElT",
    name: "Madonnina Resell",
    minPrice: 0,
    excludeWords: ["Labubu", "Custom", "Crep Protect"],
    excludeSkus: ["U9060ERC"],
    paidOnly: true,
  }),

  selectstore: store({
    merchantId: "recHzP1hUrh92w6s0",
    name: "ALC SELECT STORE SL",
    excludeWords: ["giftcard", "Fear of God"],
    excludeOrderTags: ["FLOWSTOCK"],
  }),

  sosu: store({
    merchantId: "recEFkQdnjaVzOTO6",
    name: "SOSU KICKS S.R.L.",
    minPrice: 250,
    currency: "RON",
    excludeWords: ["cadeaubon", "giftcard", "Fear of God", "Pop Mart", "adidas XLG"],
    excludeSkus: ["yzy-ys-01"],
    skuSource: "line",
    stockCheck: { ownLocations: ["67834773642"] },
  }),

  sneakerask: store({
    merchantId: "recsG470xt53Vy8KF",
    name: "SneakerAsk",
    excludeWords: ["Fear Of God", "Maison Mihara", "Custom"],
    excludeRoundPrices: true,
    shoesOnly: true,
    connectInventory: false,
  }),
};

const contains = (text, part) =>
  String(text ?? "").toLowerCase().includes(String(part).toLowerCase());

// Why a line is skipped, or null when it counts.
export function lineSkipReason(settings, line) {
  const price = Number(line.price);

  if (!(price > settings.minPrice)) return "below minimum price";

  if (settings.excludeRoundPrices && Number.isInteger(price)) {
    return "whole-amount price";
  }

  if (String(line.fulfillment_status ?? "").toLowerCase() === "fulfilled") {
    return "already fulfilled";
  }

  const word = settings.excludeWords.find(
    w => contains(line.name, w) || contains(line.variant_title, w)
  );
  if (word) return `excluded word "${word}"`;

  const sku = settings.excludeSkus.find(s => contains(line.sku, s));
  if (sku) return `excluded SKU "${sku}"`;

  return null;
}

const COD_GATEWAYS = ["pagamento alla consegna", "cash on delivery"];

// "Paid", "Cash On Delivery", or null when the order is skipped.
export function orderPaymentStatus(settings, order) {
  const tags = String(order.tags ?? "");
  if (settings.excludeOrderTags.some(tag => tags.includes(tag))) return null;

  const cod = (order.payment_gateway_names || []).some(name =>
    COD_GATEWAYS.includes(String(name).toLowerCase())
  );

  if (cod && order.financial_status !== "paid") return "Cash On Delivery";
  if (settings.paidOnly && order.financial_status !== "paid") return null;
  return "Paid";
}
