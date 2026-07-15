import pLimit from "p-limit";

import { config } from "../config.js";

import {
  listRecords,
  updateRecord,
} from "../services/airtable.js";

import {
  getShopifyFulfillmentOrders,
  listShopifyOrdersUpdatedSince,
} from "../services/shopify.js";

import {
  escapeFormulaString,
} from "../utils/http.js";

let running = false;

const ACTIVE_FULFILLMENT_STATUSES = [
  "Pending",
  "Outsource",
  "Claim Processing",
  "StockX Processing",
  "GOAT Processing",
  "Confirmed",
];

const MERCHANT_FIELDS = [
  "Client ID",
  "Store Name",
  "Shopify Store URL",
  "Shopify Token",
  "Active?",
];

const UOL_FIELDS = [
  "Order ID",
  "Shopify Order ID",
  "Shopify Variant ID",
  "Fulfillment Status",
  "Client",
  "Created Time",
];

export async function runStoreFulfillmentSync({
  source = "scheduler",
} = {}) {
  if (
    !config.engineEnabled ||
    !config.storeFulfillmentEnabled
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
    shadowMode:
      config.storeFulfillmentShadowMode,

    merchantsFound: 0,
    merchantsChecked: 0,
    merchantErrors: 0,

    updatedOrdersFound: 0,
    ordersWithActiveUol: 0,
    fulfillmentOrdersChecked: 0,
    variantsChecked: 0,

    noMatchingUol: 0,
    variantNotFound: 0,
    cancelledFulfillmentOrder: 0,
    unchanged: 0,

    wouldMarkStoreFulfilled: 0,
    markedStoreFulfilled: 0,

    errors: [],

    lookbackMinutes:
      config.storeFulfillmentLookbackMinutes,
  };

  try {
    const merchants = await listRecords(
      config.mainBaseId,
      config.merchantsTableId,
      {
        formula:
          `AND(` +
          `{Active?} = 1,` +
          `{Store Name} != "SneakerAsk"` +
          `)`,

        fields: MERCHANT_FIELDS,
      }
    );

    summary.merchantsFound =
      merchants.length;

    const merchantLimit = pLimit(
      config.storeFulfillmentConcurrency
    );

    await Promise.all(
      merchants.map(merchant =>
        merchantLimit(async () => {
          try {
            const merchantResult =
              await processMerchant(
                merchant
              );

            summary.merchantsChecked += 1;

            summary.updatedOrdersFound +=
              merchantResult
                .updatedOrdersFound;

            summary.ordersWithActiveUol +=
              merchantResult
                .ordersWithActiveUol;

            summary
              .fulfillmentOrdersChecked +=
              merchantResult
                .fulfillmentOrdersChecked;

            summary.variantsChecked +=
              merchantResult.variantsChecked;

            summary.noMatchingUol +=
              merchantResult.noMatchingUol;

            summary.variantNotFound +=
              merchantResult.variantNotFound;

            summary
              .cancelledFulfillmentOrder +=
              merchantResult
                .cancelledFulfillmentOrder;

            summary.unchanged +=
              merchantResult.unchanged;

            summary
              .wouldMarkStoreFulfilled +=
              merchantResult
                .wouldMarkStoreFulfilled;

            summary
              .markedStoreFulfilled +=
              merchantResult
                .markedStoreFulfilled;
          } catch (error) {
            summary.merchantErrors += 1;

            const errorInfo = {
              merchantRecordId:
                merchant.id,

              clientId:
                merchant.fields[
                  "Client ID"
                ],

              storeName:
                merchant.fields[
                  "Store Name"
                ],

              message: error.message,
              status: error.status,
              response: error.body,
            };

            summary.errors.push(
              errorInfo
            );

            console.error(
              "[store-fulfillment] merchant failed",
              errorInfo
            );
          }
        })
      )
    );

    return {
      ...summary,

      startedAt:
        startedAt.toISOString(),

      finishedAt:
        new Date().toISOString(),

      durationMs:
        Date.now() -
        startedAt.getTime(),
    };
  } finally {
    running = false;
  }
}

