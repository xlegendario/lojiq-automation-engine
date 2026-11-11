// Small key/value store in the Airtable table "Automation State" (Name,
// Value), shared with airtable-automation-engine. The watchers keep their
// switch (Make / Test / Live) and their cursor here, so a restart on Render
// loses nothing and the switch can be flipped in Airtable.

import { config } from "../config.js";
import { createRecord, listRecords, updateRecord } from "./airtable.js";
import { escapeFormulaString } from "../utils/http.js";

const TABLE = "tblSOIfgX2Ja6G5Dr";

let cache = null;
let cacheAt = 0;

async function loadAll() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  const records = await listRecords(config.mainBaseId, TABLE, {
    fields: ["Name", "Value"],
  });
  cache = new Map(records.map(r => [r.fields.Name, { id: r.id, value: r.fields.Value ?? "" }]));
  cacheAt = Date.now();
  return cache;
}

export async function getState(name) {
  const all = await loadAll();
  return all.get(name)?.value ?? null;
}

export async function setState(name, value) {
  const all = await loadAll();
  const existing = all.get(name);

  if (existing) {
    await updateRecord(config.mainBaseId, TABLE, existing.id, { Value: String(value) });
    existing.value = String(value);
    return;
  }

  // Look again before creating: another process may have made it.
  const found = await listRecords(config.mainBaseId, TABLE, {
    formula: `{Name}='${escapeFormulaString(name)}'`,
    fields: ["Name"],
  });

  if (found.length) {
    await updateRecord(config.mainBaseId, TABLE, found[0].id, { Value: String(value) });
    all.set(name, { id: found[0].id, value: String(value) });
    return;
  }

  const created = await createRecord(config.mainBaseId, TABLE, {
    Name: name,
    Value: String(value),
  });
  all.set(name, { id: created.id, value: String(value) });
}
