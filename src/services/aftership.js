import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

const MIN_REQUEST_INTERVAL_MS = 220;
const MAX_RATE_LIMIT_RETRIES = 4;

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;

export async function getTracking(
  trackingNumber
) {
  return queueAfterShipRequest(async () => {
    const params = new URLSearchParams({
      tracking_numbers: trackingNumber,
    });

    const url =
      `https://api.aftership.com/tracking/` +
      `${config.aftershipVersion}/trackings?${params}`;

    const body =
      await requestWithRateLimitRetry(url, {
        headers: afterShipHeaders(),
      });

    const trackings =
      body?.data?.trackings || [];

    return (
      trackings.find(
        item =>
          String(item.tracking_number) ===
          String(trackingNumber)
      ) ||
      trackings[0] ||
      null
    );
  });
}

export async function createTracking({
  trackingNumber,
  orderId,
  airtableRecordId,
}) {
  return queueAfterShipRequest(async () => {
    const url =
      `https://api.aftership.com/tracking/` +
      `${config.aftershipVersion}/trackings`;

    const body =
      await requestWithRateLimitRetry(url, {
        method: "POST",
        headers: afterShipHeaders(),
        body: JSON.stringify({
          tracking_number: trackingNumber,
          order_id: orderId,
          custom_fields: {
            airtable_record_id:
              airtableRecordId,
          },
        }),
      });

    return body?.data || null;
  });
}

function afterShipHeaders() {
  return {
    "Content-Type": "application/json",
    "as-api-key": config.aftershipKey,
  };
}

function queueAfterShipRequest(handler) {
  const queuedRequest =
    requestQueue.then(async () => {
      const elapsed =
        Date.now() - lastRequestStartedAt;

      const waitMs = Math.max(
        0,
        MIN_REQUEST_INTERVAL_MS - elapsed
      );

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      lastRequestStartedAt = Date.now();

      return handler();
    });

  requestQueue = queuedRequest.catch(
    () => undefined
  );

  return queuedRequest;
}

async function requestWithRateLimitRetry(
  url,
  options
) {
  let lastError;

  for (
    let attempt = 0;
    attempt <= MAX_RATE_LIMIT_RETRIES;
    attempt += 1
  ) {
    try {
      return await fetchJson(
        url,
        options,
        {
          retries: 2,
          timeoutMs: 20000,
        }
      );
    } catch (error) {
      lastError = error;

      if (
        error.status !== 429 ||
        attempt === MAX_RATE_LIMIT_RETRIES
      ) {
        throw error;
      }

      const waitMs =
        getRateLimitWaitMs(
          error,
          attempt
        );

      console.warn(
        `[aftership] rate limited; ` +
        `retrying in ${waitMs}ms ` +
        `(attempt ${attempt + 1}/` +
        `${MAX_RATE_LIMIT_RETRIES})`
      );

      await sleep(waitMs);
    }
  }

  throw lastError;
}

function getRateLimitWaitMs(
  error,
  attempt
) {
  const resetAt =
    error?.body?.meta?.message?.match(
      /reset at ([0-9TZ:.-]+)/i
    )?.[1];

  if (resetAt) {
    const resetTime =
      Date.parse(resetAt);

    if (Number.isFinite(resetTime)) {
      return Math.max(
        1000,
        resetTime - Date.now() + 500
      );
    }
  }

  return Math.min(
    10000,
    1000 * 2 ** attempt
  );
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}
