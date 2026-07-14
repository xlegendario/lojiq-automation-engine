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

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
