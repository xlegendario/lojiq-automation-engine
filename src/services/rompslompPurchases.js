// The purchase of a pair, booked in Rompslomp the way every Make scenario
// did it (9.1, 10.x, 12.3.1, 12.2.1): Payout by Kickz Caviar B.V., one
// expense line on Voorraad | Scout (custom), with the seller as supplier.
//
// Per VAT type:
//   Margin  no VAT
//   VAT0    no VAT, "BTW Verlegd" under the description
//   VAT21   high VAT, on the price ex. VAT

import { config } from "../config.js";

const ROMPSLOMP = "https://app.rompslomp.nl/api/v1/companies/1296508534";
const VOORRAAD_SCOUT = 1981496874;
export const VAT_NONE = 688369464;
export const VAT_HIGH = 701184043;
export const VAT_TYPES = ["Margin", "VAT0", "VAT21"];

const first = (v) => (Array.isArray(v) ? v[0] : v);
const text = (v) => {
  const x = first(v);
  return x == null ? "" : String(x).trim();
};

export async function rompslomp(path, { method = "GET", body } = {}) {
  if (!config.rompslompToken) throw new Error("ROMPSLOMP_API_TOKEN is not set on this service");
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

// Make's supplier: a company whose VAT ID lacks the country code gets it in
// front; a private seller has no VAT number.
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

// The supplier contact for a seller: the one whose contact number is the
// Seller ID, made when there is none. Not live: nothing is made.
export async function ensureSupplier(sellerFields, { live, notes = [] } = {}) {
  const sellerId = text(sellerFields["Seller ID"]);
  if (!sellerId) throw new Error("The seller has no Seller ID");

  const search = await rompslomp(
    `/contacts?selection=suppliers&search[q]=${encodeURIComponent(sellerId)}&page=1&per_page=50`
  );
  const contacts = search.contacts || [];
  const match = contacts.find((c) => text(c.contact_number) === sellerId);
  if (match) return { contactId: match.id, supplier: `existing contact ${match.id}` };

  if (contacts.length) {
    notes.push(`Rompslomp found ${contacts.length} contact(s) for ${sellerId} but none with that number; Make would have booked nothing`);
  }
  const body = supplierContact(sellerFields);
  if (!live) {
    return {
      contactId: "(new supplier)",
      supplier: "new supplier",
      newContact: { ...body.contact, free_1: body.contact.free_1 ? "(payout info)" : "" },
    };
  }
  const made = await rompslomp("/contacts", { method: "POST", body });
  const contactId = made.contact?.id;
  if (!contactId) throw new Error("Rompslomp made no contact id");
  return { contactId, supplier: `new supplier ${contactId}` };
}

// date "" lets Rompslomp take today, as the Make scenarios that make a unit
// did; 9.1 sent the purchase date.
export function expenseBody({ ticket, productName, size, vatType, price, contactId, date = "" }) {
  return {
    expense: {
      date,
      state: "published",
      type_account_id: 1506,
      currency: "eur",
      contact_id: contactId,
      invoice_lines: [
        {
          description: `Purchase Order ${text(ticket)}`,
          extended_description:
            `${text(productName)} - ${text(size)}` + (vatType === "VAT0" ? "\n\n BTW Verlegd" : ""),
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

// Supplier + expense. price is what the line books (ex. VAT for VAT21).
export async function bookPurchase({ sellerFields, ticket, productName, size, vatType, price, date = "" }, { live }) {
  const notes = [];
  if (!VAT_TYPES.includes(vatType)) {
    return { booked: false, skipped: `VAT type "${vatType}" has no route (as in Make)`, notes };
  }
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) throw new Error(`No purchase price (${price})`);

  const supplier = await ensureSupplier(sellerFields, { live, notes });
  const body = expenseBody({ ticket, productName, size, vatType, price, contactId: supplier.contactId, date });
  let expenseId = null;
  if (live) {
    const made = await rompslomp("/expenses", { method: "POST", body });
    expenseId = made.expense?.id ?? null;
  }
  return {
    booked: live,
    expenseId,
    sellerId: text(sellerFields["Seller ID"]),
    supplier: supplier.supplier,
    ...(supplier.newContact ? { newContact: supplier.newContact } : {}),
    line: body.expense.invoice_lines[0],
    date: body.expense.date,
    notes,
  };
}
