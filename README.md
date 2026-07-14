# Lojiq Automation Engine

Central Node.js/Render replacement for Make scenarios. The first implemented job is **Tracking Status Sync**.

## Exact Make behavior reproduced

The job:

1. Reads UOL records where Tracking Number and Tracking URL are present and Shipping Status is Pending or Shipped.
2. Reads the linked seller.
3. Fetches the tracking from AfterShip.
4. When AfterShip returns `InTransit` and UOL is not already Shipped:
   - UOL Fulfillment Status -> Fulfilled
   - UOL Shipping Status -> Shipped
   - External Sales status -> Shipped when a matching Order Number exists
   - sends the existing `item-shipped` webhook
5. When AfterShip returns `Delivered`:
   - UOL Fulfillment Status -> Fulfilled
   - UOL Shipping Status -> Delivered
   - reads linked Inventory Unit
   - sends the delivered Discord embed
   - External Sales status -> Delivered when a matching Order Number exists

Make routers can execute multiple matching routes. The code intentionally preserves that:
- The item-shipped webhook is sent regardless of whether an External Sale exists.
- The delivered Discord webhook is sent, while an External Sale is additionally updated when found.

## Safety

Start with:

```env
SHADOW_MODE=true
RUN_ON_START=false
```

Shadow mode reads everything and logs decisions but performs no writes or notifications.

Run manually:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/jobs/tracking-status-sync/run   -H "Authorization: Bearer YOUR_MANUAL_TRIGGER_TOKEN"
```

Inspect `/health` and Render logs. Then set `SHADOW_MODE=false`.

## Security

The uploaded Make blueprint exposed an AfterShip API key and a Discord webhook URL. Rotate both before production. Store all secrets only in Render environment variables; never commit them to GitHub.

## Scheduling

`TRACKING_SYNC_CRON=*/5 * * * *` runs every five minutes in UTC. Change it independently from all future jobs.

## Why this saves Make tasks

Make currently creates one operation for most modules, for every matching record. This service can execute the same API calls without per-module Make operations. AfterShip and Airtable API usage still applies.

## Deployment

1. Create a private GitHub repository and upload these files.
2. Create a Render Web Service using `render.yaml`.
3. Add all variables from `.env.example`.
4. Keep shadow mode on for comparison.
5. Trigger manually.
6. Verify the same records Make changes.
7. Disable the Make schedule only after successful comparison.
8. Enable production mode and run manually once.
9. Enable the five-minute schedule.
