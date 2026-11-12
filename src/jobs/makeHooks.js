// Hooks: Make scenarios that started from a webhook, as endpoints with the
// same payload. The service that called Make calls the engine instead:
//
//   POST /hooks/<key>?key=ENGINE_HOOKS_KEY
//
// Switch per hook in Airtable "Automation State": hook:<key> =
//   Make   pass the call on to Make, nothing else (default)
//   Test   pass it on to Make, and work out what the engine would do
//          (reads only); the plan shows in /health under hooks
//   Live   do it here; Make is not called
//
// To pass a call on, the engine needs Make's hook URL. 9.1's is known (it
// was in the KC portal's code); the others were only in Render variables,
// so they come from the engine's own variables (makeUrlEnv). Without one,
// Make and Test answer 503, so the caller sees the call fail instead of
// the deal silently going nowhere.
//
//   purchase-expense       9.1   KC portal: consignment / Member WTB unit made
//   seller-offer-deal      12.3.1 WTB bot: seller confirmed the deal
//   quick-deal             10.x  deal bot: Quick / Claim / Snapshot deal confirmed
//   counter-offer-accept   12.3.2 KC portal: a counter offer accepted

import { config } from "../config.js";
import { createRecord, getRecord, listRecords, updateRecord } from "../services/airtable.js";
import { getState } from "../services/automationState.js";
import { bookPurchase, VAT_TYPES } from "../services/rompslompPurchases.js";
import { openPayoutChannel } from "../services/payoutChannel.js";
import { escapeFormulaString } from "../utils/http.js";

const BASE = () => config.mainBaseId;
const T = {
  uol: "tblFdnvcyttZyGx0b",
  inventoryUnits: "tblt1aavfuJgspt8x",
  sellers: "tblHXvGz5aRaw93jB",
  memberWtbs: "tblPIj8O7e1dabZxn",
  sellerOffers: "tblTH1cFN0I1YqMO2",
};

const first = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => {
  const x = first(v);
  return x == null ? "" : String(x).trim();
};
const amsterdamDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(d);

// YYYY-MM-DD, as Make's formatDate(...; "YYYY-MM-DD").
export function expenseDate(value) {
  const s = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = s ? new Date(s) : new Date();
  return amsterdamDate(Number.isNaN(d.getTime()) ? new Date() : d);
}

// ---------------------------------------------------------------------------
// Inventory Unit of an outsourced deal (10.x, 12.3.1), field for field as Make
// ---------------------------------------------------------------------------

export function outsourcedUnitFields({ sellerRecordId, orderRecordId, memberWtbRecordId, sellerOfferId, ticket, p }) {
  const payout = Number(p.payout);
  return {
    "Seller ID": [sellerRecordId],
    "Product Name": text(p.productName),
    Source: "Outsourced",
    Type: "Custom",
    ...(orderRecordId ? { "Unfulfilled Orders Log": [orderRecordId] } : {}),
    ...(memberWtbRecordId ? { "Member WTBs": [memberWtbRecordId] } : {}),
    ...(sellerOfferId ? { "Seller Offer": [sellerOfferId] } : {}),
    "Margin %": "10%",
    "Purchase Price": payout,
    "Availability Status": "Reserved",
    "Payment Note": String(p.payout),
    "VAT Type": text(p.vatType),
    "Shipping Deduction": 0,
    "Base Costs": 5,
    "Payment Status": "To Pay",
    Brand: text(p.brand),
    "Purchase Date": amsterdamDate(),
    "Verification Status": "Verified",
    "Ticket Number": ticket,
    SKU: text(p.sku),
    Size: text(p.size),
  };
}

// A unit for this ticket and seller made in the last 30 minutes: the same
// deal again (a second click, a retry). Make had no such check.
async function recentUnit(ticket, sellerRecordId) {
  if (!ticket) return null;
  const rows = await listRecords(BASE(), T.inventoryUnits, {
    formula: `AND({Ticket Number} = '${escapeFormulaString(ticket)}', IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -30, 'minutes')))`,
    fields: ["Seller Record ID", "Item ID"],
  });
  return rows.find((r) => text(r.fields["Seller Record ID"]) === sellerRecordId) || null;
}

