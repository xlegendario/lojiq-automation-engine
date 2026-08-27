import pLimit from "p-limit";
import { config } from "../config.js";
import { listRecords, getRecord, updateRecord } from "../services/airtable.js";
import { getTracking } from "../services/aftership.js";
import { sendDeliveredDiscord, sendItemShipped, sendMemberWtbDelivered } from "../services/notifications.js";
import { escapeFormulaString } from "../utils/http.js";

let running = false;

const ORDER_FIELDS = [
  "Order ID", "Store Name", "Shopify Order Number", "Product Name", "SKU", "Size", "Brand",
  "Tracking Number", "Tracking URL", "Shipping Status", "Linked Seller ID", "Linked Inventory Unit",
  "Linked Item ID", "Picture", "Record ID"
];

// A want-to-buy has no store and no Shopify order; it has a buyer and its
// own number. Same three tracking fields though, which is why the whole
// job applies at all.
const MEMBER_WTB_FIELDS = [
  "Member WTB ID", "Product Name", "SKU", "Size", "Brand",
  "Tracking Number", "Tracking URL", "Shipping Status",
  "Fulfillment Status", "Buyer Seller ID", "Payment Status", "Picture"
];

// Both passes ask the same question, so they ask it in the same words.
const TRACKING_FORMULA =
  `AND({Tracking Number} != "",{Tracking URL} != "",` +
  `OR({Shipping Status} = "Pending",{Shipping Status} = "Shipped"))`;

export async function runTrackingStatusSync({ source = "scheduler" } = {}) {
  if (!config.engineEnabled || !config.trackingEnabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (running) return { skipped: true, reason: "already-running" };

  running = true;
  const startedAt = new Date();
  // The four numbers at the top still count orders and nothing else - they
  // are what the health endpoint has always reported. Want-to-buys are
  // counted beside them rather than mixed in, so a run stays readable.
  const summary = {
    source, shadowMode: config.shadowMode, checked: 0, shipped: 0, delivered: 0, unchanged: 0,
    memberWtb: { checked: 0, shipped: 0, delivered: 0, unchanged: 0 },
    errors: []
  };

  try {
    const orders = await listRecords(config.mainBaseId, config.uolTableId, {
      formula: TRACKING_FORMULA,
      fields: ORDER_FIELDS
    });

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

    // A second pass, deliberately, rather than one query over both tables.
    // Merging them would mean every write from here on has to work out
    // which table it is in, and getting that wrong writes a want-to-buy's
    // status onto an order.
    const memberWtbs = await listRecords(config.mainBaseId, config.memberWtbsTableId, {
      formula: TRACKING_FORMULA,
      fields: MEMBER_WTB_FIELDS
    });

    await Promise.all(memberWtbs.map(record => limit(async () => {
      summary.memberWtb.checked += 1;
      try {
        const result = await processMemberWtb(record);
        summary.memberWtb[result] += 1;
      } catch (error) {
        summary.errors.push({
          recordId: record.id,
          memberWtbId: record.fields["Member WTB ID"],
          trackingNumber: record.fields["Tracking Number"],
          message: error.message,
          status: error.status,
          response: error.body,
        });
        console.error("[tracking-sync] member wtb failed", summary.errors.at(-1));
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

async function processMemberWtb(record) {
  const fields = record.fields;
  const tracking = await getTracking(fields["Tracking Number"]);
  const tag = tracking?.tag;

  if (tag === "InTransit" && fields["Shipping Status"] !== "Shipped") {
    if (!config.shadowMode) {
      await updateRecord(config.mainBaseId, config.memberWtbsTableId, record.id, {
        "Fulfillment Status": "Fulfilled",
        "Shipping Status": "Shipped",
      });
    }

    // No notification on shipped, on purpose. The order side posts to a
    // service that knows nothing about want-to-buys, and the buyer reads
    // "Shipped" in the portal anyway.
    console.log("[tracking-sync] MEMBER WTB SHIPPED", auditMemberWtb(record));
    return "shipped";
  }

  if (tag === "Delivered") {
    if (!config.shadowMode) {
      await updateRecord(config.mainBaseId, config.memberWtbsTableId, record.id, {
        "Fulfillment Status": "Fulfilled",
        "Shipping Status": "Delivered",
      });

      const buyer = await getFirstLinked(
        config.mainBaseId,
        config.sellersTableId,
        fields["Buyer Seller ID"]
      );

      await sendMemberWtbDelivered({ memberWtb: record, buyer });
    }

    console.log("[tracking-sync] MEMBER WTB DELIVERED", auditMemberWtb(record));
    return "delivered";
  }

  return "unchanged";
}

function auditMemberWtb(record) {
  return {
    shadowMode: config.shadowMode,
    recordId: record.id,
    memberWtbId: record.fields["Member WTB ID"],
    trackingNumber: record.fields["Tracking Number"],
    previousShippingStatus: record.fields["Shipping Status"],
  };
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
