// Watchers: Make scenarios that did nothing but look at Airtable every 15 or
// 60 minutes and act on what they found. Looking costs nothing here, so they
// run every 5 minutes (or every hour where the timing mattered).
//
// Each watcher has a switch in the Airtable table "Automation State":
//   watcher:<key> = Make   the engine leaves it alone (default)
//                   Test   reads and decides, writes and posts nothing;
//                          the plan shows in /health
//                   Live   does it for real (turn the Make scenario off)
//
// Two kinds, as in Make:
//   watch   "Watch records": each record once, in the order of a trigger
//           field (created time or a last-modified time). The cursor lives
//           in Automation State as watcher:<key>:cursor.
//   search  "Search records" on a schedule: every match, every run. These
//           only act on records whose result takes them out of the formula.

import { config } from "../config.js";
import {
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
} from "../services/airtable.js";
import { getState, setState } from "../services/automationState.js";
import { openPayoutChannel } from "../services/payoutChannel.js";
import { escapeFormulaString } from "../utils/http.js";

const BASE = () => config.mainBaseId;

const T = {
  uol: "tblFdnvcyttZyGx0b",
  inventoryUnits: "tblt1aavfuJgspt8x",
  merchants: "tbl5ZbrS4KdJ2QQaf",
  sellers: "tblHXvGz5aRaw93jB",
  discordMembers: "tblLJUqstMaHTjBr6",
  labelUploadForm: "tblMJ56RgOHsKFBNZ",
  buyers: "tblMJLl9ifQBuRAcs",
  stockLevels: "tblt8BLVZvlU0HUJ0",
};

const F = {
  uolStatus: "fldFuzoNdPUXhL1hC",
  uolConsignmentOfferTriggered: "fldv64VNKvElck0uu",
  uolLabelUpload: "fldgMUXaOmvyTbU2E",
  uolLabelFile: "fldjKMjTH7MrObi29",
  sellerDiscordMembers: "fldZZm33jnAhKO0cx",
  sellerDiscordId: "fldUASDIfNoD7hgxD",
  unitStockLevels: "fldX208wyeLCUe1Rm",
  stockLevelSkuMaster: "fldFBW2XRmPzJqdUI",
  stockLevelUnits: "fldasFmbnT4nyP5aL",
  stockLevelSku: "fldbKPQ6RjOBmwN3x",
  stockLevelSize: "fldxzFuOUIcbp13ws",
};

const URL = {
  quickDeal: "https://discord-deal-bot.onrender.com/quick-deal/create",
  quickDealPartners: "https://discord-deal-bot.onrender.com/quick-deal/create-partners",
  partnerOfferDeal: "https://discord-wtb-bot.onrender.com/partner-offer-deal",
  partnerWtb: "https://discord-wtb-bot.onrender.com/partner-wtb",
  firstStockx: "https://airtable-discord-updates.onrender.com/post-first-stockx-order",
  secondStockx: "https://airtable-discord-updates.onrender.com/post-second-stockx-order",
  goatOrder: "https://airtable-discord-updates.onrender.com/post-goat-order",
  consignmentOffer: "https://kickzcaviar.com/api/consignment/offers/create",
};

// ---------------------------------------------------------------------------
// Helpers that read Make's way
// ---------------------------------------------------------------------------

const first = value => (Array.isArray(value) ? value[0] : value);
const text = value => {
  const v = first(value);
  return v == null ? "" : String(v);
};
// Make's "exist": anything but empty.
const exists = value =>
  !(value == null || value === "" || (Array.isArray(value) && value.length === 0));
const imageUrl = fields => first(fields.Picture)?.url || "";

// Make built these JSON bodies from text and skipped product names with a
// double quote, which would have broken the JSON. Kept so the same deals go
// out; the engine itself encodes quotes fine.
const noQuote = fields => !text(fields["Product Name"]).includes('"');

