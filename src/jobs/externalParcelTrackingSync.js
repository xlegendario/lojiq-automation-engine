/*
 * External Sales parcels at AfterShip (block 6 of the External Sales plan,
 * 22-09-2026).
 *
 * The third pass of the same idea the other two jobs do for store orders and
 * Member WTBs, but the parcels do not live in Airtable: an External Sale can
 * go out in several boxes, and those sit in Supabase. The engine does not
 * talk to Supabase - the Lojiq portal owns that - so this job asks the portal
 * which parcels still need watching, reads AfterShip, and posts back what it
 * found. The portal decides what that means: a parcel on its way, a deal
 * delivered once its last box arrived, a problem someone has to look at.
 *
 * UPS and DPD for now, which is what goes out; AfterShip works out the
 * carrier from the number itself, so a third one needs nothing here.
 */

import pLimit from "p-limit";

import { config } from "../config.js";
import {
  createTracking,
  getTracking,
} from "../services/aftership.js";
import { fetchJson } from "../utils/http.js";

let running = false;

export async function runExternalParcelTrackingSync(
  { source = "scheduler" } = {}
) {
  if (
    !config.engineEnabled ||
    !config.externalParcelsEnabled
  ) {
    return { skipped: true, reason: "disabled" };
  }

  if (!config.lojiqPortalBaseUrl || !config.lojiqPortalSecret) {
    return { skipped: true, reason: "portal-not-configured" };
  }

  if (running) return { skipped: true, reason: "already-running" };

  running = true;
  const startedAt = new Date();

  const summary = {
    source,
    shadowMode: config.externalParcelsShadowMode,
    checked: 0,
    inTransit: 0,
    delivered: 0,
    exception: 0,
    unchanged: 0,
    registered: 0,
    deliveredDeals: [],
    errors: [],
  };

  try {
    const { parcels = [] } = await portal("/tracking/open", {
      limit: config.externalParcelsBatchSize,
    });

    const limit = pLimit(config.concurrency);
    const updates = [];

    await Promise.all(parcels.map(parcel => limit(async () => {
      summary.checked += 1;

      try {
        const tracking = await getTracking(parcel.tracking_number);

        // Not at AfterShip yet: register it, and read it next run. The
        // portal notes the attempt so this parcel goes to the back of the
        // queue instead of being asked about again straight away.
        if (!tracking) {
          if (config.externalParcelsShadowMode) {
            summary.registered += 1;
            console.log("[external-parcels] WOULD REGISTER", audit(parcel));
            return;
          }

          let created = null;
          let note = "";

          try {
            created = await createTracking({
              trackingNumber: parcel.tracking_number,
              orderId: parcel.deal,
              airtableRecordId: parcel.id,
            });
          } catch (error) {
            // Four deals from before this shared one tracking number, and
            // AfterShip keeps one tracking per number: the second one is a
            // refusal, not a failure. Read it next run like any other.
            if (!isAlreadyThere(error)) {
              note = `AfterShip refused this number: ${
                error.body?.meta?.message || error.message
              }`.slice(0, 300);

              summary.errors.push({
                parcelId: parcel.id,
                deal: parcel.deal,
                trackingNumber: parcel.tracking_number,
                message: error.message,
                status: error.status,
                response: error.body?.meta || error.body,
              });

              console.error("[external-parcels] not registered", summary.errors.at(-1));
            }
          }

          // Even a refusal is written down, so this parcel goes to the back
          // of the queue instead of being the first thing asked every hour.
          await portal("/tracking/registered", {
            id: parcel.id,
            aftership_id: created?.id || "",
            note,
          });

          if (!note) {
            summary.registered += 1;
            console.log("[external-parcels] REGISTERED", audit(parcel));
          }

          return;
        }

        const status = STATUS_BY_TAG[tracking.tag] || "pending";

        if (status === parcel.status) {
          summary.unchanged += 1;
        } else if (status === "delivered") {
          summary.delivered += 1;
        } else if (status === "in_transit") {
          summary.inTransit += 1;
        } else if (status === "exception") {
          summary.exception += 1;
        } else {
          summary.unchanged += 1;
        }

        updates.push({
          id: parcel.id,
          status,
          carrier: tracking.slug || "",
          aftership_id: tracking.id || "",
          shipped_at: firstDate(
            tracking.shipment_pickup_date,
            tracking.checkpoints?.[0]?.checkpoint_time
          ),
          delivered_at:
            status === "delivered"
              ? firstDate(
                  tracking.shipment_delivery_date,
                  tracking.checkpoints?.at(-1)?.checkpoint_time
                )
              : "",
          detail:
            status === "exception"
              ? String(
                  tracking.checkpoints?.at(-1)?.message ||
                  tracking.subtag_message ||
                  tracking.tag ||
                  ""
                ).slice(0, 300)
              : "",
        });
      } catch (error) {
        summary.errors.push({
          parcelId: parcel.id,
          deal: parcel.deal,
          trackingNumber: parcel.tracking_number,
          message: error.message,
          status: error.status,
        });

        console.error("[external-parcels] parcel failed", summary.errors.at(-1));
      }
    })));

    if (updates.length && !config.externalParcelsShadowMode) {
      const result = await portal("/tracking/update", { updates });
      summary.deliveredDeals = result.delivered || [];

      if (result.unknown?.length) {
        console.warn("[external-parcels] parcels the portal does not know", result.unknown);
      }
    }

    console.log("[external-parcels] updates", {
      shadowMode: config.externalParcelsShadowMode,
      count: updates.length,
      delivered: summary.deliveredDeals,
    });

    return {
      ...summary,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  } finally {
    running = false;
  }
}

// AfterShip's tag to what the parcel is doing. The portal knows the same
// four words; anything AfterShip adds later reads as "pending" until it is
// given a meaning here.
const STATUS_BY_TAG = {
  Pending: "pending",
  InfoReceived: "pending",
  InTransit: "in_transit",
  OutForDelivery: "in_transit",
  AvailableForPickup: "in_transit",
  Delivered: "delivered",
  AttemptFail: "exception",
  Exception: "exception",
  Expired: "exception",
};

// AfterShip has this number already - its own, or one of ours under another
// parcel. Either way there is nothing to create.
function isAlreadyThere(error) {
  const meta = error?.body?.meta || {};
  const message = String(meta.message || error?.message || "").toLowerCase();

  return (
    error?.status === 409 ||
    meta.code === 4003 ||
    message.includes("already exists") ||
    message.includes("already tracked")
  );
}

async function portal(path, body) {
  return fetchJson(
    `${config.lojiqPortalBaseUrl}/api/internal/external-sales${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-kc-secret": config.lojiqPortalSecret,
      },
      body: JSON.stringify(body || {}),
    },
    { retries: 2, timeoutMs: 30000 }
  );
}

function firstDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return "";
}

function audit(parcel) {
  return {
    shadowMode: config.externalParcelsShadowMode,
    parcelId: parcel.id,
    deal: parcel.deal,
    trackingNumber: parcel.tracking_number,
    previousStatus: parcel.status,
  };
}