// Make the unit, read it back for its formula prices, book the purchase.
async function unitAndBooking({ unitFields, sellerFields, live, notes }) {
  const vatType = unitFields["VAT Type"];
  const payout = Number(unitFields["Purchase Price"]);
  if (!Number.isFinite(payout) || payout <= 0) throw new Error(`No payout (${unitFields["Purchase Price"]})`);

  const existing = await recentUnit(unitFields["Ticket Number"], unitFields["Seller ID"][0]);
  if (existing) {
    if (live) {
      return { unitId: existing.id, skipped: `unit ${text(existing.fields["Item ID"]) || existing.id} for this deal was made minutes ago; nothing done twice` };
    }
    notes.push(`a unit for this deal exists already (${text(existing.fields["Item ID"]) || existing.id}; in Test that is Make's)`);
  }

  // Final Purchase Price = Purchase Price - Shipping Deduction (0 here);
  // ex. VAT = that / 1.21 for VAT21. Live reads them from the unit itself.
  let price = vatType === "VAT21" ? payout / 1.21 : payout;
  let unitId = null;
  if (live) {
    const unit = await createRecord(BASE(), T.inventoryUnits, unitFields, { retries: 0, timeoutMs: 60000 });
    unitId = unit.id;
    const fresh = await getRecord(BASE(), T.inventoryUnits, unitId);
    const ff = fresh?.fields || {};
    const read = Number(first(vatType === "VAT21" ? ff["Final Purchase Price (ex. VAT)"] : ff["Final Purchase Price"]));
    if (Number.isFinite(read) && read > 0) price = read;
  }

  if (!VAT_TYPES.includes(vatType)) {
    return { unitId, unit: live ? undefined : unitFields, booking: { skipped: `VAT type "${vatType}" has no route (as in Make)` } };
  }

  let booking;
  try {
    booking = await bookPurchase(
      {
        sellerFields,
        ticket: unitFields["Ticket Number"],
        productName: unitFields["Product Name"],
        size: unitFields.Size,
        vatType,
        price,
      },
      { live }
    );
  } catch (err) {
    // The unit stands; the booking can be made by hand, as with Make's
    // failures.
    if (!live) throw err;
    booking = { error: `${err.message} Book "Purchase Order ${unitFields["Ticket Number"]}" by hand.` };
    console.error("[hooks] booking failed", unitFields["Ticket Number"], err.message);
  }
  return { unitId, ...(live ? {} : { unit: unitFields }), booking };
}

// ---------------------------------------------------------------------------
// The hooks
// ---------------------------------------------------------------------------

