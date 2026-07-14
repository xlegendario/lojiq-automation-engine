import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

export async function getTracking(trackingNumber) {
  const params = new URLSearchParams({ tracking_numbers: trackingNumber });
  const url = `https://api.aftership.com/tracking/${config.aftershipVersion}/trackings?${params}`;
  const body = await fetchJson(url, {
    headers: {
      "Content-Type": "application/json",
      "as-api-key": config.aftershipKey,
    },
  });
  const trackings = body?.data?.trackings || [];
  if (!trackings.length) return null;
  return trackings.find(t => String(t.tracking_number) === String(trackingNumber)) || trackings[0];
}
