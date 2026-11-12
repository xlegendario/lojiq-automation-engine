import express from "express";
import cron from "node-cron";

import { config } from "./config.js";

import {
  runTrackingStatusSync,
} from "./jobs/trackingStatusSync.js";

import {
  runTrackingCreationSync,
} from "./jobs/trackingCreationSync.js";

import {
  runPendingIntakeSync,
} from "./jobs/pendingIntakeSync.js";

import {
  runStoreFulfillmentSync,
} from "./jobs/storeFulfillmentSync.js";

import {
  runReleaseHeldOrders,
} from "./jobs/releaseHeldOrders.js";

import {
  runExternalParcelTrackingSync,
} from "./jobs/externalParcelTrackingSync.js";

import {
  runOrderIntakeSync,
} from "./jobs/orderIntakeSync.js";

import {
  runMakeWatchers,
  watcherResults,
} from "./jobs/makeWatchers.js";

import {
  handlePurchaseExpense,
  purchaseExpenseResults,
} from "./jobs/purchaseExpenseHook.js";

const app = express();

// During a deploy Render keeps the old instance running until the new one
// is up, and a few deploys in a row stack up. On 11-11 three instances ran
// the 19:30 order intake together and each made the same UOL record. So a
// fresh instance waits a few minutes before it runs anything on its own,
// and an instance that is being replaced (SIGTERM) runs nothing new.
const bootedAt = Date.now();
const STARTUP_GRACE_MS = 3 * 60 * 1000;
let shuttingDown = false;

process.on("SIGTERM", () => {
  shuttingDown = true;
  console.log("[engine] SIGTERM: no new scheduled runs");
});

function mayRunUnattended() {
  return !shuttingDown && Date.now() - bootedAt >= STARTUP_GRACE_MS;
}

app.use(
  express.json({
    limit: "1mb",
  })
);

const lastRuns = {
  trackingStatus: null,
  trackingCreation: null,
  pendingIntake: null,
  storeFulfillment: null,
  releaseHeldOrders: null,
  externalParcels: null,
  orderIntake: null,
};

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      engineEnabled:
        config.engineEnabled,

      jobs: {
        trackingStatus: {
          enabled:
            config.trackingEnabled,
          shadowMode:
            config.shadowMode,
          schedule:
            config.trackingCron,
          lastRun:
            lastRuns.trackingStatus,
        },

        trackingCreation: {
          enabled:
            config
              .trackingCreationEnabled,
          shadowMode:
            config
              .trackingCreationShadowMode,
          schedule:
            config
              .trackingCreationCron,
          lastRun:
            lastRuns
              .trackingCreation,
        },

        pendingIntake: {
          enabled:
            config.pendingIntakeEnabled,

          shadowMode:
            config.pendingIntakeShadowMode,

          schedule:
            config.pendingIntakeCron,

          lastRun:
            lastRuns.pendingIntake,
        },

        storeFulfillment: {
          enabled:
            config
              .storeFulfillmentEnabled,

          shadowMode:
            config
              .storeFulfillmentShadowMode,

          schedule:
            config
              .storeFulfillmentCron,

          lookbackMinutes:
            config
              .storeFulfillmentLookbackMinutes,

          lastRun:
            lastRuns
              .storeFulfillment,
        },

        orderIntake: {
          enabled:
            config.orderIntakeEnabled,
          schedule:
            config.orderIntakeCron,
          stores:
            "per store in Merchants: Order Intake Automation",
          lastRun:
            lastRuns.orderIntake,
        },

        watchers: {
          // Switch per watcher in Airtable "Automation State":
          // watcher:<key> = Make / Test / Live.
          schedule: "*/5 * * * *",
          rompslompToken: Boolean(config.rompslompToken),
          results: watcherResults(),
        },

        hooks: {
          // Endpoints that replace Make webhooks. Switch per hook in
          // Automation State: hook:<key> = Make / Test / Live.
          keySet: Boolean(config.hooksKey),
          purchaseExpense: purchaseExpenseResults(),
        },

        externalParcels: {
          enabled:
            config
              .externalParcelsEnabled,

          shadowMode:
            config
              .externalParcelsShadowMode,

          schedule:
            config.externalParcelsCron,

          lastRun:
            lastRuns.externalParcels,
        },

        releaseHeldOrders: {
          enabled:
            config
              .releaseHeldOrdersEnabled,

          shadowMode:
            config
              .releaseHeldOrdersShadowMode,

          schedule:
            config
              .releaseHeldOrdersCron,

          lastRun:
            lastRuns
              .releaseHeldOrders,
        },
      },
    });
  }
);