async function processMerchant(merchant) {
  const result = {
    updatedOrdersFound: 0,
    ordersWithActiveUol: 0,
    fulfillmentOrdersChecked: 0,
    variantsChecked: 0,
    noMatchingUol: 0,
    variantNotFound: 0,
    cancelledFulfillmentOrder: 0,
    unchanged: 0,
    wouldMarkStoreFulfilled: 0,
    markedStoreFulfilled: 0,
  };

  const updatedAtMin =
    new Date(
      Date.now() -
        config
          .storeFulfillmentLookbackMinutes *
          60_000
    ).toISOString();

  const updatedOrders =
    await listShopifyOrdersUpdatedSince({
      storeUrl:
        merchant.fields[
          "Shopify Store URL"
        ],

      accessToken:
        merchant.fields[
          "Shopify Token"
        ],

      apiVersion:
        config.shopifyApiVersion,

      updatedAtMin,
    });

  result.updatedOrdersFound =
    updatedOrders.length;

  for (const shopifyOrder of updatedOrders) {
    const activeUolRecords =
      await findActiveUolRecords({
        merchantRecordId: merchant.id,
        shopifyOrderId:
          shopifyOrder.id,
      });

    if (!activeUolRecords.length) {
      result.noMatchingUol += 1;
      continue;
    }

    result.ordersWithActiveUol += 1;

    const fulfillmentOrders =
      await getShopifyFulfillmentOrders({
        storeUrl:
          merchant.fields[
            "Shopify Store URL"
          ],

        accessToken:
          merchant.fields[
            "Shopify Token"
          ],

        orderId:
          shopifyOrder.id,

        apiVersion:
          config.shopifyApiVersion,
      });

    result.fulfillmentOrdersChecked += 1;

    const variantGroups =
      groupUolRecordsByVariant(
        activeUolRecords
      );

    for (
      const variantGroup
      of variantGroups
    ) {
      result.variantsChecked += 1;

      const outcome =
        await processVariantGroup({
          merchant,
          shopifyOrder,
          fulfillmentOrders,
          variantGroup,
        });

      result.variantNotFound +=
        outcome.variantNotFound;

      result.cancelledFulfillmentOrder +=
        outcome
          .cancelledFulfillmentOrder;

      result.unchanged +=
        outcome.unchanged;

      result.wouldMarkStoreFulfilled +=
        outcome
          .wouldMarkStoreFulfilled;

      result.markedStoreFulfilled +=
        outcome.markedStoreFulfilled;
    }
  }

  return result;
}

async function findActiveUolRecords({
  merchantRecordId,
  shopifyOrderId,
}) {
  const escapedOrderId =
    escapeFormulaString(
      String(shopifyOrderId)
    );

  const statusFormula =
    ACTIVE_FULFILLMENT_STATUSES
      .map(
        status =>
          `{Fulfillment Status} = ` +
          `"${escapeFormulaString(status)}"`
      )
      .join(",");

  /*
   * We zoeken eerst op Shopify Order ID en status.
   *
   * Daarna controleren we de linked Client record-ID
   * in JavaScript. Daarmee zijn we niet afhankelijk van
   * de zichtbare "Client ID" primary-fieldwaarde.
   */
  const formula =
    `AND(` +
    `{Shopify Order ID} = "${escapedOrderId}",` +
    `OR(${statusFormula})` +
    `)`;

  const records = await listRecords(
    config.mainBaseId,
    config.uolTableId,
    {
      formula,
      fields: UOL_FIELDS,
    }
  );

  return records.filter(record => {
    const linkedClientIds =
      Array.isArray(
        record.fields.Client
      )
        ? record.fields.Client
        : [];

    return linkedClientIds.includes(
      merchantRecordId
    );
  });
}

