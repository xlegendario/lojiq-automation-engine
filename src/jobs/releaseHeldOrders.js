import { config } from "../config.js";
import { listRecords, updateRecord } from "../services/airtable.js";

let running = false;

const RELEASE_FIELDS = [
  "Order ID",
  "Store Name",
  "Fulfillment Status",
  "Client Order Hold Hours",
  "Created Time",
];

/*
 * Releasing orders that were held for the store.
 *
 * Some stores keep no stock of their own and get a window to check an order
 * against their shelves before we act on it. Until that window is over
 * autoAllocateBestUnit leaves the order alone: nothing is allocated and the
 * status stays "Pending", which keeps the order out of Quick Deals, out of
 * Want To Buys and out of the Make embeds - all three read the same
 * "Outsource" status.
 *
 * WHY THIS JOB IS IN THIS REPO AND NOT THE OTHER ONE:
 *
 * airtable-automation-engine has no clock. It only reacts to what Airtable
 * pushes to its /webhook, so an order that is waiting has nothing to wait
 * FOR. This repo already had a scheduler, a health endpoint and a shadow
 * mode, so the clock lives here rather than being built a second time over
 * there.
 *
 * The cost is worth naming: "when does an order go to Outsource" is now
 * decided in two places - normally by autoAllocateBestUnit, and for a store
 * with a hold by this job. Both sides carry a comment pointing at the other.
 *
 * This job does exactly one thing: set Fulfillment Status to "Outsource"
 * once the window has passed. That write goes through the API, Airtable
 * sends a change event for it like any other, and because "Fulfillment
 * Status" is one of autoAllocateBestUnit's watched fields the order lands
 * back there by the normal route - past its window this time, so it runs
 * for real. The stamp that would have stopped it (auto_allocate_attempted_at)
 * was deliberately never written while the order was held.
 *
 * The two services are therefore not wired together. They meet in Airtable.
 *
 * The window is measured from Created Time, which is when the order landed
 * in our base.
 */
export async function runReleaseHeldOrders({ source = "scheduler" } = {}) {
  if (!config.engineEnabled || !config.releaseHeldOrdersEnabled) {
    return { skipped: true, reason: "disabled" };
  }

  if (running) {
    return { skipped: true, reason: "already-running" };
  }

  running = true;

  const startedAt = new Date();

  const summary = {
    source,
    shadowMode: config.releaseHeldOrdersShadowMode,
    checked: 0,
    released: 0,
    wouldRelease: 0,
    stillHolding: 0,
    errors: [],
  };

  try {
    /*
     * The formula only narrows down to "held and not yet released". The
     * clock itself is compared in JavaScript rather than with NOW() and
     * DATEADD over a lookup: that expression is easy to get subtly wrong
     * against an array-valued field, and getting it wrong here means
     * releasing an order early - the one thing this job exists to prevent.
     *
     * The set it walks is tiny: only orders from stores that have a hold,
     * and only while they are still Pending.
     */
    // "> 0" rather than "!= BLANK()". A lookup onto an empty number field
    // is not blank to Airtable - it answers 0 - so the blank test matched
    // every Pending order in the base, 78 of them, none of which has a hold
    // at all. The JS check below would still have refused to release them,
    // but the job would have walked the whole table every five minutes for
    // nothing.
    //
    // The last two conditions mirror autoAllocateBestUnit's own shouldRun,
    // and they matter more than they look. This job must only ever release
    // an order that would have gone to Outsource by itself - the hold is a
    // delay, not a second route into the sellers' lists.
    //
    // A "High" or "Medium" risk order waits for someone to check the SKU
    // match, and it waits whether or not its store has a hold. Without this
    // it would have been pushed out after the window on its own, which is
    // exactly the review this base exists to force. Caught on the very
    // first live test: ORD-022601 came in as High.
    //
    // auto_allocate_attempted_at means the automation has already had its
    // turn and deliberately left the order where it is. Releasing that
    // would be overruling it.
    const formula =
      `AND(` +
      `{Fulfillment Status} = 'Pending',` +
      `{Client Order Hold Hours} > 0,` +
      `{Match Risk Level} = 'Low',` +
      `{auto_allocate_attempted_at} = BLANK()` +
      `)`;

    const orders = await listRecords(config.mainBaseId, config.uolTableId, {
      formula,
      fields: RELEASE_FIELDS,
    });

    for (const order of orders) {
      summary.checked += 1;

      try {
        const f = order.fields;

        const holdHours = Number(
          Array.isArray(f["Client Order Hold Hours"])
            ? f["Client Order Hold Hours"][0]
            : f["Client Order Hold Hours"]
        );

        const createdAt = Date.parse(f["Created Time"]);

        // A hold of zero is not a hold. Anything unreadable is treated the
        // same way: leave the order where it is and let a human look,
        // rather than guess and release something too early.
        if (!Number.isFinite(holdHours) || holdHours <= 0 || !Number.isFinite(createdAt)) {
          summary.stillHolding += 1;
          continue;
        }

        const releasesAt = createdAt + holdHours * 60 * 60 * 1000;

        if (Date.now() < releasesAt) {
          summary.stillHolding += 1;
          continue;
        }

        if (config.releaseHeldOrdersShadowMode) {
          summary.wouldRelease += 1;

          console.log("[release-held] WOULD_RELEASE", audit(order, { holdHours, releasesAt }));
          continue;
        }

        await updateRecord(config.mainBaseId, config.uolTableId, order.id, {
          "Fulfillment Status": "Outsource",
        });

        summary.released += 1;

        console.log("[release-held] RELEASED", audit(order, { holdHours, releasesAt }));
      } catch (error) {
        const errorInfo = {
          recordId: order.id,
          orderId: order.fields["Order ID"],
          message: error.message,
          status: error.status,
          response: error.body,
        };

        summary.errors.push(errorInfo);

        console.error("[release-held] record failed", errorInfo);
      }
    }

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

function audit(order, { holdHours, releasesAt }) {
  return {
    shadowMode: config.releaseHeldOrdersShadowMode,
    recordId: order.id,
    orderId: order.fields["Order ID"],
    storeName: first(order.fields["Store Name"]),
    holdHours,
    createdTime: order.fields["Created Time"],
    releasesAt: new Date(releasesAt).toISOString(),
  };
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