export const HOOKS = {
  // Make 9.1: the KC portal made a consignment / Member WTB unit; book it.
  "purchase-expense": {
    make: "Phase 9.1: Create Rompslomp Expense from Consignment/Member WTB",
    makeUrl: () => "https://hook.eu2.make.com/cmq6wlbq5sa9spmwogy4pdordvjzuz4i",
    ref: (p) => text(p.ticket_number) || text(p.order_id),
    async run(p, { live }) {
      const notes = [];
      const vatType = text(p.vat_type);
      if (!VAT_TYPES.includes(vatType)) return { skipped: `VAT type "${vatType}" has no route (as in Make)` };

      const seller = text(p.seller_record_id) ? await getRecord(BASE(), T.sellers, text(p.seller_record_id)) : null;
      if (!seller) throw new Error(`Seller ${text(p.seller_record_id) || "(none)"} not found`);

      let price = Number(p.purchase_price);
      if (vatType === "VAT21") {
        // Make read the first linked unit of the order or the Member WTB;
        // the payload names the unit itself, also right when there are two.
        const isMwtb = text(p.order_id).includes("MWTB");
        let unitId = text(p.inventory_unit_record_id);
        const parentId = isMwtb ? text(p.member_wtb_record_id) : text(p.order_record_id);
        if (parentId) {
          const parent = await getRecord(BASE(), isMwtb ? T.memberWtbs : T.uol, parentId);
          const makeUnit = text(parent?.fields?.["Linked Inventory Unit"]);
          if (!unitId) unitId = makeUnit;
          else if (makeUnit && makeUnit !== unitId) notes.push(`Make would have read unit ${makeUnit}; the engine reads ${unitId}`);
        }
        if (!unitId) throw new Error("VAT21 without an Inventory Unit to read the ex-VAT price from");
        const unit = await getRecord(BASE(), T.inventoryUnits, unitId);
        price = Number(first(unit?.fields?.["Final Purchase Price (ex. VAT)"]));
        if (!Number.isFinite(price)) throw new Error(`Unit ${unitId} has no Final Purchase Price (ex. VAT)`);
      }

      const result = await bookPurchase(
        {
          sellerFields: seller.fields || {},
          ticket: p.ticket_number,
          productName: p.product_name,
          size: p.size,
          vatType,
          price,
          date: expenseDate(p.purchase_date),
        },
        { live }
      );
      result.notes.unshift(...notes);
      return result;
    },
  },

  // Make 12.3.1: a seller confirmed a WTB deal in their channel.
  "seller-offer-deal": {
    make: "Phase 12.3.1: Create Inventory Unit From Seller Offer + Expenses",
    makeUrlEnv: "MAKE_HOOK_URL_SELLER_OFFER_DEAL",
    ref: (p) => text(p.orderId),
    async run(p, { live }) {
      const notes = [];
      const [seller] = await listRecords(BASE(), T.sellers, {
        formula: `{Seller ID} = '${escapeFormulaString(text(p.sellerCode))}'`,
        maxRecords: 1,
      });
      if (!seller) throw new Error(`No seller ${text(p.sellerCode)}`);
      const [order] = await listRecords(BASE(), T.uol, {
        formula: `{Order ID} = '${escapeFormulaString(text(p.orderId))}'`,
        fields: ["Order ID", "Lowest Seller Offer Record ID"],
        maxRecords: 1,
      });
      if (!order) throw new Error(`No order ${text(p.orderId)}`);
      const sellerOfferId = text(order.fields["Lowest Seller Offer Record ID"]);

      const result = await unitAndBooking({
        unitFields: outsourcedUnitFields({
          sellerRecordId: seller.id,
          orderRecordId: order.id,
          sellerOfferId,
          ticket: text(p.orderId),
          p,
        }),
        sellerFields: seller.fields || {},
        live,
        notes,
      });

      if (sellerOfferId && !result.skipped) {
        if (live) {
          await updateRecord(BASE(), T.sellerOffers, sellerOfferId, { "Bot Feedback": "✅ Your Offer Has Been Accepted!" })
            .catch((err) => notes.push(`Bot Feedback not set: ${err.message}`));
        } else {
          notes.push(`would set Bot Feedback on seller offer ${sellerOfferId}`);
        }
      }
      return { ...result, notes };
    },
  },

  // Make 10.x: a Quick / Claim / Snapshot deal confirmed in the deal bot.
  "quick-deal": {
    make: "Phase 10.x: Create Inventory Unit From Quick Deal Claim + Expenses",
    makeUrlEnv: "MAKE_HOOK_URL_QUICK_DEAL",
    ref: (p) => text(p.orderNumber),
    async run(p, { live }) {
      const notes = [];
      const seller = text(p.sellerRecordId) ? await getRecord(BASE(), T.sellers, text(p.sellerRecordId)) : null;
      if (!seller) throw new Error(`Seller ${text(p.sellerRecordId) || "(none)"} not found`);

      const result = await unitAndBooking({
        unitFields: outsourcedUnitFields({
          sellerRecordId: seller.id,
          orderRecordId: text(p.orderRecordId),
          memberWtbRecordId: text(p.memberWtbRecordId),
          ticket: text(p.orderNumber),
          p,
        }),
        sellerFields: seller.fields || {},
        live,
        notes,
      });
      return { ...result, notes };
    },
  },

  // Make 12.3.2: a counter offer on a seller offer was accepted; the order is
  // confirmed and the seller gets the payout channel.
  "counter-offer-accept": {
    make: "Phase 12.3.2: Create Private Channel Counter Seller Offer",
    makeUrlEnv: "MAKE_HOOK_URL_COUNTER_OFFER_ACCEPT",
    ref: (p) => text(p.order_record_id),
    async run(p, { live }) {
      if (text(p.source_type) !== "Seller Offer") {
        return { skipped: `source "${text(p.source_type)}": nothing to do (as in Make)` };
      }
      const vatType = text(p.counter_payout_vat_type);
      if (!VAT_TYPES.includes(vatType)) return { skipped: `VAT type "${vatType}" has no route (as in Make)` };

      const orderId = text(p.order_record_id);
      const order = orderId ? await getRecord(BASE(), T.uol, orderId) : null;
      if (!order) throw new Error(`Order ${orderId || "(none)"} not found`);
      const seller = text(p.seller_record_id) ? await getRecord(BASE(), T.sellers, text(p.seller_record_id)) : null;
      if (!seller) throw new Error(`Seller ${text(p.seller_record_id) || "(none)"} not found`);
      const of = order.fields || {};
      const sf = seller.fields || {};

      const orderUpdate = {
        "Offer Sent?": false,
        "Fulfillment Status": "Confirmed",
        "Offer Accepted?": true,
        ...(vatType === "Margin"
          ? { "Offer VAT Type": "Margin", "Custom Offer": Number(p.store_counter_price) }
          : {}),
      };
      if (live) await updateRecord(BASE(), T.uol, orderId, orderUpdate);

      const channel = await openPayoutChannel(
        orderId,
        {
          orderId: text(of["Order ID"]),
          productName: text(of["Product Name"]),
          sku: text(of.SKU),
          size: text(of.Size),
          brand: text(of.Brand),
          payout: Number(p.counter_payout),
          sellerCode: text(sf["Seller ID"]),
          imageUrl: first(of.Picture)?.url || "",
          discordUserId: text(sf["Discord ID"]),
          vatType,
        },
        { live }
      );
      return { orderUpdate, channel };
    },
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const MODES = new Set(["Make", "Test", "Live"]);
const results = {};

export function hookResults() {
  const out = {};
  for (const [key, hook] of Object.entries(HOOKS)) {
    out[key] = {
      make: hook.make,
      makeUrlSet: Boolean(makeUrlOf(hook)),
      recent: results[key] || [],
    };
  }
  return out;
}

function makeUrlOf(hook) {
  return hook.makeUrl ? hook.makeUrl() : process.env[hook.makeUrlEnv] || "";
}

function remember(key, entry) {
  const list = (results[key] = results[key] || []);
  list.unshift({ at: new Date().toISOString(), ...entry });
  list.length = Math.min(list.length, 25);
}

async function readMode(key) {
  const value = text(await getState(`hook:${key}`).catch(() => null));
  return MODES.has(value) ? value : "Make";
}

async function forwardToMake(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Make hook -> HTTP ${response.status}`);
}

// Keep what is useful to see in /health, without the bulky copies.
const brief = (p) => {
  const { airtable_fields, ...rest } = p || {};
  return rest;
};

export function hookHandler(key) {
  const hook = HOOKS[key];
  return async (req, res) => {
    const payload = req.body || {};
    const ref = hook.ref(payload) || "?";
    const mode = await readMode(key);

    if (mode !== "Live") {
      const url = makeUrlOf(hook);
      if (!url) {
        remember(key, { mode, ref, error: `${hook.makeUrlEnv} is not set; nothing passed on` });
        return res.status(503).json({ ok: false, error: `${hook.makeUrlEnv} is not set` });
      }
      try {
        await forwardToMake(url, payload);
      } catch (err) {
        console.error(`[hooks:${key}] forward to Make failed`, ref, err.message);
        remember(key, { mode, ref, error: `forward to Make failed: ${err.message}` });
        return res.status(502).json({ ok: false, error: "forward to Make failed" });
      }
      res.json({ ok: true, mode, forwarded: true });

      if (mode === "Test") {
        try {
          remember(key, { mode, ref, plan: await hook.run(payload, { live: false }), payload: brief(payload) });
        } catch (err) {
          remember(key, { mode, ref, error: err.message, payload: brief(payload) });
        }
      } else {
        remember(key, { mode, ref, forwarded: true });
      }
      return;
    }

    try {
      const result = await hook.run(payload, { live: true });
      console.log(`[hooks:${key}] done`, ref, JSON.stringify(result).slice(0, 300));
      remember(key, { mode, ref, result });
      res.json({ ok: true, mode, ...result });
    } catch (err) {
      console.error(`[hooks:${key}] failed`, ref, err.message);
      remember(key, { mode, ref, error: err.message, payload: brief(payload) });
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}