async function processVariantGroup({
  merchant,
  shopifyOrder,
  fulfillmentOrders,
  variantGroup,
}) {
  const result = {
    variantNotFound: 0,
    cancelledFulfillmentOrder: 0,
    unchanged: 0,
    wouldMarkStoreFulfilled: 0,
    markedStoreFulfilled: 0,
  };

  const matchingLines =
    findMatchingFulfillmentLines({
      fulfillmentOrders,
      shopifyVariantId:
        variantGroup.shopifyVariantId,
    });

  if (!matchingLines.length) {
    console.warn(
      "[store-fulfillment] VARIANT_NOT_FOUND",
      {
        shadowMode:
          config
            .storeFulfillmentShadowMode,

        merchantRecordId:
          merchant.id,

        storeName:
          merchant.fields[
            "Store Name"
          ],

        shopifyOrderId:
          String(shopifyOrder.id),

        shopifyVariantId:
          variantGroup
            .shopifyVariantId,

        uolRecordIds:
          variantGroup.records.map(
            record => record.id
          ),
      }
    );

    result.variantNotFound += 1;

    return result;
  }

  const openLines =
    matchingLines.filter(
      match =>
        normalizeStatus(
          match.fulfillmentOrderStatus
        ) !== "closed"
    );

  const closedFullyFulfilledLines =
    matchingLines.filter(
      match =>
        normalizeStatus(
          match.fulfillmentOrderStatus
        ) === "closed" &&
        normalizeQuantity(
          match.lineItem
            .fulfillable_quantity
        ) === 0
    );

  const closedCancelledLines =
    matchingLines.filter(
      match =>
        normalizeStatus(
          match.fulfillmentOrderStatus
        ) === "closed" &&
        normalizeQuantity(
          match.lineItem
            .fulfillable_quantity
        ) > 0
    );

  /*
   * Make behandelt een gesloten fulfillment order
   * met fulfillable_quantity > 0 als een geannuleerde
   * fulfillment order en wijzigt dan niets.
   */
  if (
    !openLines.length &&
    !closedFullyFulfilledLines.length &&
    closedCancelledLines.length
  ) {
    console.log(
      "[store-fulfillment] CLOSED_CANCELLED",
      auditVariant({
        merchant,
        shopifyOrder,
        variantGroup,
        extra: {
          closedCancelledLines:
            closedCancelledLines.length,
        },
      })
    );

    result.cancelledFulfillmentOrder += 1;

    return result;
  }

  let remainingShopifyQuantity;

  if (openLines.length) {
    remainingShopifyQuantity =
      openLines.reduce(
        (total, match) =>
          total +
          normalizeQuantity(
            match.lineItem
              .fulfillable_quantity
          ),
        0
      );
  } else if (
    closedFullyFulfilledLines.length
  ) {
    remainingShopifyQuantity = 0;
  } else {
    console.warn(
      "[store-fulfillment] UNEXPECTED_FULFILLMENT_STATE",
      auditVariant({
        merchant,
        shopifyOrder,
        variantGroup,
      })
    );

    return result;
  }

  const activeUolCount =
    variantGroup.records.length;

  const excessRecordCount =
    Math.max(
      0,
      activeUolCount -
        remainingShopifyQuantity
    );

  if (excessRecordCount === 0) {
    console.log(
      "[store-fulfillment] UNCHANGED",
      auditVariant({
        merchant,
        shopifyOrder,
        variantGroup,
        extra: {
          activeUolCount,
          remainingShopifyQuantity,
        },
      })
    );

    result.unchanged +=
      activeUolCount;

    return result;
  }

  /*
   * We behouden de oudste actieve records en markeren
   * de nieuwste overtollige records.
   *
   * Voorbeeld:
   * 3 actieve UOL-records
   * Shopify quantity 1
   * → 2 nieuwste records Store Fulfilled
   * → 1 oudste record blijft actief
   */
  const recordsToMark = [
    ...variantGroup.records,
  ]
    .sort(compareNewestFirst)
    .slice(0, excessRecordCount);

  if (
    config.storeFulfillmentShadowMode
  ) {
    for (const record of recordsToMark) {
      console.log(
        "[store-fulfillment] WOULD_MARK_STORE_FULFILLED",
        auditRecord({
          merchant,
          shopifyOrder,
          record,
          extra: {
            activeUolCount,
            remainingShopifyQuantity,
            excessRecordCount,
          },
        })
      );
    }

    result.wouldMarkStoreFulfilled +=
      recordsToMark.length;

    return result;
  }

  /*
   * Bewust na elkaar uitvoeren.
   * Hiermee blijven Airtable-updates gecontroleerd
   * en eenvoudiger terug te lezen in de logs.
   */
  for (const record of recordsToMark) {
    await updateRecord(
      config.mainBaseId,
      config.uolTableId,
      record.id,
      {
        "Fulfillment Status":
          "Store Fulfilled",
      }
    );

    console.log(
      "[store-fulfillment] MARKED_STORE_FULFILLED",
      auditRecord({
        merchant,
        shopifyOrder,
        record,
        extra: {
          activeUolCount,
          remainingShopifyQuantity,
          excessRecordCount,
        },
      })
    );
  }

  result.markedStoreFulfilled +=
    recordsToMark.length;

  return result;
}

