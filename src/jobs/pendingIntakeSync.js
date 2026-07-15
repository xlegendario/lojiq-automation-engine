import pLimit from "p-limit";
import { config } from "../config.js";
import {
  createRecord,
  getRecord,
  listRecords,
  updateRecord,
} from "../services/airtable.js";
import { getShopifyOrder } from "../services/shopify.js";
import { escapeFormulaString } from "../utils/http.js";

let running = false;

const SPECIAL_CLIENT_ID = "recYPJ2d0pqJhrElT";

const EXCLUDED_STORES = new Set([
  "APLUG.PL",
  "SneakerAsk",
]);

const PENDING_FIELDS = [
  "Queued Order ID",
  "Store Name",
  "Shopify Order Number",
  "Product Name",
  "Match Risk Level",
  "Shopify Product Name",
  "SKU (Soft)",
  "Store Listings",
  "Size",
  "Brand",
  "Shopify Selling Price",
  "Order Date",
  "Picture",
  "Shopify Order ID",
  "Shopify Product ID",
  "Shopify Variant ID",
  "Client",
  "SKU Master Link",
  "Quantity",
  "Order Age (Hours)",
  "Order Taken?",
  "Payment Status",
];

export async function runPendingIntakeSync({
  source = "scheduler",
} = {}) {
  if (
    !config.engineEnabled ||
    !config.pendingIntakeEnabled
  ) {
    return {
      skipped: true,
      reason: "disabled",
    };
  }

  if (running) {
    return {
      skipped: true,
      reason: "already-running",
    };
  }

  running = true;

  const startedAt = new Date();

  const summary = {
    source,
    shadowMode: config.pendingIntakeShadowMode,
    checked: 0,
    notEligible: 0,
    skippedStore: 0,
    skippedKeyword: 0,
    merchantMissing: 0,
    variantNotFound: 0,
    unexpectedState: 0,
    wouldMarkStoreFulfilled: 0,
    wouldMoveToUol: 0,
    storeFulfilled: 0,
    movedToUol: 0,
    alreadyInUol: 0,
    errors: [],
  };

  try {
    const records = await listRecords(
      config.mainBaseId,
      config.pendingIntakeTableId,
      {
        formula: `{Order Taken?} = ""`,
        fields: PENDING_FIELDS,
      }
    );

    const limit = pLimit(
      config.pendingIntakeConcurrency
    );

    await Promise.all(
      records.map(record =>
        limit(async () => {
          summary.checked += 1;

          try {
            const outcome =
              await processRecord(record);

            summary[outcome] += 1;
          } catch (error) {
            const errorInfo = {
              recordId: record.id,
              queuedOrderId:
                record.fields["Queued Order ID"],
              shopifyOrderId:
                record.fields["Shopify Order ID"],
              shopifyVariantId:
                record.fields["Shopify Variant ID"],
              message: error.message,
              status: error.status,
              response: error.body,
            };

            summary.errors.push(errorInfo);

            console.error(
              "[pending-intake] record failed",
              errorInfo
            );
          }
        })
      )
    );

    return {
      ...summary,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs:
        Date.now() - startedAt.getTime(),
    };
  } finally {
    running = false;
  }
}

