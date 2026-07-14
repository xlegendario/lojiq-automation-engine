import pLimit from "p-limit";
import { config } from "../config.js";
import {
  listRecords,
  updateRecord,
} from "../services/airtable.js";
import {
  createTracking,
} from "../services/aftership.js";
import {
  escapeFormulaString,
} from "../utils/http.js";

let running = false;

const CREATION_FIELDS = [
  "Order ID",
  "Shopify Order Number",
  "Tracking Number",
  "Tracking URL",
  "Shipping Status",
  "Shipping Label",
];

export async function runTrackingCreationSync({
  source = "scheduler",
} = {}) {
  if (
    !config.engineEnabled ||
    !config.trackingCreationEnabled
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
      config.trackingCreationShadowMode,
    checked: 0,
    wouldCreate: 0,
    created: 0,
    reusedExisting: 0,
    skippedPrivate: 0,
    invalidTracking: 0,
    errors: [],
  };

  try {
    /*
     * Exact Make eligibility formula:
     *
     * Tracking Number is filled
     * Shipping Status is blank
     *
     * Make used Ready To Ship Timestamp as
     * its watch cursor, but it was not part
     * of the actual filter formula.
     */
    const formula =
      `AND(` +
      `{Tracking Number} != "",` +
      `{Shipping Status} = ""` +
      `)`;

    const orders = await listRecords(
      config.mainBaseId,
      config.uolTableId,
      {
        formula,
        fields: CREATION_FIELDS,
      }
    );

    const limit = pLimit(
      config.trackingCreationConcurrency
    );

    await Promise.all(
      orders.map(order =>
        limit(async () => {
          summary.checked += 1;

          try {
            const outcome =
              await processOrder(order);

            summary[outcome] += 1;
          } catch (error) {
            const errorInfo = {
              recordId: order.id,
              orderId:
                order.fields["Order ID"],
              trackingNumber:
                order.fields[
                  "Tracking Number"
                ],
              message: error.message,
              status: error.status,
              response: error.body,
            };

            summary.errors.push(
              errorInfo
            );

            console.error(
              "[tracking-creation] " +
              "record failed",
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

async function processOrder(order) {
  const fields = order.fields;

  const shopifyOrderNumber =
    String(
      fields[
        "Shopify Order Number"
      ] || ""
    );

  // Exact Make router:
  // Shopify Order Number must not contain
  // "Private".
  if (
    shopifyOrderNumber.includes(
      "Private"
    )
  ) {
    console.log(
      "[tracking-creation] " +
      "SKIPPED_PRIVATE",
      audit(order)
    );

    return "skippedPrivate";
  }

  const rawTrackingNumber =
    String(
      fields["Tracking Number"] || ""
    ).trim();

  const isUps =
    rawTrackingNumber
      .toUpperCase()
      .startsWith("1Z");

  /*
   * Make behavior:
   * UPS -> full number
   * non-UPS / DPD -> first exact
   * 14-digit sequence.
   */
  const normalizedTrackingNumber =
    isUps
      ? rawTrackingNumber
      : rawTrackingNumber.match(
          /\d{14}/
        )?.[0];

  if (!normalizedTrackingNumber) {
    console.warn(
      "[tracking-creation] " +
      "INVALID_TRACKING",
      audit(order, {
        rawTrackingNumber,
        carrierRoute:
          isUps ? "UPS" : "DPD",
      })
    );

    return "invalidTracking";
  }

  if (
    config.trackingCreationShadowMode
  ) {
    console.log(
      "[tracking-creation] " +
      "WOULD_CREATE",
      audit(order, {
        carrierRoute:
          isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
      })
    );

    return "wouldCreate";
  }

  try {
    const tracking =
      await createTracking({
        trackingNumber:
          normalizedTrackingNumber,
        orderId:
          fields["Order ID"],
        airtableRecordId:
          order.id,
      });

    const createdTrackingNumber =
      String(
        tracking?.title ||
        tracking?.tracking_number ||
        normalizedTrackingNumber
      );

    const trackingUrl =
      isUps
        ? tracking
            ?.courier_tracking_link
        : buildDpdTrackingUrl(
            createdTrackingNumber
          );

    if (!trackingUrl) {
      throw new Error(
        "AfterShip created the " +
        "tracking but returned no " +
        "courier tracking link"
      );
    }

    await applyTracking(order, {
      trackingNumber:
        createdTrackingNumber,
      trackingUrl,
    });

    console.log(
      "[tracking-creation] CREATED",
      audit(order, {
        carrierRoute:
          isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
        createdTrackingNumber,
        trackingUrl,
      })
    );

    return "created";
    } catch (error) {
    /*
     * Alleen de bestaande-trackingfallback uitvoeren
     * wanneer AfterShip daadwerkelijk meldt dat de
     * tracking al bestaat.
     *
     * Andere fouten, zoals 401, 422, 500 of een
     * netwerkfout, mogen niet als duplicate worden
     * behandeld.
     */
    if (!isDuplicateTrackingError(error)) {
      throw error;
    }
  
    const existing =
      await findExistingTrackedOrder(
        normalizedTrackingNumber,
        order.id
      );
  
    const existingTrackingUrl =
      existing?.fields?.["Tracking URL"];
  
    if (!existingTrackingUrl) {
      throw error;
    }
  
    await applyTracking(order, {
      trackingNumber:
        normalizedTrackingNumber,
      trackingUrl:
        existingTrackingUrl,
    });
  
    console.log(
      "[tracking-creation] REUSED_EXISTING",
      audit(order, {
        carrierRoute:
          isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
        sourceRecordId:
          existing.id,
        trackingUrl:
          existingTrackingUrl,
        duplicateErrorCode:
          error?.body?.meta?.code ?? null,
        duplicateErrorMessage:
          error?.body?.meta?.message ??
          error.message,
      })
    );
  
    return "reusedExisting";
  }
}

async function applyTracking(
  order,
  {
    trackingNumber,
    trackingUrl,
  }
) {
  const updatedOrder =
    await updateRecord(
      config.mainBaseId,
      config.uolTableId,
      order.id,
      {
        "Tracking Number":
          trackingNumber,
        "Tracking URL":
          trackingUrl,
        "Shipping Status":
          "Pending",
      }
    );

  const external =
    await findExternalSale(
      updatedOrder.fields[
        "Order ID"
      ]
    );

  if (!external) {
    return;
  }

  const externalFields = {
    "Tracking Number":
      updatedOrder.fields[
        "Tracking Number"
      ],
    "Tracking URL":
      updatedOrder.fields[
        "Tracking URL"
      ],
    "Shipping Status":
      "Pending",
  };

  const shippingLabel =
    firstAttachment(
      updatedOrder.fields[
        "Shipping Label"
      ]
    );

  if (shippingLabel?.url) {
    externalFields[
      "Shipping Label"
    ] = [
      {
        url: shippingLabel.url,
        ...(shippingLabel.filename
          ? {
              filename:
                shippingLabel.filename,
            }
          : {}),
      },
    ];
  }

  await updateRecord(
    config.externalBaseId,
    config.externalSalesTableId,
    external.id,
    externalFields
  );
}

async function findExistingTrackedOrder(
  trackingNumber,
  currentRecordId
) {
  const escapedTracking =
    escapeFormulaString(
      trackingNumber
    );

  const escapedRecordId =
    escapeFormulaString(
      currentRecordId
    );

  const formula =
    `AND(` +
    `{Tracking Number} = ` +
    `'${escapedTracking}',` +
    `{Shipping Status} != "",` +
    `RECORD_ID() != ` +
    `'${escapedRecordId}'` +
    `)`;

  const records =
    await listRecords(
      config.mainBaseId,
      config.uolTableId,
      {
        formula,
        fields: [
          "Tracking Number",
          "Tracking URL",
          "Shipping Status",
        ],
      }
    );

  return records[0] || null;
}

async function findExternalSale(
  orderId
) {
  if (!orderId) {
    return null;
  }

  const escapedOrderId =
    escapeFormulaString(orderId);

  const formula =
    `{Order Number} = ` +
    `'${escapedOrderId}'`;

  const records =
    await listRecords(
      config.externalBaseId,
      config.externalSalesTableId,
      {
        formula,
        fields: [
          "Order Number",
          "Tracking Number",
          "Tracking URL",
          "Shipping Status",
          "Shipping Label",
        ],
      }
    );

  return records[0] || null;
}

function isDuplicateTrackingError(error) {
  const metaCode = Number(
    error?.body?.meta?.code
  );

  const message = String(
    error?.body?.meta?.message ||
    error?.message ||
    ""
  );

  return (
    metaCode === 4003 ||
    /tracking already exists/i.test(message)
  );
}

function buildDpdTrackingUrl(
  trackingNumber
) {
  return (
    "https://www.dpdgroup.com/" +
    "nl/mydpd/my-parcels/" +
    "incoming?parcelNumber=" +
    encodeURIComponent(
      trackingNumber
    )
  );
}

function firstAttachment(value) {
  return Array.isArray(value)
    ? value[0]
    : null;
}

function audit(
  order,
  extra = {}
) {
  return {
    shadowMode:
      config.trackingCreationShadowMode,
    recordId: order.id,
    orderId:
      order.fields["Order ID"],
    shopifyOrderNumber:
      order.fields[
        "Shopify Order Number"
      ],
    trackingNumber:
      order.fields[
        "Tracking Number"
      ],
    ...extra,
  };
}
