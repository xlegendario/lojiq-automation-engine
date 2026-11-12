// Make 9.1 "Create Rompslomp Expense from Consignment/Member WTB", as an
// endpoint with the same payload. The KC portal posts here when it made the
// Inventory Unit of a consignment deal or a Member WTB purchase; the purchase
// is booked in Rompslomp (Payout by Kickz Caviar B.V., Voorraad | Scout),
// with the seller as supplier (made when Rompslomp does not know them yet).
//
// Switch in Airtable "Automation State": hook:purchase-expense =
//   Make   pass the call on to Make, do nothing else (default)
//   Test   pass it on to Make, and work out what the engine would book
//          (reads only); the plan shows in /health under hooks
//   Live   book it here; Make is not called
//
// So the KC portal can point at this endpoint while Make still does the work,
// and the switch decides when the engine takes over.
//
// Per VAT type, as Make did:
//   Margin  the purchase price, no VAT
//   VAT0    the purchase price, no VAT, "BTW Verlegd" in the description
//   VAT21   the unit's Final Purchase Price (ex. VAT), high VAT
// Any other VAT type: nothing is booked (Make had no route for it).

import { config } from "../config.js";
import { getRecord } from "../services/airtable.js";
import { getState } from "../services/automationState.js";

export const MAKE_HOOK_URL = "https://hook.eu2.make.com/cmq6wlbq5sa9spmwogy4pdordvjzuz4i";
const STATE_NAME = "hook:purchase-expense";
const MODES = new Set(["Make", "Test", "Live"]);

const ROMPSLOMP = "https://app.rompslomp.nl/api/v1/companies/1296508534";
const VOORRAAD_SCOUT = 1981496874;
const VAT_NONE = 688369464;
const VAT_HIGH = 701184043;

const T = {
  uol: "tblFdnvcyttZyGx0b",
  inventoryUnits: "tblt1aavfuJgspt8x",
  sellers: "tblHXvGz5aRaw93jB",
  memberWtbs: "tblPIj8O7e1dabZxn",
};

const first = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => {
  const x = first(v);
  return x == null ? "" : String(x).trim();
};

const results = [];
export function purchaseExpenseResults() {
  return results;
}
function remember(entry) {
  results.unshift({ at: new Date().toISOString(), ...entry });
  results.length = Math.min(results.length, 25);
}

async function readMode() {
  const value = text(await getState(STATE_NAME).catch(() => null));
  return MODES.has(value) ? value : "Make";
}

async function rompslomp(path, { method = "GET", body } = {}) {
  const response = await fetch(`${ROMPSLOMP}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.rompslompToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const reply = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Rompslomp ${method} ${path.split("?")[0]} -> HTTP ${response.status} ${reply.slice(0, 300)}`);
  }
  return reply ? JSON.parse(reply) : {};
}

// YYYY-MM-DD, as Make's formatDate(...; "YYYY-MM-DD").
export function expenseDate(value) {
  const s = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = s ? new Date(s) : new Date();
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(
    Number.isNaN(d.getTime()) ? new Date() : d
  );
}

// Make's VAT number rule: a company's VAT ID without its country code gets it
// in front; a private seller has none.
export function supplierContact(sf) {
  const company = text(sf["Company Name"]);
  const country = text(sf["Country Code"]);
  const vat = text(sf["VAT ID"]).replace(/\s+/g, "");
  const vatNumber = !company
    ? ""
    : vat && country && !vat.toUpperCase().includes(country.toUpperCase())
    ? `${country}${vat}`
    : vat;

  return {
    contact: {
      is_individual: !company,
      is_supplier: true,
      company_name: company,
      contact_person_name: text(sf["Full Name"]),
      contact_person_email_address: text(sf.Email),
      address: text(sf.Address),
      zipcode: text(sf.Zipcode),
      city: text(sf.City),
      government_identification_number: null,
      country_code: country,
      kvk_number: "",
      phone: null,
      vat_number: vatNumber,
      contact_number: text(sf["Seller ID"]),
      free_1: text(sf["Payout Info"]),
      free_2: text(sf.Discord),
      free_3: null,
    },
  };
}

export function expenseBody({ payload, vatType, price, contactId }) {
  const reverseCharge = vatType === "VAT0";
  return {
    expense: {
      date: expenseDate(payload.purchase_date),
      state: "published",
      type_account_id: 1506,
      currency: "eur",
      contact_id: contactId,
      invoice_lines: [
        {
          description: `Purchase Order ${text(payload.ticket_number)}`,
          extended_description:
            `${text(payload.product_name)} - ${text(payload.size)}` +
            (reverseCharge ? "\n\n BTW Verlegd" : ""),
          price_per_unit: String(price),
          vat_rate: "",
          vat_type_id: vatType === "VAT21" ? VAT_HIGH : VAT_NONE,
          quantity: "1.0",
          product_id: null,
          account_id: VOORRAAD_SCOUT,
          account_path: "activa.current_assets.voorraad_scout_custom",
        },
      ],
    },
  };
}

