// Per-store rules of the order intake, taken from the Make scenarios
// "Phase 6.1.2: New Shopify Orders to Airtable (...)".
//
// Every store answers the same questions:
//   - which Shopify orders to read (query, lookback),
//   - which line items count (lineFilter),
//   - what the size is,
//   - where the line goes: an order for us (UOL) or a Pending Intake that the
//     store gets to look at first (route).
//
// Text checks follow Make: "contains" is case-sensitive unless Make had the
// ":ci" variant, which uses ci() here.

const has = (text, part) => String(text ?? "").includes(part);
const ci = (text, part) =>
  String(text ?? "").toLowerCase().includes(String(part).toLowerCase());
const price = line => Number(line.price);
const notFulfilled = line =>
  String(line.fulfillment_status ?? "").toLowerCase() !== "fulfilled";
const neverFulfilled = line => line.fulfillment_status == null;
const noFlowstock = order => !has(order.tags, "FLOWSTOCK");

// Size patterns. A size the pattern cannot find stopped the line in Make
// (the regex module had "continue when no result" off).
const SIZE_NUMBER_BEFORE_SYSTEM =
  /\b(\d{1,2}(?:[.,]\d+|\s+(?:1\/2|1\/3|2\/3|1\/4|3\/4)|\s*[½⅓⅔¼¾])?)\W*(?:EU|US|UK|JP|CN|FR|IT|RU)\b/i;
const SIZE_SYSTEM_BEFORE_NUMBER =
  /\b(?:EU|US|UK|JP|CN|FR|IT|RU)\W*(\d{1,2}(?:[.,]\d+|\s+(?:1\/2|1\/3|2\/3|1\/4|3\/4)|\s*[½⅓⅔¼¾])?)\b/i;

const variantTitle = line =>
  String(line.variant_title ?? "").replace(/⚡/g, "").trim();

function regexSize(pattern) {
  return line => {
    const match = String(line.variant_title ?? "").match(pattern);
    return match ? match[1] : null;
  };
}

// Location routing shared by most stores (Make routes 1-4):
//   assigned to us (or to a location that counts as ours) -> UOL
//   store has stock at the assigned location (>= 0)        -> Pending Intake
//   store sold below zero there (< 0)                       -> UOL, or only
//     when the location is in `negativeOnlyAt` (other locations: nothing)
//   not stocked / not tracked there                         -> `untracked`
// null means: create nothing, as Make did when no route matched.
function locationRoute({ ownLocations = [], negativeOnlyAt = null, untracked }) {
  return ({ assigned, ourLocation, available }) => {
    if (assigned && (assigned === ourLocation || ownLocations.includes(assigned))) {
      return "uol";
    }
    if (available == null) return untracked;
    if (available >= 0) return "pending";
    if (negativeOnlyAt && !negativeOnlyAt.includes(assigned)) return null;
    return "uol";
  };
}

const always = target => () => target;

// The main 6.1.2 scenario (no store suffix) served these four, each with its
// own line filter.
const mainScenario = {
  scenario: "Phase 6.1.2 (main)",
  requireLocationSync: true,
  queries: [{ financial_status: "any" }],
  lookbackMinutes: 145,
  orderFilter: noFlowstock,
  size: variantTitle,
  sizeFromListing: false,
  skuSource: "product",
  connectInventory: true,
  route: locationRoute({ untracked: "pending" }),
};