async function processRecord(record) {
  const fields = record.fields;
  const storeName =
    firstValue(fields["Store Name"]);

  if (EXCLUDED_STORES.has(storeName)) {
    console.log(
      "[pending-intake] SKIPPED_STORE",
      audit(record, { storeName })
    );

    return "skippedStore";
  }

  if (
    fields["Match Risk Level"] !== "Low" ||
    fields["Order Taken?"]
  ) {
    return "notEligible";
  }

  const clientId = firstValue(fields.Client);
  const orderAge = fields["Order Age (Hours)"];

  if (
    !isEligibleByAge({
      clientId,
      orderAge,
    })
  ) {
    return "notEligible";
  }

  if (!clientId) {
    console.warn(
      "[pending-intake] MERCHANT_MISSING",
      audit(record)
    );

    return "merchantMissing";
  }

  const merchant = await getRecord(
    config.mainBaseId,
    config.merchantsTableId,
    clientId
  );

  if (!merchant) {
    console.warn(
      "[pending-intake] MERCHANT_MISSING",
      audit(record, { clientId })
    );

    return "merchantMissing";
  }

  const skipKeyword =
    findMatchingSkipKeyword(
      fields["Shopify Product Name"],
      merchant.fields["Pending Intake Skip"]
    );

  if (skipKeyword) {
    if (config.pendingIntakeShadowMode) {
      console.log(
        "[pending-intake] WOULD_SKIP_KEYWORD_AND_MARK_TAKEN",
        audit(record, { skipKeyword })
      );
  
      return "skippedKeyword";
    }
  
    await updateRecord(
      config.mainBaseId,
      config.pendingIntakeTableId,
      record.id,
      {
        "Order Taken?": true,
        Notes: `Pending Intake Skipped: ${skipKeyword}`,
      }
    );
  
    console.log(
      "[pending-intake] SKIPPED_KEYWORD_AND_MARKED_TAKEN",
      audit(record, { skipKeyword })
    );
  
    return "skippedKeyword";
  }

  const shopifyOrder =
    await getShopifyOrder({
      storeUrl:
        merchant.fields["Shopify Store URL"],
      accessToken:
        merchant.fields["Shopify Token"],
      orderId:
        fields["Shopify Order ID"],
      apiVersion:
        config.shopifyApiVersion,
    });

  const targetVariantId = String(
    fields["Shopify Variant ID"] || ""
  );

  const lineItem =
    (shopifyOrder.line_items || []).find(
      item =>
        String(item.variant_id) ===
        targetVariantId
    );

  if (!lineItem) {
    console.warn(
      "[pending-intake] VARIANT_NOT_FOUND",
      audit(record, { targetVariantId })
    );

    return "variantNotFound";
  }

  const fulfillableQuantity = Number(
    lineItem.fulfillable_quantity
  );

  const hasFulfillmentStatus = Boolean(
    lineItem.fulfillment_status
  );

  if (
    hasFulfillmentStatus &&
    fulfillableQuantity === 0
  ) {
    if (config.pendingIntakeShadowMode) {
      console.log(
        "[pending-intake] " +
          "WOULD_MARK_STORE_FULFILLED",
        audit(record, {
          fulfillmentStatus:
            lineItem.fulfillment_status,
          fulfillableQuantity,
        })
      );

      return "wouldMarkStoreFulfilled";
    }

    await updateRecord(
      config.mainBaseId,
      config.pendingIntakeTableId,
      record.id,
      {
        "Order Taken?": true,
        Notes: "Store Fulfilled Order Item",
      }
    );

    console.log(
      "[pending-intake] STORE_FULFILLED",
      audit(record)
    );

    return "storeFulfilled";
  }

  if (
    !hasFulfillmentStatus &&
    fulfillableQuantity >= 1
  ) {
    if (config.pendingIntakeShadowMode) {
      console.log(
        "[pending-intake] WOULD_MOVE_TO_UOL",
        audit(record, {
          fulfillableQuantity,
        })
      );

      return "wouldMoveToUol";
    }

    const existingUol =
      await findExistingUol(fields);

    if (!existingUol) {
      await createRecord(
        config.mainBaseId,
        config.uolTableId,
        buildUolFields(record, merchant),
        {
          typecast: true,
        }
      );
    }

    await updateRecord(
      config.mainBaseId,
      config.pendingIntakeTableId,
      record.id,
      {
        "Order Taken?": true,
        Notes:
          "Store did not fulfill, so we fulfill",
      }
    );

    console.log(
      existingUol
        ? "[pending-intake] ALREADY_IN_UOL"
        : "[pending-intake] MOVED_TO_UOL",
      audit(record, {
        existingUolId:
          existingUol?.id || null,
      })
    );

    return existingUol
      ? "alreadyInUol"
      : "movedToUol";
  }

  console.warn(
    "[pending-intake] " +
      "UNEXPECTED_SHOPIFY_STATE",
    audit(record, {
      fulfillmentStatus:
        lineItem.fulfillment_status ?? null,
      fulfillableQuantity:
        lineItem.fulfillable_quantity,
    })
  );

  return "unexpectedState";
}

