import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

export async function sendItemShipped(record) {
  if (!config.itemShippedWebhookUrl) return;
  const f = record.fields;
  await fetchJson(config.itemShippedWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      trigger_type: "item-shipped",
      store_name: first(f["Store Name"]),
      shopify_order_number: f["Shopify Order Number"] || "",
      product_name: f["Product Name"] || "",
      size: f.Size || "",
      sku: first(f.SKU),
      tracking_number: f["Tracking Number"] || "",
      tracking_url: f["Tracking URL"] || "",
      picture_url: first(f.Picture)?.url || "",
      record_id: f["Record ID"] || record.id,
    }),
  });
}

export async function sendDeliveredDiscord({ order, seller, inventoryUnit }) {
  if (!config.deliveredDiscordWebhookUrl) return;
  const f = order.fields;
  const linkedItemId = first(f["Linked Item ID"]) || first(inventoryUnit?.fields?.["Item ID"]) || "";
  const consignment = String(linkedItemId).includes("CS-");
  const sellerLabel = consignment
    ? { name: "Seller Name:", value: seller?.fields?.["Full Name"] || "Unknown" }
    : { name: "Seller Discord:", value: seller?.fields?.Discord || "Unknown" };

  await fetchJson(config.deliveredDiscordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: "📦 ITEM DELIVERED!",
        description: `**${f["Product Name"] || ""}**\n${first(f.SKU) || ""}\n${f.Size || ""}\n${f.Brand || ""}`,
        color: 16776960,
        fields: [
          { name: "Store:", value: first(f["Store Name"]) || "Unknown", inline: false },
          { name: "Order ID:", value: f["Order ID"] || "", inline: true },
          { name: "Shopify Order:", value: f["Shopify Order Number"] || "", inline: true },
          { name: "\u200B", value: "\u200B", inline: false },
          { ...sellerLabel, inline: true },
          { name: "Seller ID:", value: seller?.fields?.["Seller ID"] || "Unknown", inline: true },
          { name: "Payment Status:", value: inventoryUnit?.fields?.["Payment Status"] || "Unknown", inline: false },
        ],
      }],
    }),
  });
}

// The delivered embed for a Member WTB.
//
// A separate function rather than a branch inside sendDeliveredDiscord,
// because almost every line differs: there is no store, no Shopify order
// and no inventory unit here - there is a buyer and a want-to-buy number.
// Bending one embed around both would have left half its fields reading
// "Unknown".
//
// Only this one is sent. The shipped notification stays on the order side:
// it posts to a service that knows nothing about want-to-buys, and the
// buyer sees "Shipped" in the portal anyway.
export async function sendMemberWtbDelivered({ memberWtb, buyer }) {
  if (!config.deliveredDiscordWebhookUrl) return;

  const f = memberWtb.fields;

  await fetchJson(config.deliveredDiscordWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title: "📦 MEMBER WTB DELIVERED!",
        description: `**${f["Product Name"] || ""}**\n${first(f.SKU) || ""}\n${f.Size || ""}\n${f.Brand || ""}`,
        color: 16776960,
        fields: [
          { name: "Buyer:", value: buyer?.fields?.["Full Name"] || "Unknown", inline: false },
          { name: "Member WTB:", value: f["Member WTB ID"] || "", inline: true },
          { name: "Buyer ID:", value: buyer?.fields?.["Seller ID"] || "Unknown", inline: true },
          { name: "\u200B", value: "\u200B", inline: false },
          { name: "Payment Status:", value: f["Payment Status"] || "Unknown", inline: false },
        ],
      }],
    }),
  });
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