export const STORES = {
  snrkickz: {
    ...mainScenario,
    merchantId: "rec06TCmWGe4A9cPk",
    name: "Snrkickz",
    lineFilter: line =>
      price(line) > 50 &&
      !has(line.name, "cadeaubon") &&
      !has(line.name, "giftcard") &&
      !has(line.name, "Maison Mihara") &&
      !has(line.name, "Fear of God") &&
      !has(line.name, "Labubu") &&
      !has(line.name, "LABUBU") &&
      !has(line.name, "Vans") &&
      notFulfilled(line),
  },

  goldenbean: {
    ...mainScenario,
    merchantId: "recUCsNjUkAbw0QuC",
    name: "The Golden Bean Coffee & Kicks",
    lineFilter: notFulfilled,
  },

  fastcop: {
    ...mainScenario,
    merchantId: "recnfpGr6MrJbEvwX",
    name: "FastCop Store",
    lineFilter: notFulfilled,
  },

  sneakeregeer: {
    ...mainScenario,
    merchantId: "rechUAQ4tLIp19QV9",
    name: "SNEAKEREGEER",
    lineFilter: line =>
      price(line) > 50 &&
      !has(line.name, "cadeaubon") &&
      !has(line.name, "giftcard") &&
      notFulfilled(line) &&
      !has(line.variant_title, "⚡"),
    // In Make every SNEAKEREGEER line ended up as an order for us.
    route: always("uol"),
  },

  aplug: {
    scenario: "Phase 6.1.2 (APLUG)",
    merchantId: "recj8Fr1aP7q3ks3J",
    name: "APLUG.PL",
    queries: [{ financial_status: "any" }],
    lookbackMinutes: 145,
    currency: "PLN",
    lineFilter: line =>
      price(line) > 215 &&
      !has(line.name, "cadeaubon") &&
      !has(line.name, "giftcard") &&
      !has(line.name, "Fear of God") &&
      !has(line.name, "Pop Mart") &&
      ci(line.variant_title, "EU") &&
      !ci(line.variant_title, "48H") &&
      !ci(line.variant_title, "72H"),
    size: regexSize(/^(.*?) EU/),
    sizeFromListing: true,
    skuSource: "line",
    connectInventory: true,
    route: locationRoute({ untracked: "uol" }),
  },

  genky: {
    scenario: "Phase 6.1.2 (Genky)",
    merchantId: "recNqfgpqHFppbkeT",
    name: "Genky Sneakers",
    queries: [{ financial_status: "any" }],
    lookbackMinutes: 145,
    lineFilter: line =>
      price(line) > 50 &&
      !has(line.name, "cadeaubon") &&
      !has(line.name, "giftcard") &&
      !has(line.name, "Fear of God") &&
      !has(line.name, "Pop Mart"),
    size: regexSize(SIZE_SYSTEM_BEFORE_NUMBER),
    sizeFromListing: false,
    skuSource: "product",
    connectInventory: true,
    // Only a shortage at their own shop (81892147542) comes to us; a
    // shortage at Turum B2B or Wallysneakers is theirs to source.
    route: locationRoute({
      ownLocations: ["100810326358"],
      negativeOnlyAt: ["81892147542"],
      untracked: null,
    }),
  },

  mentastore: {
    scenario: "Phase 6.1.2 (Mentastore)",
    merchantId: "recmfT0GbMwQEQsJw",
    name: "Mentastore V.O.F.",
    queries: [{ financial_status: "any", fulfillment_status: "unfulfilled" }],
    lookbackMinutes: 145,
    lineFilter: line =>
      price(line) > 50 &&
      !has(line.name, "cadeaubon") &&
      !has(line.name, "giftcard") &&
      !has(line.name, "Fear of God") &&
      !has(line.name, "Pop Mart"),
    size: regexSize(SIZE_SYSTEM_BEFORE_NUMBER),
    sizeFromListing: false,
    skuSource: "product",
    connectInventory: true,
    // Only a shortage at the Heuvelstraat shop (83579830614) comes to us.
    // "Mentastore Magazijn" runs their own pre-orders below zero and the
    // "sell portal" location ships nothing itself; Make never imported a
    // shortage there (its filter compared location IDs as numbers).
    route: locationRoute({
      ownLocations: ["98526134614"],
      negativeOnlyAt: ["83579830614"],
      untracked: null,
    }),
  },

  madonnina: {
    scenario: "Phase 6.1.2 (Madonnina)",
    merchantId: "recYPJ2d0pqJhrElT",
    name: "Madonnina Resell",
    requireLocationSync: true,
    // Cash-on-delivery orders are still "pending" at Shopify; Make read those
    // separately and marked them Cash On Delivery.
    queries: [
      {
        financial_status: "pending",
        paymentStatus: "Cash On Delivery",
        orderFilter: order =>
          (order.payment_gateway_names || []).includes("Pagamento alla consegna"),
      },
      { financial_status: "paid", paymentStatus: "Paid" },
    ],
    lookbackMinutes: 145,
    lineFilter: line =>
      !has(line.name, "LABUBU") &&
      !has(line.name, "Labubu") &&
      !has(line.name, "Custom") &&
      neverFulfilled(line) &&
      !has(line.name, "Crep Protect") &&
      !ci(line.sku, "U9060ERC"),
    size: variantTitle,
    sizeFromListing: false,
    skuSource: "product",
    connectInventory: true,
    route: always("pending"),
  },

  selectstore: {
    scenario: "Phase 6.1.2 (Select Store Day)",
    merchantId: "recHzP1hUrh92w6s0",
    name: "ALC SELECT STORE SL",
    requireLocationSync: true,
    queries: [{ financial_status: "any" }],
    lookbackMinutes: 565,
    // Make only ran this one between 07:00 and midnight.
    activeHours: { from: 7, to: 24 },
    orderFilter: noFlowstock,
    lineFilter: line =>
      price(line) > 50 &&
      !ci(line.name, "giftcard") &&
      !ci(line.name, "Fear of God") &&
      neverFulfilled(line),
    size: variantTitle,
    sizeFromListing: true,
    skuSource: "product",
    connectInventory: true,
    route: always("uol"),
  },

  sosu: {
    scenario: "Phase 6.1.2 (Sosu Kicks)",
    merchantId: "recEFkQdnjaVzOTO6",
    name: "SOSU KICKS S.R.L.",
    queries: [{ financial_status: "any" }],
    lookbackMinutes: 145,
    currency: "RON",
    lineFilter: line =>
      price(line) > 250 &&
      !has(line.name, "cadeaubon") &&
      !ci(line.name, "giftcard") &&
      !ci(line.name, "Fear of God") &&
      !has(line.name, "Pop Mart") &&
      notFulfilled(line) &&
      ci(line.name, "adidas XLG") &&
      !ci(line.sku, "yzy-ys-01"),
    size: line =>
      String(line.variant_title ?? "").match(/^\s*(.+?)\s*EU\b/)?.[1] ||
      line.variant_title,
    sizeFromListing: true,
    skuSource: "line",
    connectInventory: true,
    // Only their warehouse 67834773642 can hold the pair for the store;
    // anything else comes to us.
    route: ({ assigned, available }) =>
      assigned === "67834773642" && available != null && available >= 0
        ? "pending"
        : "uol",
  },

  sneakerask: {
    scenario: "Phase 6.1.2 (SneakerAsk)",
    merchantId: "recsG470xt53Vy8KF",
    name: "SneakerAsk",
    queries: [{ financial_status: "any" }],
    lookbackMinutes: 145,
    lineFilter: line =>
      price(line) >= 50.01 &&
      !has(line.name, "Fear Of God") &&
      !has(line.name, "Maison Mihara") &&
      !has(line.price, ".00") &&
      notFulfilled(line) &&
      !has(line.name, "Custom"),
    size: regexSize(SIZE_NUMBER_BEFORE_SYSTEM),
    // Make took the size from the variant title here, even with a listing.
    sizeFromListing: false,
    skuSource: "product",
    connectInventory: false,
    route: always("uol"),
    // No location lookups needed when everything becomes an order.
    needsLocation: false,
  },
};
