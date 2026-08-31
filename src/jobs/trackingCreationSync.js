import pLimit from "p-limit";
import { config } from "../config.js";
import {
  listRecords,
  updateRecord,
} from "../services/airtable.js";
import {
  createTracking,
  getTracking,
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

// A want-to-buy ships like an order and carries the same three tracking
// fields. What it has instead of an order number is its own id, and there
// is no External Sales row behind it.
const MEMBER_WTB_CREATION_FIELDS = [
  "Member WTB ID",
  "Tracking Number",
  "Tracking URL",
  "Shipping Status",
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

    // Counted beside the order numbers rather than mixed into them, so a
    // run stays readable and the existing figures keep meaning what they
    // always meant.
    memberWtb: {
      checked: 0,
      wouldCreate: 0,
      created: 0,
      reusedExisting: 0,
      invalidTracking: 0,
    },

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

    // A second pass over the other table, deliberately not one query over
    // both: every write below has to know which table it belongs to, and
    // getting that wrong writes a want-to-buy's tracking onto an order.
    const memberWtbs = await listRecords(
      config.mainBaseId,
      config.memberWtbsTableId,
      {
        formula,
        fields: MEMBER_WTB_CREATION_FIELDS,
      }
    );

    await Promise.all(
      memberWtbs.map(record =>
        limit(async () => {
          summary.memberWtb.checked += 1;

          try {
            const outcome =
              await processMemberWtb(record);

            summary.memberWtb[outcome] += 1;
          } catch (error) {
            const errorInfo = {
              recordId: record.id,
              memberWtbId:
                record.fields["Member WTB ID"],
              trackingNumber:
                record.fields["Tracking Number"],
              message: error.message,
              status: error.status,
              response: error.body,
            };

            summary.errors.push(errorInfo);

            console.error(
              "[tracking-creation] " +
              "member wtb failed",
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

async function processMemberWtb(record) {
  const fields = record.fields;

  const rawTrackingNumber = String(
    fields["Tracking Number"] || ""
  ).trim();

  const isUps = rawTrackingNumber
    .toUpperCase()
    .startsWith("1Z");

  // Same two couriers the order side understands. Widening that is a
  // separate decision and belongs in one place, not two.
  const normalizedTrackingNumber = isUps
    ? rawTrackingNumber
    : rawTrackingNumber.match(/\d{14}/)?.[0];

  if (!normalizedTrackingNumber) {
    console.warn(
      "[tracking-creation] MEMBER WTB INVALID_TRACKING",
      auditMemberWtb(record, {
        rawTrackingNumber,
        carrierRoute: isUps ? "UPS" : "DPD",
      })
    );

    return "invalidTracking";
  }

  if (config.trackingCreationShadowMode) {
    console.log(
      "[tracking-creation] MEMBER WTB WOULD_CREATE",
      auditMemberWtb(record, {
        carrierRoute: isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
      })
    );

    return "wouldCreate";
  }

  let trackingUrl;
  let createdTrackingNumber = normalizedTrackingNumber;

  try {
    const tracking = await createTracking({
      trackingNumber: normalizedTrackingNumber,
      orderId: fields["Member WTB ID"],
      airtableRecordId: record.id,
    });

    createdTrackingNumber = String(
      tracking?.title ||
        tracking?.tracking_number ||
        normalizedTrackingNumber
    );

    trackingUrl = isUps
      ? tracking?.courier_tracking_link
      : buildDpdTrackingUrl(createdTrackingNumber);

    if (!trackingUrl) {
      throw new Error(
        "AfterShip created the tracking but returned no courier tracking link"
      );
    }
  } catch (error) {
    if (!isDuplicateTrackingError(error)) {
      throw error;
    }

    // AfterShip already knows this parcel, so this is an answer rather
    // than a failure - see resolveExistingTrackingUrl.
    const existingUrl = await resolveExistingTrackingUrl({
      trackingNumber: normalizedTrackingNumber,
      excludeRecordId: record.id,
      isUps
    });

    if (!existingUrl) {
      throw error;
    }

    trackingUrl = existingUrl;
  }

  await updateRecord(
    config.mainBaseId,
    config.memberWtbsTableId,
    record.id,
    {
      "Tracking Number": createdTrackingNumber,
      "Tracking URL": trackingUrl,
      "Shipping Status": "Pending",
    }
  );

  console.log(
    "[tracking-creation] MEMBER WTB CREATED",
    auditMemberWtb(record, {
      carrierRoute: isUps ? "UPS" : "DPD",
      createdTrackingNumber,
      trackingUrl,
    })
  );

  return "created";
}

// The same parcel can already be registered from either table, so both are
// asked. Returns the url that is already known, or "" when nothing is.
async function findExistingTrackingUrl(
  trackingNumber,
  excludeRecordId
) {
  const existingOrder = await findExistingTrackedOrder(
    trackingNumber,
    excludeRecordId
  );

  if (existingOrder?.fields?.["Tracking URL"]) {
    return existingOrder.fields["Tracking URL"];
  }

  const escaped = escapeFormulaString(trackingNumber);

  const records = await listRecords(
    config.mainBaseId,
    config.memberWtbsTableId,
    {
      formula:
        `AND({Tracking Number} = '${escaped}',` +
        `{Tracking URL} != "")`,
      fields: ["Tracking Number", "Tracking URL"],
    }
  );

  const other = records.find(r => r.id !== excludeRecordId);

  return other?.fields?.["Tracking URL"] || "";
}

function auditMemberWtb(record, extra = {}) {
  return {
    shadowMode:
      config.trackingCreationShadowMode,
    recordId: record.id,
    memberWtbId:
      record.fields["Member WTB ID"],
    trackingNumber:
      record.fields["Tracking Number"],
    ...extra,
  };
}

async function processOrder(order) {
  const fields = order.fields;

  /*
   * REMOVED - orders whose Shopify Order Number contained "Private" were
   * skipped here, carried over from the Make router this job replaced.
   * A private order ships like any other and its tracking number is just
   * as real: three valid UPS codes were sitting in the queue waiting for
   * a tracking they were never going to get, with no error anywhere to
   * say why. The counter below stays at zero rather than disappearing,
   * so the shape of the health report does not change.
   */

  const rawTrackingNumber = String(
    fields["Tracking Number"] || ""
  ).trim();

  const isUps = rawTrackingNumber
    .toUpperCase()
    .startsWith("1Z");

  /*
   * Make behavior:
   * UPS -> volledig trackingnummer
   * Niet-UPS / DPD -> eerste reeks van exact 14 cijfers
   */
  const normalizedTrackingNumber = isUps
    ? rawTrackingNumber
    : rawTrackingNumber.match(/\d{14}/)?.[0];

  if (!normalizedTrackingNumber) {
    console.warn(
      "[tracking-creation] INVALID_TRACKING",
      audit(order, {
        rawTrackingNumber,
        carrierRoute: isUps ? "UPS" : "DPD",
      })
    );

    return "invalidTracking";
  }

  if (config.trackingCreationShadowMode) {
    console.log(
      "[tracking-creation] WOULD_CREATE",
      audit(order, {
        carrierRoute: isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
      })
    );

    return "wouldCreate";
  }

  try {
    const tracking = await createTracking({
      trackingNumber: normalizedTrackingNumber,
      orderId: fields["Order ID"],
      airtableRecordId: order.id,
    });

    const createdTrackingNumber = String(
      tracking?.title ||
        tracking?.tracking_number ||
        normalizedTrackingNumber
    );

    const trackingUrl = isUps
      ? tracking?.courier_tracking_link
      : buildDpdTrackingUrl(createdTrackingNumber);

    if (!trackingUrl) {
      throw new Error(
        "AfterShip created the tracking but returned no courier tracking link"
      );
    }

    await applyTracking(order, {
      trackingNumber: createdTrackingNumber,
      trackingUrl,
    });

    console.log(
      "[tracking-creation] CREATED",
      audit(order, {
        carrierRoute: isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
        createdTrackingNumber,
        trackingUrl,
      })
    );

    return "created";
  } catch (error) {
    // Only fall back when AfterShip actually says this tracking already
    // exists; anything else is a real failure and stays one.
    if (!isDuplicateTrackingError(error)) {
      throw error;
    }

    const existingTrackingUrl = await resolveExistingTrackingUrl({
      trackingNumber: normalizedTrackingNumber,
      excludeRecordId: order.id,
      isUps
    });

    if (!existingTrackingUrl) {
      throw error;
    }

    await applyTracking(order, {
      trackingNumber: normalizedTrackingNumber,
      trackingUrl: existingTrackingUrl,
    });

    console.log(
      "[tracking-creation] REUSED_EXISTING",
      audit(order, {
        carrierRoute: isUps ? "UPS" : "DPD",
        normalizedTrackingNumber,
        sourceRecordId: existing.id,
        trackingUrl: existingTrackingUrl,
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

/*
 * Where a parcel AfterShip already knows can be tracked.
 *
 * Airtable is asked first: if another record registered this parcel, its
 * link is the one to copy, and nothing has to be fetched.
 *
 * That used to be the only question, which made one state permanent: the
 * tracking exists at AfterShip but no record here carries the url yet.
 * Every run then got "already exists", found nothing to copy, and gave up
 * - so the parcel could never be written anywhere. MWTB-000402 and
 * MWTB-000404 sat there, and ORD-022404 had been stuck that way for five
 * days.
 *
 * So AfterShip is asked too. It is the one saying the parcel exists, so it
 * is also the one that can say where it lives. A DPD link is built from
 * the number itself and needs no call at all.
 */
async function resolveExistingTrackingUrl({
  trackingNumber,
  excludeRecordId,
  isUps
}) {
  const fromAirtable = await findExistingTrackingUrl(
    trackingNumber,
    excludeRecordId
  );

  if (fromAirtable) return fromAirtable;

  if (!isUps) {
    return buildDpdTrackingUrl(trackingNumber);
  }

  const existing = await getTracking(trackingNumber)
    .catch(() => null);

  return existing?.courier_tracking_link || "";
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