function quickDealBody(r) {
  const f = r.fields;
  return {
    recordId: r.id,
    orderNumber: text(f["Order ID"]),
    productName: text(f["Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    brand: text(f.Brand),
    currentPayout: text(f["Current Payout"]),
    maxPayout: text(f["Max Payout"]),
    timeToMaxPayout: text(f["Payout Countdown"]),
    imageUrl: imageUrl(f),
  };
}

function partnerOfferBody(r) {
  const f = r.fields;
  const startPayout = Number(first(f["Final Outsource Buying Price"]));
  if (!Number.isFinite(startPayout)) {
    // Make's JSON would have been invalid here and the call failed.
    throw new Error("Final Outsource Buying Price is empty");
  }
  return {
    productName: text(f["Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    brand: text(f.Brand),
    startPayout,
    imageUrl: imageUrl(f),
    dealId: text(f["Order ID"]),
    recordId: r.id,
  };
}

function partnerWtbBody(r) {
  const f = r.fields;
  return {
    productName: text(f["Product Name"]),
    sku: text(f.SKU),
    size: text(f.Size),
    brand: text(f.Brand),
    imageUrl: imageUrl(f),
    dealId: text(f["Order ID"]),
    recordId: r.id,
  };
}

// Make 14.1 / 14.4: the pair bought on StockX or GOAT becomes an Inventory
// Unit of the marketplace "seller", and the purchase is booked in Rompslomp
// on Voorraad | Scout (custom).
const ROMPSLOMP_EXPENSES = "https://app.rompslomp.nl/api/v1/companies/1296508534/expenses";

const amsterdamDate = iso =>
  iso
    ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date(iso))
    : undefined;

async function marketplaceOrderToUnit(r, act, m) {
  if (act.live && !config.rompslompToken) {
    // Nothing half-done: without the token the expense would fail after the
    // unit was made.
    throw new Error("ROMPSLOMP_API_TOKEN is not set on this service");
  }

  const f = r.fields;
  const price = Number(first(f[m.priceField]));
  if (!Number.isFinite(price)) throw new Error(`${m.priceField} is empty`);
  const orderNumber = text(f[m.orderNumberField]);
  const purchaseDate = amsterdamDate(text(f.LastSyncAt));

  await act.create(
    T.inventoryUnits,
    {
      "Seller ID": [m.sellerId],
      "Product Name": text(f["Product Name"]),
      Source: "Outsourced",
      Type: "Custom",
      "Unfulfilled Orders Log": [r.id],
      "Margin %": m.margin,
      "Purchase Price": price,
      "Availability Status": "Sold",
      "Payment Note": String(price),
      "VAT Type": m.vatType,
      "Shipping Deduction": 0,
      "Base Costs": 5,
      "Payment Status": "Paid",
      Brand: text(f.Brand),
      ...(purchaseDate ? { "Purchase Date": purchaseDate } : {}),
      "Verification Status": "Verified",
      "Ticket Number": orderNumber,
      SKU: text(f.SKU),
      Size: text(f.Size),
    },
    { typecast: true }
  );

  await act.post(
    ROMPSLOMP_EXPENSES,
    {
      expense: {
        date: "",
        state: "published",
        type_account_id: 1506,
        currency: "eur",
        contact_id: 1610033116,
        invoice_lines: [
          {
            description: `Purchase Order ${text(f["Order ID"])}`,
            extended_description:
              `${text(f["Product Name"])} - ${text(f.Size)}\n\n ${orderNumber}` +
              (m.reverseCharge ? "\n\n BTW Verlegd" : ""),
            price_per_unit: String(price),
            vat_rate: "",
            vat_type_id: 688369464,
            quantity: "1.0",
            product_id: null,
            account_id: 1981496874,
            account_path: "activa.current_assets.voorraad_scout_custom",
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${config.rompslompToken}`,
        Accept: "application/json",
      },
    }
  );
}

// Make 3.2 met the units one by one, so a Stock Level it had just made was
// found for the next unit with the same key. A run here remembers the ones it
// made (or, in Test, would have made) for the same reason.
const stockLevelsMadeThisRun = new Map();

async function stockLevelFor(r, act) {
  const f = r.fields;
  // The unit's key reads the SKU Master; a new Stock Level gets the unit's
  // own SKU text. When those differ, Make never found what it had made and
  // made another one on every change. Both keys are looked up here.
  const unitKey = text(f["Stock Counter Key"]);
  const ownKey = `${text(f.SKU)}-${text(f.Size)}`;
  const keys = [...new Set([unitKey, ownKey])];
  if (keys.length > 1) act.note({ note: `SKU "${text(f.SKU)}" differs from its SKU Master key "${unitKey}"` });
  const linked = Array.isArray(f["Stock Levels"]) ? f["Stock Levels"] : [];

  let matches = keys.map(k => stockLevelsMadeThisRun.get(k)).filter(Boolean);
  if (!matches.length) {
    const found = await listRecords(BASE(), T.stockLevels, {
      formula: `OR(${keys.map(k => `{Stock Counter Key} = "${escapeFormulaString(k)}"`).join(", ")})`,
      fields: ["Stock Counter Key"],
      maxRecords: 10,
    });
    // The unit's own key first, as Make searched that one.
    found.sort((x, y) => (text(y.fields["Stock Counter Key"]) === unitKey) - (text(x.fields["Stock Counter Key"]) === unitKey));
    matches = found.map(x => x.id);
    if (matches.length > 1) act.note({ note: `${matches.length} Stock Levels match ${keys.join(" / ")}` });
  }

  if (matches.length) {
    if (linked.some(id => matches.includes(id))) return act.skip("already linked");
    await act.update(T.inventoryUnits, r.id, { [F.unitStockLevels]: [matches[0]] });
    return;
  }

  // None yet: make it, linked to the unit (which links the unit to it too).
  const created = await act.create(T.stockLevels, {
    [F.stockLevelSkuMaster]: [text(f["SKU Master Link"])],
    [F.stockLevelUnits]: [r.id],
    [F.stockLevelSku]: text(f.SKU),
    [F.stockLevelSize]: text(f.Size),
  });
  for (const k of keys) stockLevelsMadeThisRun.set(k, created?.id || "(new in this run)");
}

async function merchantOf(r) {
  const id = first(r.fields.Client);
  if (!id) return {};
  return (await getRecord(BASE(), T.merchants, id))?.fields || {};
}

// ---------------------------------------------------------------------------
// The watchers
// ---------------------------------------------------------------------------

export const WATCHERS = [
  {
    key: "outsource-new-deal",
    make: "Phase 6.4.1: Send Outsource \"New Deal\" Webhooks",
    kind: "watch",
    table: T.uol,
    triggerField: "Last Status Modification",
    formula: `AND({Fulfillment Status} = 'Outsource', {Claim Message URL} = "", {Offer Message URL} = "")`,
    everyMinutes: 5,
    async handle(r, act) {
      const f = r.fields;
      const store = text(f["Store Name"]);
      if (f.Brand === "Fear of God" || f.Brand === "Denim Tears" || store.includes("test")) {
        return act.skip("brand or test store");
      }
      if (!noQuote(f)) return act.skip("product name has a double quote");

      const autoAccept = text(f["Auto Offer Accept?"]);
      const budget = exists(f["Marketplace Buying Budget"]);

      if (autoAccept === "Yes" || budget) {
        const body = quickDealBody(r);
        await act.post(URL.quickDeal, body);
        await act.post(URL.quickDealPartners, body);
        return;
      }

      if (autoAccept === "No" && store !== "SneakerAsk" && !budget) {
        await act.post(URL.partnerOfferDeal, partnerOfferBody(r));
        await act.post(URL.partnerWtb, partnerWtbBody(r));
        return;
      }

      act.skip("no route");
    },
  },

  {
    key: "stockx-order-to-unit",
    make: "Phase 14.1: StockX Auto-Bid Order to Allocated",
    kind: "watch",
    table: T.uol,
    triggerField: "Last Status Modification",
    formula: `AND({Fulfillment Status} = 'StockX Processing', {Linked Inventory Unit} = "")`,
    everyMinutes: 5,
    async handle(r, act) {
      if (text(r.fields["Store Name"]) === "SneakerAsk") return act.skip("SneakerAsk (14.2 does that one)");
      await marketplaceOrderToUnit(r, act, {
        sellerId: "SE-00309",
        margin: "7.5%",
        vatType: "VAT0",
        priceField: "Final StockX Price",
        orderNumberField: "StockX Order Number",
        reverseCharge: true,
      });
    },
  },

  {
    key: "goat-order-to-unit",
    make: "Phase 14.4: GOAT Auto-Purchase Order to Allocated",
    kind: "watch",
    table: T.uol,
    triggerField: "Last Status Modification",
    formula: `AND({Fulfillment Status} = 'GOAT Processing', {Linked Inventory Unit} = "")`,
    everyMinutes: 5,
    async handle(r, act) {
      if (text(r.fields["Store Name"]) === "SneakerAsk") return act.skip("SneakerAsk (14.5 does that one)");
      // Make put the StockX price and StockX order number on the unit here
      // (copied from 14.1); those are empty on a GOAT order. The GOAT ones
      // are used, as Make's own Rompslomp line already did.
      await marketplaceOrderToUnit(r, act, {
        sellerId: "SE-00537",
        margin: "15%",
        vatType: "Margin",
        priceField: "GOAT Final Price",
        orderNumberField: "GOAT Order Number",
        reverseCharge: false,
      });
    },
  },

  {
    key: "stockx-first-order-sneakerask",
    make: "Phase 14.2: StockX Auto-Bid Order to Found",
    kind: "watch",
    table: T.uol,
    triggerField: "Last Status Modification",
    formula: `AND({Fulfillment Status} = 'StockX Processing', {Linked Inventory Unit} = "")`,
    everyMinutes: 5,
    async handle(r, act) {
      if (text(r.fields["Store Name"]) !== "SneakerAsk") return act.skip("not SneakerAsk (14.1 does the rest)");
      await act.update(T.uol, r.id, { [F.uolStatus]: "Found" });
      const m = await merchantOf(r);
      await act.post(URL.firstStockx, {
        record_id: r.id,
        channel_id: text(m["StockX Notification Channel ID"]),
      });
    },
  },

  {
    key: "goat-order-sneakerask",
    make: "Phase 14.5: GOAT Auto-Purchase Order to Found",
    kind: "watch",
    table: T.uol,
    triggerField: "Last Status Modification",
    formula: `AND({Fulfillment Status} = 'GOAT Processing', {Linked Inventory Unit} = "")`,
    everyMinutes: 5,
    async handle(r, act) {
      if (text(r.fields["Store Name"]) !== "SneakerAsk") return act.skip("not SneakerAsk (14.4 does the rest)");
      const m = await merchantOf(r);
      await act.post(URL.goatOrder, {
        record_id: r.id,
        channel_id: text(m["GOAT Notification Channel ID"]),
      });
      await act.update(T.uol, r.id, { [F.uolStatus]: "Found" });
    },
  },

  {
    key: "stockx-second-order-sneakerask",
    make: "Phase 14.3: StockX Second-Bid Order Message",
    kind: "watch",
    table: T.uol,
    triggerField: "Second Order Trigger",
    formula: `{SecondLastAction} = 'SECOND_ORDER_PLACED'`,
    everyMinutes: 5,
    async handle(r, act) {
      if (text(r.fields["Store Name"]) !== "SneakerAsk") return act.skip("not SneakerAsk");
      const m = await merchantOf(r);
      await act.post(URL.secondStockx, {
        record_id: r.id,
        channel_id: text(m["StockX 2nd Notification Channel ID"]),
      });
    },
  },

  {
    key: "consignment-offer",
    make: "Phase 12.2.2: Process Confirmed Consignment Offer",
    kind: "search",
    table: T.uol,
    formula: `AND({Fulfillment Status} = "Confirmed", {Custom Offer} != "", {Consignment Pre-Offer?} = 1, {Consignment Offer Triggered?} != 1)`,
    everyMinutes: 5,
    async handle(r, act) {
      const f = r.fields;
      await act.post(URL.consignmentOffer, {
        order_record_id: r.id,
        order_id: text(f["Order ID"]),
        sku: text(f.SKU),
        size: text(f.Size),
        maximum_buying_price: text(f["Custom Offer"]),
        direct_seller_offer_price: text(f["Consignment Offer Price"]),
      });
      await act.update(T.uol, r.id, { [F.uolConsignmentOfferTriggered]: true });
    },
  },

  {
    key: "seller-payout-channel",
    make: "Phase 12.2.1: Process Confirmed Seller/Partner Offer Deal + Expenses",
    kind: "search",
    table: T.uol,
    formula: `AND({Fulfillment Status} = "Confirmed", {Custom Offer} = "", {Lowest Offer} > 0, {Channel Created?} != 1, COUNTA({Consignment If Lowest}) = 0)`,
    everyMinutes: 5,
    async handle(r, act) {
      const f = r.fields;
      // The partner route (unit, partner feedback, Rompslomp, partner
      // Discord webhooks) was last used in June 2026 and is retired.
      if (text(f["Partner or Seller"]) !== "Seller") {
        return act.skip(`"${text(f["Partner or Seller"])}" offer: only seller offers are handled`);
      }
      const result = await openPayoutChannel(
        r.id,
        {
          orderId: text(f["Order ID"]),
          productName: text(f["Product Name"]),
          sku: text(f.SKU),
          size: text(f.Size),
          brand: text(f.Brand),
          payout: Number(first(f["Lowest Seller Offer"])),
          sellerCode: text(f["Lowest Offer Seller ID"]),
          imageUrl: imageUrl(f),
          discordUserId: text(f["Lowest Offer Discord ID"]),
          vatType: text(f["Lowest Offer VAT Type"]),
        },
        { live: act.live }
      );
      act.note({ payoutChannel: result });
    },
  },

  {
    key: "seller-discord-link",
    make: "Phase 13.3: Search Discord ID To Match Existing Sellers",
    kind: "watch",
    table: T.sellers,
    triggerField: "Created",
    formula: `{Discord Members} = ""`,
    everyMinutes: 5,
    async handle(r, act) {
      const discordId = text(r.fields["Discord ID"]).trim();
      // Make searched with an empty ID too and linked whichever member had
      // no ID either.
      if (!discordId) return act.skip("seller has no Discord ID");
      const [member] = await listRecords(BASE(), T.discordMembers, {
        formula: `{Discord User ID} = '${escapeFormulaString(discordId)}'`,
        fields: ["Discord User ID"],
        maxRecords: 1,
      });
      if (!member) return act.skip("no Discord member with this ID");
      await act.update(T.sellers, r.id, { [F.sellerDiscordMembers]: [member.id] });
    },
  },

  {
    key: "member-seller-link",
    make: "Phase 13.2: New Member Find Existing Seller ID",
    kind: "watch",
    table: T.discordMembers,
    triggerField: "Created At",
    formula: `{Linked Seller} = ""`,
    everyMinutes: 5,
    async handle(r, act) {
      const username = text(r.fields["Discord Username"]).trim();
      if (!username) return act.skip("member has no username");
      const sellers = await listRecords(BASE(), T.sellers, {
        formula: `{Discord} = '${escapeFormulaString(username)}'`,
        fields: ["Discord"],
        maxRecords: 4,
      });
      if (!sellers.length) return act.skip("no seller with this Discord name");
      for (const seller of sellers) {
        await act.update(T.sellers, seller.id, {
          [F.sellerDiscordId]: text(r.fields["Discord User ID"]),
          [F.sellerDiscordMembers]: [r.id],
        });
      }
    },
  },

  {
    key: "buyer-to-plug-and-play",
    make: "Phase 16.1: Add Buyer To Plug & Play",
    kind: "watch",
    base: "appY9ZV7HJMYQbLUA",
    table: "tblWDkAGw3vogoMbY",
    triggerField: "Created",
    formula: "",
    everyMinutes: 5,
    async handle(r, act) {
      const f = r.fields;
      const buyerId = text(f["Buyer ID"]);
      if (!buyerId) return act.skip("no Buyer ID");
      const [existing] = await listRecords(BASE(), T.buyers, {
        formula: `{Buyer ID} = '${escapeFormulaString(buyerId)}'`,
        fields: ["Buyer ID"],
        maxRecords: 1,
      });
      if (existing) return act.skip("buyer already exists");
      const map = {
        fld7J9DuQfGSpWr52: f.Address,
        fld9zRJSReI8cUyf3: f["Full Name"],
        fldDJXQ2KiRNwbec2: buyerId,
        fldFtYVg4EtF1ryOX: f.Country,
        fldI7RMAI8wo3qRLU: f["Company Name"],
        fldMZnfPpDP5miKGP: f.City,
        fldfZkcrZoa6XHmKD: f.Discord,
        fldhw61uW6h0Qvrzc: f["Country Code"],
        fldmUDhSVJXjtor21: f["Address line 2"],
        fldvG7kT7dUJygQ0D: f.Email,
        fldvRfz10iwvcqgzA: f.Zipcode,
        fldz39uCP8F5T88UN: f["VAT ID"],
      };
      const fields = Object.fromEntries(
        Object.entries(map)
          .map(([k, v]) => [k, text(v)])
          .filter(([, v]) => v !== "")
      );
      await act.create(T.buyers, fields);
    },
  },

  {
    key: "label-upload",
    make: "Phase 11.3: Label Upload Handler",
    kind: "watch",
    table: T.labelUploadForm,
    triggerField: "Created",
    formula: "",
    everyMinutes: 5,
    async handle(r, act) {
      const orderNumber = text(r.fields.Name);
      if (!orderNumber) return act.skip("no order number");
      const [order] = await listRecords(BASE(), T.uol, {
        formula: `{Shopify Order Number} = '${escapeFormulaString(orderNumber)}'`,
        view: "viwcuICRjW4fjbAIB",
        fields: ["Shopify Order Number"],
        maxRecords: 1,
      });
      if (!order) return act.skip(`no open order ${orderNumber}`);
      const pdf = first(r.fields["Drop PDF Below"])?.url;
      await act.update(T.uol, order.id, {
        [F.uolLabelUpload]: [r.id],
        ...(pdf ? { [F.uolLabelFile]: [{ url: pdf }] } : {}),
      });
    },
  },

  {
    key: "outsource-wtb-offers-48h",
    make: "Phase 6.4.2: Send Outsource \"WTB Offers\" Webhooks",
    kind: "search",
    table: T.uol,
    formula: `AND({Fulfillment Status} = "Outsource", DATETIME_DIFF(NOW(), {Order Date}, 'hours') >= 48, {Offer Message URL} = "", {Marketplace Buying Budget} = BLANK())`,
    // Hourly on purpose: a record stays in this search until the bot has
    // posted, so every run sends it again.
    everyMinutes: 60,
    async handle(r, act) {
      const f = r.fields;
      if (text(f["Auto Offer Accept?"]) !== "Yes") return act.skip("store has no auto accept");
      if (text(f["Store Name"]).includes("test")) return act.skip("test store");
      if (!noQuote(f)) return act.skip("product name has a double quote");
      await act.post(URL.partnerOfferDeal, partnerOfferBody(r));
      await act.post(URL.partnerWtb, partnerWtbBody(r));
    },
  },

  {
    key: "mark-found-tracked",
    make: "Mark Found & Tracked",
    kind: "search",
    table: T.uol,
    formula: `{Fulfillment Status} = 'Found'`,
    everyMinutes: 5,
    async handle(r, act) {
      const f = r.fields;
      const stockxFirst = f.LastAction === "ORDER_PLACED" && exists(f["StockX Tracking URL"]);
      const stockxSecond =
        f.LastAction === "FIRST_ORDER_PLACED" &&
        f.SecondLastAction === "SECOND_ORDER_PLACED" &&
        exists(f["Second StockX Tracking URL"]);
      const goat = f["GOAT LastAction"] === "PURCHASED" && exists(f["GOAT Tracking URL"]);
      if (!stockxFirst && !stockxSecond && !goat) return act.skip("not finished yet");
      await act.update(T.uol, r.id, { [F.uolStatus]: "Found & Tracked" });
    },
  },

  {
    key: "stock-levels",
    make: "Phase 3.2: Update Stock Levels (Modification)",
    kind: "watch",
    table: T.inventoryUnits,
    // Size, Availability Status or SKU Master Link changed.
    triggerField: "Last Stock Modified Time",
    formula: `{SKU Master Link} != ""`,
    fields: ["Item ID", "SKU", "Size", "SKU Master Link", "Stock Counter Key", "Stock Levels"],
    everyMinutes: 5,
    async handle(r, act) {
      await stockLevelFor(r, act);
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const MODES = new Set(["Make", "Test", "Live"]);
const lastStarted = new Map();
const lastResults = {};
let running = false;

export function watcherResults() {
  return lastResults;
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const reply = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`POST ${url} -> HTTP ${response.status} ${reply.slice(0, 200)}`);
  }
}

function makeActions(live, log) {
  return {
    live,
    skip(reason) {
      log.push({ skip: reason });
    },
    note(entry) {
      log.push(entry);
    },
    async post(url, body, { headers } = {}) {
      log.push({ post: url, body });
      if (live) await postJson(url, body, headers);
    },
    async update(table, id, fields) {
      log.push({ update: table, id, fields });
      if (live) await updateRecord(BASE(), table, id, fields);
    },
    async create(table, fields, { typecast = false } = {}) {
      log.push({ create: table, fields });
      if (live) return createRecord(BASE(), table, fields, { typecast, retries: 0, timeoutMs: 60000 });
      return null;
    },
  };
}

async function readMode(w) {
  const name = `watcher:${w.key}`;
  const raw = await getState(name);
  if (raw == null) {
    // Make the switch visible in Airtable, off by default.
    await setState(name, "Make");
    return "Make";
  }
  const mode = String(raw).trim();
  return MODES.has(mode) ? mode : "Make";
}

async function runWatch(w, live, result) {
  const cursorKey = `watcher:${w.key}:cursor`;
  const raw = await getState(cursorKey);
  let cursor = raw ? JSON.parse(raw) : null;

  if (!cursor) {
    // First run: from now on, as Make did when a scenario was switched on.
    cursor = { at: new Date().toISOString(), ids: [] };
    await setState(cursorKey, JSON.stringify(cursor));
    result.note = "cursor started";
    return;
  }

  const since = `NOT(IS_BEFORE({${w.triggerField}}, '${cursor.at}'))`;
  const formula = w.formula ? `AND(${w.formula}, ${since})` : since;

  const records = await listRecords(w.base || BASE(), w.table, {
    formula,
    fields: w.fields ? [...w.fields, w.triggerField] : [],
    sort: [{ field: w.triggerField, direction: "asc" }],
    maxRecords: 200,
  });

  for (const r of records) {
    const at = r.fields[w.triggerField];
    if (!at) continue;
    if (at === cursor.at && cursor.ids.includes(r.id)) continue;

    await handleOne(w, r, live, result);

    cursor = at === cursor.at
      ? { at, ids: [...cursor.ids, r.id] }
      : { at, ids: [r.id] };
    await setState(cursorKey, JSON.stringify(cursor));
  }
}

async function runSearch(w, live, result) {
  const records = await listRecords(w.base || BASE(), w.table, {
    formula: w.formula,
    maxRecords: 1000,
  });
  for (const r of records) {
    await handleOne(w, r, live, result);
  }
}

async function handleOne(w, r, live, result) {
  const log = [];
  try {
    await w.handle(r, makeActions(live, log));
    const acted = log.some(entry => !entry.skip);
    if (acted) result.acted += 1;
    else result.skipped += 1;
    if ((!live || acted) && result.records.length < 50) {
      result.records.push({ id: r.id, label: r.fields["Order ID"] || r.fields["Item ID"] || r.fields.Name || r.fields["Seller ID"] || r.fields["Buyer ID"] || r.fields["Discord Username"] || "", log });
    }
  } catch (error) {
    // Logged and passed over, as Make moved on to the next bundle.
    result.errors.push({ id: r.id, error: error.message, log });
    console.error(`[watchers] ${w.key} ${r.id}`, error.message);
  }
}

export async function runMakeWatchers({ source = "scheduler", only, force = false } = {}) {
  if (!config.engineEnabled) return { skipped: true, reason: "disabled" };
  if (running) return { skipped: true, reason: "already running" };
  running = true;

  const summary = { source, startedAt: new Date().toISOString(), watchers: {} };

  try {
    for (const w of WATCHERS) {
      if (only && !only.includes(w.key)) continue;

      const mode = await readMode(w);
      if (mode === "Make") {
        summary.watchers[w.key] = { mode };
        continue;
      }

      const due = Date.now() - (lastStarted.get(w.key) || 0) >= (w.everyMinutes - 1) * 60000;
      if (!due && !force) continue;
      lastStarted.set(w.key, Date.now());

      const result = { mode, make: w.make, at: new Date().toISOString(), acted: 0, skipped: 0, records: [], errors: [] };
      try {
        stockLevelsMadeThisRun.clear();
      if (w.kind === "watch") await runWatch(w, mode === "Live", result);
        else await runSearch(w, mode === "Live", result);
      } catch (error) {
        result.errors.push({ error: error.message });
        console.error(`[watchers] ${w.key} failed`, error);
      }

      // Test runs keep their plan for /health; live runs only the counts.
      if (mode === "Live") result.records = result.records.length;
      lastResults[w.key] = result;
      summary.watchers[w.key] = { mode, acted: result.acted, skipped: result.skipped, errors: result.errors.length };
    }
  } finally {
    running = false;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
