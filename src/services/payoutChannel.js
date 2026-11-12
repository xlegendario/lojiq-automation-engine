// The seller's private payout channel for a confirmed deal (Make 12.2.1 and
// 12.3.2): the WTB bot makes the channel, the order keeps its id.
//
// The bot makes a new channel on every call, so a second call for the same
// order means a second channel for the seller. Before calling, the order is
// read again: a channel id or "Channel Created?" means it is done. Within
// this process a lock per order keeps two paths (the 12.2.1 watcher and the
// 12.3.2 hook) from calling at the same moment.

import { config } from "../config.js";
import { getRecord, updateRecord } from "./airtable.js";

const UOL = "tblFdnvcyttZyGx0b";
const F = {
  channelCreated: "fldY4GmaQO5nbzEOX", // Channel Created?
  channelId: "fldSkpxGsDIbgNisH", // WTB Created Channel ID
};
const URL = "https://discord-wtb-bot.onrender.com/payout-channel";

const busy = new Set();

const first = (v) => (Array.isArray(v) ? v[0] : v);

// body: what Make sent (orderId, productName, sku, size, brand, payout,
// sellerCode, imageUrl, discordUserId, vatType).
export async function openPayoutChannel(orderRecordId, body, { live }) {
  if (busy.has(orderRecordId)) return { opened: false, skipped: "another run is opening this channel" };
  busy.add(orderRecordId);
  try {
    const order = await getRecord(config.mainBaseId, UOL, orderRecordId);
    const f = order?.fields || {};
    if (f["Channel Created?"] || String(f["WTB Created Channel ID"] ?? "").trim()) {
      return { opened: false, skipped: `channel already there (${String(first(f["WTB Created Channel ID"]) ?? "") || "Channel Created?"})` };
    }
    if (!live) return { opened: false, wouldPost: body };

    const response = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const reply = await response.text().catch(() => "");
    const channelId = /"channelId":"(\d+)"/.exec(reply)?.[1];
    if (!response.ok || !channelId) {
      throw new Error(`payout-channel -> HTTP ${response.status} ${reply.slice(0, 200)}`);
    }
    await updateRecord(config.mainBaseId, UOL, orderRecordId, {
      [F.channelId]: channelId,
      [F.channelCreated]: true,
    });
    return { opened: true, channelId };
  } finally {
    busy.delete(orderRecordId);
  }
}
