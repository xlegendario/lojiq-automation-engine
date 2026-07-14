import pLimit from "p-limit";
import { config } from "../config.js";
import { listRecords, getRecord, updateRecord } from "../services/airtable.js";
import { getTracking } from "../services/aftership.js";
import { sendDeliveredDiscord, sendItemShipped } from "../services/notifications.js";
import { escapeFormulaString } from "../utils/http.js";

let running = false;

const ORDER_FIELDS = [
  "Order ID", "Store Name", "Shopify Order Number", "Product Name", "SKU", "Size", "Brand",
  "Tracking Number", "Tracking URL", "Shipping Status", "Linked Seller ID", "Linked Inventory Unit",
  "Linked Item ID", "Picture", "Record ID"
];

export async function runTrackingStatusSync({ source = "scheduler" } = {}) {
  if (!config.engineEnabled || !config.trackingEnabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (running) return { skipped: true, reason: "already-running" };

  running = true;
  const startedAt = new Date();
  const summary = { source, shadowMode: config.shadowMode, checked: 0, shipped: 0, delivered: 0, unchanged: 0, errors: [] };

  try {
    const formula = `AND({Tracking Number} != "",{Tracking URL} != "",OR({Shipping Status} = "Pending",{Shipping Status} = "Shipped"))`;
    const orders = await listRecords(config.mainBaseId, config.uolTableId, { formula, fields: ORDER_FIELDS });
    const limit = pLimit(config.concurrency);

    await Promise.all(orders.map(order => limit(async () => {
      summary.checked += 1;
      try {
        const result = await processOrder(order);
        summary[result] += 1;
      } catch (error) {
        summary.errors.push({
          recordId: order.id,
          orderId: order.fields["Order ID"],
          trackingNumber: order.fields["Tracking Number"],
          message: error.message,
          status: error.status,
          response: error.body,
        });
        console.error("[tracking-sync] record failed", summary.errors.at(-1));
      }
    })));

    return {
      ...summary,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    };
  } finally {
    running = false;
  }
}

async function processOrder(order) {
  const fields = order.fields;
  const tracking = await getTracking(fields["Tracking Number"]);
  const tag = tracking?.tag;

  if (tag === "InTransit" && fields["Shipping Status"] !== "Shipped") {
    await handleShipped(order);
    return "shipped";
  }

  if (tag === "Delivered") {
    await handleDelivered(order);
    return "delivered";
  }

  return "unchanged";
}

async function handleShipped(order) {
  if (!config.shadowMode) {
    await updateRecord(config.mainBaseId, config.uolTableId, order.id, {
      "Fulfillment Status": "Fulfilled",
      "Shipping Status": "Shipped",
    });
  }

  const external = await findExternalSale(order.fields["Order ID"]);
  if (external && !config.shadowMode) {
    await updateRecord(config.externalBaseId, config.externalSalesTableId, external.id, {
      "Shipping Status": "Shipped",
    });
  }

  // Make's second router route is unconditional, so this notification is always sent.
  if (!config.shadowMode) await sendItemShipped(order);

  console.log("[tracking-sync] SHIPPED", audit(order, { externalSaleId: external?.id || null }));
}

async function handleDelivered(order) {
  if (!config.shadowMode) {
    await updateRecord(config.mainBaseId, config.uolTableId, order.id, {
      "Fulfillment Status": "Fulfilled",
      "Shipping Status": "Delivered",
    });
  }

  const [external, seller, inventoryUnit] = await Promise.all([
    findExternalSale(order.fields["Order ID"]),
    getFirstLinked(config.mainBaseId, config.sellersTableId, order.fields["Linked Seller ID"]),
    getFirstLinked(config.mainBaseId, config.inventoryUnitsTableId, order.fields["Linked Inventory Unit"]),
  ]);

  // Make always executes its first delivered route, and additionally updates External Sales when found.
  if (!config.shadowMode) {
    await sendDeliveredDiscord({ order, seller, inventoryUnit });
    if (external) {
      await updateRecord(config.externalBaseId, config.externalSalesTableId, external.id, {
        "Shipping Status": "Delivered",
      });
    }
  }

  console.log("[tracking-sync] DELIVERED", audit(order, {
    externalSaleId: external?.id || null,
    sellerId: seller?.id || null,
    inventoryUnitId: inventoryUnit?.id || null,
  }));
}

async function findExternalSale(orderId) {
  if (!orderId) return null;
  const formula = `{Order Number} = '${escapeFormulaString(orderId)}'`;
  const records = await listRecords(config.externalBaseId, config.externalSalesTableId, {
    formula,
    fields: ["Order Number", "Shipping Status"],
  });
  return records[0] || null;
}

async function getFirstLinked(baseId, tableId, value) {
  const recordId = Array.isArray(value) ? value[0] : value;
  return recordId ? getRecord(baseId, tableId, recordId) : null;
}

function audit(order, extra) {
  return {
    shadowMode: config.shadowMode,
    recordId: order.id,
    orderId: order.fields["Order ID"],
    trackingNumber: order.fields["Tracking Number"],
    previousShippingStatus: order.fields["Shipping Status"],
    ...extra,
  };
}