function isEligibleByAge({
  clientId,
  orderAge,
}) {
  if (
    String(orderAge)
      .trim()
      .toLowerCase() === "skipped queue"
  ) {
    return true;
  }

  const numericAge = Number(orderAge);

  if (!Number.isFinite(numericAge)) {
    return false;
  }

  return clientId === SPECIAL_CLIENT_ID
    ? numericAge >= 1
    : numericAge >= 48;
}

function parseSkipKeywords(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map(keyword =>
      keyword.trim().toLowerCase()
    )
    .filter(Boolean);
}

function findMatchingSkipKeyword(
  productName,
  configuredKeywords
) {
  const normalizedProductName = String(
    productName || ""
  ).toLowerCase();

  return parseSkipKeywords(
    configuredKeywords
  ).find(keyword =>
    normalizedProductName.includes(keyword)
  );
}

async function findExistingUol(fields) {
  const orderId = escapeFormulaString(
    fields["Shopify Order ID"] || ""
  );

  const variantId = escapeFormulaString(
    fields["Shopify Variant ID"] || ""
  );

  if (!orderId || !variantId) {
    return null;
  }

  const formula =
    `AND(` +
    `{Shopify Order ID} = '${orderId}',` +
    `{Shopify Variant ID} = '${variantId}'` +
    `)`;

  const records = await listRecords(
    config.mainBaseId,
    config.uolTableId,
    {
      formula,
      fields: [
        "Shopify Order ID",
        "Shopify Variant ID",
      ],
    }
  );

  return records[0] || null;
}

function buildUolFields(record, merchant) {
  const fields = record.fields;

  const uolFields = {
    "Shopify Order Number":
      fields["Shopify Order Number"],

    "Product Name":
      fields["Product Name"],

    "Shopify Product Name":
      fields["Shopify Product Name"],

    "Match Risk Level":
      fields["Match Risk Level"],

    "SKU (Soft)":
      fields["SKU (Soft)"],

    Size: fields.Size,
    Brand: fields.Brand,

    "Selling Price":
      fields["Shopify Selling Price"],

    "Order Date":
      fields["Order Date"],

    "Fulfillment Status": "Pending",

    "Payment Status":
      fields["Payment Status"],

    "Shopify Order ID":
      fields["Shopify Order ID"],

    "Shopify Product ID":
      fields["Shopify Product ID"],

    "Shopify Variant ID":
      fields["Shopify Variant ID"],

    Client: [merchant.id],

    "SKU Master Link":
      asRecordIdArray(
        fields["SKU Master Link"]
      ),

    Quantity: fields.Quantity,

    "Store Listings":
      asRecordIdArray(
        fields["Store Listings"]
      ),

    "Order Source": "Shopify",

    "Automation Engine Enabled": true,
  };

  const picture =
    firstAttachment(fields.Picture);

  if (picture?.url) {
    uolFields.Picture = [
      {
        url: picture.url,
        ...(picture.filename
          ? {
              filename:
                picture.filename,
            }
          : {}),
      },
    ];
  }

  return removeUndefined(uolFields);
}

function firstValue(value) {
  return Array.isArray(value)
    ? value[0]
    : value;
}

function firstAttachment(value) {
  return Array.isArray(value)
    ? value[0]
    : null;
}

function asRecordIdArray(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  return value
    ? [value]
    : undefined;
}

function removeUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, fieldValue]) =>
        fieldValue !== undefined
    )
  );
}

function audit(record, extra = {}) {
  return {
    shadowMode:
      config.pendingIntakeShadowMode,

    recordId: record.id,

    queuedOrderId:
      record.fields["Queued Order ID"],

    shopifyOrderId:
      record.fields["Shopify Order ID"],

    shopifyVariantId:
      record.fields["Shopify Variant ID"],

    storeName:
      firstValue(
        record.fields["Store Name"]
      ),

    ...extra,
  };
}
