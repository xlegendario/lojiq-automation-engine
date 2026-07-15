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

const app = express();

app.use(
  express.json({
    limit: "1mb",
  })
);

const lastRuns = {
  trackingStatus: null,
  trackingCreation: null,
  pendingIntake: null,
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
  };

  const selected = runners[job];

  if (!selected) {
    throw new Error(
      `Unknown automation job: ${job}`
    );
  }

  try {
    const result =
      await selected.runner({ source });

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