// The unit whose ex-VAT price a VAT21 purchase books. Make read the first
// linked unit of the order or the Member WTB; the payload names the unit
// itself, which is right also when an order has more than one.
async function vat21Price(payload, notes) {
  const isMwtb = text(payload.order_id).includes("MWTB");
  let unitId = text(payload.inventory_unit_record_id);

  const parentId = isMwtb ? text(payload.member_wtb_record_id) : text(payload.order_record_id);
  if (parentId) {
    const parent = await getRecord(config.mainBaseId, isMwtb ? T.memberWtbs : T.uol, parentId);
    const makeUnit = text(parent?.fields?.["Linked Inventory Unit"]);
    if (!unitId) unitId = makeUnit;
    else if (makeUnit && makeUnit !== unitId) {
      notes.push(`Make would have read unit ${makeUnit}; the engine reads ${unitId} from the payload`);
    }
  }
  if (!unitId) throw new Error("VAT21 without an Inventory Unit to read the ex-VAT price from");

  const unit = await getRecord(config.mainBaseId, T.inventoryUnits, unitId);
  const price = Number(first(unit?.fields?.["Final Purchase Price (ex. VAT)"]));
  if (!Number.isFinite(price)) throw new Error(`Unit ${unitId} has no Final Purchase Price (ex. VAT)`);
  // Unrounded, as Make sent it: 111.57025 ex. VAT is exactly 135.00 with VAT.
  return price;
}

// Works out the booking; books it when live.
export async function bookPurchaseExpense(payload, { live }) {
  const notes = [];
  const vatType = text(payload.vat_type);
  if (!["Margin", "VAT0", "VAT21"].includes(vatType)) {
    return { booked: false, skipped: `VAT type "${vatType}" has no route (as in Make)` };
  }
  if (!config.rompslompToken) throw new Error("ROMPSLOMP_API_TOKEN is not set on this service");

  const sellerRecordId = text(payload.seller_record_id);
  const seller = sellerRecordId ? await getRecord(config.mainBaseId, T.sellers, sellerRecordId) : null;
  if (!seller) throw new Error(`Seller ${sellerRecordId || "(none)"} not found`);
  const sf = seller.fields || {};
  const sellerId = text(sf["Seller ID"]);
  if (!sellerId) throw new Error(`Seller ${sellerRecordId} has no Seller ID`);

  const price = vatType === "VAT21" ? await vat21Price(payload, notes) : Number(payload.purchase_price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`No purchase price (${payload.purchase_price})`);

  // The supplier: the contact whose contact number is the Seller ID.
  const search = await rompslomp(
    `/contacts?selection=suppliers&search[q]=${encodeURIComponent(sellerId)}&page=1&per_page=50`
  );
  const contacts = search.contacts || [];
  const match = contacts.find((c) => text(c.contact_number) === sellerId);
  if (!match && contacts.length) {
    notes.push(`Rompslomp found ${contacts.length} contact(s) for ${sellerId} but none with that number; Make would have booked nothing`);
  }

  let contactId = match?.id;
  const newContact = match ? null : supplierContact(sf);
  if (!contactId) {
    if (live) {
      const made = await rompslomp("/contacts", { method: "POST", body: newContact });
      contactId = made.contact?.id;
      if (!contactId) throw new Error("Rompslomp made no contact id");
    } else {
      contactId = "(new supplier)";
    }
  }

  const body = expenseBody({ payload, vatType, price, contactId });
  let expenseId = null;
  if (live) {
    const made = await rompslomp("/expenses", { method: "POST", body });
    expenseId = made.expense?.id ?? null;
  }

  return {
    booked: live,
    expenseId,
    sellerId,
    supplier: match ? `existing contact ${match.id}` : "new supplier",
    ...(newContact && !live ? { newContact: { ...newContact.contact, free_1: newContact.contact.free_1 ? "(payout info)" : "" } } : {}),
    line: body.expense.invoice_lines[0],
    date: body.expense.date,
    notes,
  };
}

async function forwardToMake(payload) {
  const response = await fetch(MAKE_HOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Make hook -> HTTP ${response.status}`);
}

// The Express handler. Answers 200 once the call is safely with Make or
// booked here; 500 when neither happened.
export async function handlePurchaseExpense(req, res) {
  const payload = req.body || {};
  const ref = text(payload.ticket_number) || text(payload.order_id) || "?";
  const mode = await readMode();

  if (mode !== "Live") {
    try {
      await forwardToMake(payload);
    } catch (err) {
      console.error("[purchase-expense] forward to Make failed", ref, err.message);
      remember({ mode, ref, error: `forward to Make failed: ${err.message}` });
      return res.status(502).json({ ok: false, error: "forward to Make failed" });
    }
    res.json({ ok: true, mode, forwarded: true });

    if (mode === "Test") {
      try {
        remember({ mode, ref, plan: await bookPurchaseExpense(payload, { live: false }) });
      } catch (err) {
        remember({ mode, ref, error: err.message });
      }
    } else {
      remember({ mode, ref, forwarded: true });
    }
    return;
  }

  try {
    const result = await bookPurchaseExpense(payload, { live: true });
    console.log("[purchase-expense] booked", ref, result.expenseId, result.line?.price_per_unit);
    remember({ mode, ref, result });
    res.json({ ok: true, mode, ...result });
  } catch (err) {
    console.error("[purchase-expense] failed", ref, err.message);
    remember({ mode, ref, error: err.message, payload: { ...payload, airtable_fields: undefined } });
    res.status(500).json({ ok: false, error: err.message });
  }
}
