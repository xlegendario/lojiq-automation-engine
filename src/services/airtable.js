import { config } from "../config.js";
import { fetchJson } from "../utils/http.js";

const API = "https://api.airtable.com/v0";

function headers() {
  return {
    Authorization: `Bearer ${config.airtableToken}`,
    "Content-Type": "application/json",
  };
}

export async function listRecords(
  baseId,
  tableId,
  { formula, fields = [], pageSize = 100, sort = [], view, maxRecords } = {}
) {
  const records = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (formula) params.set("filterByFormula", formula);
    for (const field of fields) params.append("fields[]", field);
    sort.forEach(({ field, direction = "asc" }, i) => {
      params.set(`sort[${i}][field]`, field);
      params.set(`sort[${i}][direction]`, direction);
    });
    if (view) params.set("view", view);
    if (maxRecords) params.set("maxRecords", String(maxRecords));
    if (offset) params.set("offset", offset);
    const body = await fetchJson(`${API}/${baseId}/${tableId}?${params}`, { headers: headers() });
    records.push(...(body.records || []));
    offset = body.offset;
  } while (offset);
  return records;
}

export async function getRecord(baseId, tableId, recordId) {
  if (!recordId) return null;
  return fetchJson(`${API}/${baseId}/${tableId}/${recordId}`, { headers: headers() });
}

export async function updateRecord(baseId, tableId, recordId, fields) {
  return fetchJson(`${API}/${baseId}/${tableId}/${recordId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ fields }),
  });
}

export async function createRecord(
  baseId,
  tableId,
  fields,
  {
    typecast = false,
    // A POST is not safe to repeat: a request that timed out may still have
    // created the record. Callers that cannot afford a duplicate pass
    // retries: 0 and check for the record themselves.
    retries,
    timeoutMs,
  } = {}
) {
  return fetchJson(
    `${API}/${baseId}/${tableId}`,
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        fields,
        typecast,
      }),
    },
    {
      ...(retries === undefined ? {} : { retries }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  );
}
