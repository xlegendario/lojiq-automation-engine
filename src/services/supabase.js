import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

function assertConfigured() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for this job"
    );
  }
}

// One row of store_listings for a Shopify variant of a merchant, or null.
// Same lookup as the Supabase "search rows" module in Make 6.1.2.
export async function findStoreListing({
  merchantRecordId,
  shopifyProductId,
  shopifyVariantId,
}) {
  assertConfigured();

  const params = new URLSearchParams({
    select:
      "shopify_product_id,shopify_variant_id,shopify_inventory_item_id," +
      "size,sku,stockx_product_name,brand,picture_url,match_risk_level",
    merchant_record_id: `eq.${merchantRecordId}`,
    shopify_product_id: `eq.${shopifyProductId}`,
    shopify_variant_id: `eq.${shopifyVariantId}`,
    limit: "1",
  });

  const rows = await fetchJson(
    `${config.supabaseUrl}/rest/v1/store_listings?${params}`,
    {
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
      },
    }
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
