import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// JB Preset Library.
//
// A preset is a named, reusable combination of model + payload + parameters
// that landed in testing. Before this, the winning combination lived in the
// operator's head and was rebuilt by hand every session — so anything that
// worked and was not pasted into a note was lost.
//
// name and model are real columns because they are what gets listed and
// filtered. Everything else (payloadId, identity, registerLevel, temperature,
// maxTokens, topP, verifiedAt, breachRate, notes) lives in the JSON blob
// because it is only read when a single preset is opened.

export function makePresetId(now = Date.now()) {
  return `preset-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...parseJson(row.data, {}),
  };
}

// Create or replace a preset by name.
//
// Upsert by name, not by id: a preset is addressed by what the operator calls
// it. Saving "deepseek-max" twice is a correction, not a second preset.
export async function saveJbPreset(preset) {
  if (!preset || typeof preset !== "object") return null;
  const name = typeof preset.name === "string" ? preset.name.trim() : "";
  const model = typeof preset.model === "string" ? preset.model.trim() : "";
  if (!name || !model) return null;

  const db = await getAdapter();
  const now = new Date().toISOString();

  const existing = db.get(`SELECT id, createdAt FROM jbPresets WHERE name = ?`, [name]);
  const id = existing?.id || preset.id || makePresetId();

  const blob = {
    payloadId: preset.payloadId ?? null,
    identity: preset.identity ?? "",
    registerLevel: preset.registerLevel ?? "standard",
    godmodeLevel: preset.godmodeLevel ?? "custom",
    temperature: typeof preset.temperature === "number" ? preset.temperature : 0.7,
    maxTokens: Number(preset.maxTokens) || 8000,
    topP: typeof preset.topP === "number" ? preset.topP : 1,
    notes: preset.notes ?? "",
    verifiedAt: preset.verifiedAt ?? null,
    breachRate: typeof preset.breachRate === "number" ? preset.breachRate : null,
    probeCount: Number(preset.probeCount) || 0,
  };

  db.run(
    `INSERT INTO jbPresets (id, name, model, data, isActive, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       model = excluded.model,
       data = excluded.data,
       isActive = excluded.isActive,
       updatedAt = excluded.updatedAt`,
    [
      id,
      name,
      model,
      stringifyJson(blob),
      preset.isActive === false ? 0 : 1,
      existing?.createdAt || now,
      now,
    ]
  );

  return { id, name };
}

export async function getJbPresets({ model, activeOnly = false } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (model) {
    conds.push("model = ?");
    params.push(model);
  }
  if (activeOnly) {
    conds.push("isActive = 1");
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(
    `SELECT id, name, model, data, isActive, createdAt, updatedAt
       FROM jbPresets ${where}
      ORDER BY updatedAt DESC`,
    params
  );
  return rows.map(rowToPreset);
}

export async function getJbPresetByName(name) {
  if (!name) return null;
  const db = await getAdapter();
  return rowToPreset(db.get(`SELECT * FROM jbPresets WHERE name = ?`, [name]));
}

export async function deleteJbPreset(id) {
  if (!id) return false;
  const db = await getAdapter();
  db.run(`DELETE FROM jbPresets WHERE id = ?`, [id]);
  return true;
}