// Make 9.1: the purchase expense of a consignment / Member WTB unit, called
// by the KC portal. The key travels in the URL, as Make's hook URL did.
function hookKey(req, res, next) {
  if (!config.hooksKey) {
    return res.status(503).json({ error: "ENGINE_HOOKS_KEY is not set" });
  }
  if (req.query.key !== config.hooksKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.post("/hooks/purchase-expense", hookKey, handlePurchaseExpense);

app.post(
  "/jobs/tracking-status-sync/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "trackingStatus",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

app.post(
  "/jobs/tracking-creation-sync/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "trackingCreation",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

app.post(
  "/jobs/pending-intake-sync/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "pendingIntake",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

app.post(
  "/jobs/store-fulfillment-sync/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "storeFulfillment",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

app.post(
  "/jobs/external-parcel-sync/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "externalParcels",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

app.post(
  "/jobs/release-held-orders/run",
  authorize,
  async (_req, res) => {
    const result =
      await runAndStore(
        "releaseHeldOrders",
        "manual"
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

// Order intake. A manual run takes ?dryRun=1 (decide, never write),
// ?compare=1 (also decide lines Make already imported and show what Make
// made of them), ?stores=a,b and ?lookbackMinutes=N.
app.post(
  "/jobs/order-intake/run",
  authorize,
  async (req, res) => {
    const flag = name =>
      ["1", "true", "yes"].includes(
        String(req.query[name] || "").toLowerCase()
      );

    const options = {
      dryRun: flag("dryRun"),
      compare: flag("compare"),
      stores: String(req.query.stores || "")
        .split(",")
        .map(value => value.trim().toLowerCase())
        .filter(Boolean),
      lookbackMinutes:
        Number(req.query.lookbackMinutes) || undefined,
    };

    const result =
      await runAndStore(
        "orderIntake",
        "manual",
        options
      );

    res
      .status(
        result?.skipped
          ? 409
          : 200
      )
      .json(result);
  }
);

// Watchers (former Make scenarios). ?only=key1,key2&force=1 runs them now.
app.post(
  "/jobs/watchers/run",
  authorize,
  async (req, res) => {
    const only = String(req.query.only || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const result = await runMakeWatchers({
      source: "manual",
      only: only.length ? only : undefined,
      force: ["1", "true"].includes(String(req.query.force || "")),
    });
    res.status(result?.skipped ? 409 : 200).json({ ...result, results: watcherResults() });
  }
);

cron.schedule(
  "*/5 * * * *",
  () => {
    if (!mayRunUnattended()) {
      console.log("[watchers] skipped: instance starting or stopping");
      return;
    }
    void runMakeWatchers({ source: "scheduler" }).catch(error =>
      console.error("[watchers] fatal", error)
    );
  },
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.orderIntakeCron,
  () =>
    void runAndStore(
      "orderIntake",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.trackingCron,
  () =>
    void runAndStore(
      "trackingStatus",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.trackingCreationCron,
  () =>
    void runAndStore(
      "trackingCreation",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.pendingIntakeCron,
  () =>
    void runAndStore(
      "pendingIntake",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.storeFulfillmentCron,
  () =>
    void runAndStore(
      "storeFulfillment",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.externalParcelsCron,
  () =>
    void runAndStore(
      "externalParcels",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

cron.schedule(
  config.releaseHeldOrdersCron,
  () =>
    void runAndStore(
      "releaseHeldOrders",
      "scheduler"
    ),
  {
    timezone: "UTC",
  }
);

app.listen(
  config.port,
  () => {
    console.log(
      `[engine] listening on ` +
      `${config.port}`
    );

    console.log(
      `[engine] tracking-status ` +
      `schedule=${config.trackingCron} ` +
      `UTC ` +
      `enabled=${config.trackingEnabled} ` +
      `shadowMode=${config.shadowMode}`
    );

    console.log(
      `[engine] tracking-creation ` +
      `schedule=` +
      `${config.trackingCreationCron} ` +
      `UTC ` +
      `enabled=` +
      `${config.trackingCreationEnabled} ` +
      `shadowMode=` +
      `${config.trackingCreationShadowMode}`
    );

    console.log(
      `[engine] pending-intake ` +
      `schedule=${config.pendingIntakeCron} ` +
      `UTC ` +
      `enabled=${config.pendingIntakeEnabled} ` +
      `shadowMode=${config.pendingIntakeShadowMode}`
    );

    console.log(
      `[engine] store-fulfillment ` +
      `schedule=` +
      `${config.storeFulfillmentCron} ` +
      `UTC ` +
      `lookbackMinutes=` +
      `${config.storeFulfillmentLookbackMinutes} ` +
      `enabled=` +
      `${config.storeFulfillmentEnabled} ` +
      `shadowMode=` +
      `${config.storeFulfillmentShadowMode}`
    );

    console.log(
      `[engine] external-parcels ` +
      `schedule=` +
      `${config.externalParcelsCron} ` +
      `UTC ` +
      `enabled=` +
      `${config.externalParcelsEnabled} ` +
      `shadowMode=` +
      `${config.externalParcelsShadowMode}`
    );

    if (config.runOnStart) {
      void runAndStore(
        "trackingStatus",
        "startup"
      );

      void runAndStore(
        "trackingCreation",
        "startup"
      );
      
      void runAndStore(
        "pendingIntake",
        "startup"
      );

      void runAndStore(
        "storeFulfillment",
        "startup"
      );

      void runAndStore(
        "releaseHeldOrders",
        "startup"
      );

      void runAndStore(
        "externalParcels",
        "startup"
      );
    }
  }
);

function authorize(
  req,
  res,
  next
) {
  if (
    config.manualToken &&
    req.headers.authorization !==
      `Bearer ${config.manualToken}`
  ) {
    return res
      .status(401)
      .json({
        error: "Unauthorized",
      });
  }

  next();
}

async function runAndStore(
  job,
  source,
  options = {}
) {
  const runners = {
    trackingStatus: {
      runner: runTrackingStatusSync,
      logName: "tracking-sync",
    },

    trackingCreation: {
      runner: runTrackingCreationSync,
      logName: "tracking-creation",
    },

    pendingIntake: {
      runner: runPendingIntakeSync,
      logName: "pending-intake",
    },

    storeFulfillment: {
      runner:
        runStoreFulfillmentSync,

      logName:
        "store-fulfillment",
    },

    releaseHeldOrders: {
      runner: runReleaseHeldOrders,
      logName: "release-held",
    },

    externalParcels: {
      runner:
        runExternalParcelTrackingSync,

      logName: "external-parcels",
    },

    orderIntake: {
      runner: runOrderIntakeSync,
      logName: "order-intake",
    },
  };

  const selected = runners[job];

  if (source !== "manual" && !mayRunUnattended()) {
    const result = {
      source,
      skipped: true,
      reason: shuttingDown ? "instance stopping" : "instance starting (deploy grace)",
    };
    console.log(`[${selected?.logName || job}] skipped`, result.reason);
    return result;
  }

  if (!selected) {
    throw new Error(
      `Unknown automation job: ${job}`
    );
  }

  try {
    const result =
      await selected.runner({ source, ...options });

    lastRuns[job] = result;

    console.log(
      `[${selected.logName}] finished`,
      result
    );

    return result;
  } catch (error) {
    const result = {
      source,
      failedAt:
        new Date().toISOString(),
      error: error.message,
    };

    lastRuns[job] = result;

    console.error(
      `[${selected.logName}] fatal`,
      error
    );

    return result;
  }
}