function findMatchingFulfillmentLines({
  fulfillmentOrders,
  shopifyVariantId,
}) {
  const targetVariantId =
    String(shopifyVariantId || "");

  const matches = [];

  for (
    const fulfillmentOrder
    of fulfillmentOrders
  ) {
    for (
      const lineItem
      of fulfillmentOrder.line_items || []
    ) {
      if (
        String(lineItem.variant_id) !==
        targetVariantId
      ) {
        continue;
      }

      matches.push({
        fulfillmentOrderId:
          fulfillmentOrder.id,

        fulfillmentOrderStatus:
          fulfillmentOrder.status,

        lineItem,
      });
    }
  }

  return matches;
}

function groupUolRecordsByVariant(
  records
) {
  const groups = new Map();

  for (const record of records) {
    const shopifyVariantId =
      String(
        record.fields[
          "Shopify Variant ID"
        ] || ""
      );

    if (!shopifyVariantId) {
      continue;
    }

    if (!groups.has(shopifyVariantId)) {
      groups.set(
        shopifyVariantId,
        {
          shopifyVariantId,
          records: [],
        }
      );
    }

    groups
      .get(shopifyVariantId)
      .records.push(record);
  }

  return [...groups.values()];
}

function normalizeQuantity(value) {
  const number = Number(value);

  if (
    !Number.isFinite(number) ||
    number < 0
  ) {
    return 0;
  }

  return number;
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function compareNewestFirst(a, b) {
  const timeA = Date.parse(
    a.fields["Created Time"] ||
      a.createdTime ||
      ""
  );

  const timeB = Date.parse(
    b.fields["Created Time"] ||
      b.createdTime ||
      ""
  );

  if (
    Number.isFinite(timeA) &&
    Number.isFinite(timeB)
  ) {
    return timeB - timeA;
  }

  return String(b.id).localeCompare(
    String(a.id)
  );
}

function auditVariant({
  merchant,
  shopifyOrder,
  variantGroup,
  extra = {},
}) {
  return {
    shadowMode:
      config.storeFulfillmentShadowMode,

    merchantRecordId:
      merchant.id,

    storeName:
      merchant.fields["Store Name"],

    shopifyOrderId:
      String(shopifyOrder.id),

    shopifyVariantId:
      variantGroup.shopifyVariantId,

    uolRecordIds:
      variantGroup.records.map(
        record => record.id
      ),

    previousStatuses:
      variantGroup.records.map(
        record =>
          record.fields[
            "Fulfillment Status"
          ]
      ),

    ...extra,
  };
}

function auditRecord({
  merchant,
  shopifyOrder,
  record,
  extra = {},
}) {
  return {
    shadowMode:
      config.storeFulfillmentShadowMode,

    recordId: record.id,

    orderId:
      record.fields["Order ID"],

    storeName:
      merchant.fields["Store Name"],

    shopifyOrderId:
      String(shopifyOrder.id),

    shopifyVariantId:
      record.fields[
        "Shopify Variant ID"
      ],

    previousFulfillmentStatus:
      record.fields[
        "Fulfillment Status"
      ],

    ...extra,
  };
}
