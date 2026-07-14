function bool(name, fallback = false) {
  const value = process.env[name];

  if (value == null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(
    value.toLowerCase()
  );
}

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}`
    );
  }

  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),

  engineEnabled: bool(
    "AUTOMATION_ENGINE_ENABLED",
    true
  ),

  runOnStart: bool(
    "RUN_ON_START",
    false
  ),

  manualToken:
    process.env.MANUAL_TRIGGER_TOKEN || "",

  // Existing tracking status sync
  trackingEnabled: bool(
    "TRACKING_SYNC_ENABLED",
    true
  ),

  shadowMode: bool(
    "SHADOW_MODE",
    true
  ),

  trackingCron:
    process.env.TRACKING_SYNC_CRON ||
    "0 * * * *",

  concurrency: Math.max(
    1,
    Number(
      process.env.TRACKING_SYNC_CONCURRENCY || 3
    )
  ),

  // New tracking creation sync
  // Defaults intentionally remain safe.
  trackingCreationEnabled: bool(
    "TRACKING_CREATION_ENABLED",
    false
  ),

  trackingCreationShadowMode: bool(
    "TRACKING_CREATION_SHADOW_MODE",
    true
  ),

  trackingCreationCron:
    process.env.TRACKING_CREATION_CRON ||
    "*/5 * * * *",

  trackingCreationConcurrency: Math.max(
    1,
    Number(
      process.env
        .TRACKING_CREATION_CONCURRENCY || 3
    )
  ),

  // Airtable
  airtableToken: required("AIRTABLE_TOKEN"),

  mainBaseId:
    process.env.AIRTABLE_MAIN_BASE_ID ||
    "appHoMBqKDPnVfWJY",

  uolTableId:
    process.env.AIRTABLE_UOL_TABLE_ID ||
    "tblFdnvcyttZyGx0b",

  sellersTableId:
    process.env.AIRTABLE_SELLERS_TABLE_ID ||
    "tblHXvGz5aRaw93jB",

  inventoryUnitsTableId:
    process.env
      .AIRTABLE_INVENTORY_UNITS_TABLE_ID ||
    "tblt1aavfuJgspt8x",

  externalBaseId:
    process.env.AIRTABLE_EXTERNAL_BASE_ID ||
    "appY9ZV7HJMYQbLUA",

  externalSalesTableId:
    process.env
      .AIRTABLE_EXTERNAL_SALES_TABLE_ID ||
    "tbloLumvktySBlOvM",

  // AfterShip
  aftershipKey: required(
    "AFTERSHIP_API_KEY"
  ),

  aftershipVersion:
    process.env.AFTERSHIP_API_VERSION ||
    "2026-01",

  // Existing outbound notifications
  itemShippedWebhookUrl:
    process.env.ITEM_SHIPPED_WEBHOOK_URL ||
    "",

  deliveredDiscordWebhookUrl:
    process.env
      .DELIVERED_DISCORD_WEBHOOK_URL || "",
};
