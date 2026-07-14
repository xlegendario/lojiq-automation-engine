import express from "express";
import cron from "node-cron";
import { config } from "./config.js";
import { runTrackingStatusSync } from "./jobs/trackingStatusSync.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

let lastRun = null;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    engineEnabled: config.engineEnabled,
    trackingEnabled: config.trackingEnabled,
    shadowMode: config.shadowMode,
    lastRun,
  });
});

app.post("/jobs/tracking-status-sync/run", async (req, res) => {
  if (config.manualToken && req.headers.authorization !== `Bearer ${config.manualToken}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await runAndStore("manual");
  res.status(result?.skipped ? 409 : 200).json(result);
});

cron.schedule(config.trackingCron, () => void runAndStore("scheduler"), { timezone: "UTC" });

app.listen(config.port, () => {
  console.log(`[engine] listening on ${config.port}`);
  console.log(`[engine] tracking schedule=${config.trackingCron} UTC shadowMode=${config.shadowMode}`);
  if (config.runOnStart) void runAndStore("startup");
});

async function runAndStore(source) {
  try {
    const result = await runTrackingStatusSync({ source });
    lastRun = result;
    console.log("[tracking-sync] finished", result);
    return result;
  } catch (error) {
    lastRun = { source, failedAt: new Date().toISOString(), error: error.message };
    console.error("[tracking-sync] fatal", error);
    return lastRun;
  }
}
