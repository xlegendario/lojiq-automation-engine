import express from "express";
import cron from "node-cron";

import { config } from "./config.js";

import {
  runTrackingStatusSync,
} from "./jobs/trackingStatusSync.js";

import {
  runTrackingCreationSync,
} from "./jobs/trackingCreationSync.js";

const app = express();

app.use(
  express.json({
    limit: "1mb",
  })
);

const lastRuns = {
  trackingStatus: null,
  trackingCreation: null,
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
      },
    });
  }
);

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

    if (config.runOnStart) {
      void runAndStore(
        "trackingStatus",
        "startup"
      );

      void runAndStore(
        "trackingCreation",
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
  source
) {
  const isStatusJob =
    job === "trackingStatus";

  const runner =
    isStatusJob
      ? runTrackingStatusSync
      : runTrackingCreationSync;

  const logName =
    isStatusJob
      ? "tracking-sync"
      : "tracking-creation";

  try {
    const result =
      await runner({ source });

    lastRuns[job] = result;

    console.log(
      `[${logName}] finished`,
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
      `[${logName}] fatal`,
      error
    );

    return result;
  }
}
