import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { tuneComboOrder } from "@/lib/comboAutoTune.js";

export const dynamic = "force-dynamic";

// Combo auto-tune API.
//
// GET  /api/developer/jb-tune?combo=jb   → proposal, no write
// POST /api/developer/jb-tune             → apply the proposal
//
// The proposal is derived from the last known probe outcomes, which live in the
// kv scope used by the Model Status page. Because the route reads the same
// source the UI already shows, running auto-tune never contradicts what the
// operator is looking at. It also never inserts a seat that is not already in
// the combo — a reorder is a reordering, not a rewrite.

const PROBE_SCOPE = "jbd-probe";
const PROBE_KEY = "latest";

async function readProbeOutcomes() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [PROBE_SCOPE, PROBE_KEY]);
  return row ? parseJson(row.value, {}) : {};
}

async function readCombo(name) {
  const db = await getAdapter();
  return db.get(`SELECT id, name, models FROM combos WHERE name = ?`, [name]);
}

async function writeCombo(name, models) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`UPDATE combos SET models = ?, updatedAt = ? WHERE name = ?`, [JSON.stringify(models), now, name]);
}

// GET returns the proposal only — nothing is written.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get("combo") || "jb";

    const combo = await readCombo(name);
    if (!combo) return NextResponse.json({ error: `Combo '${name}' tidak ditemukan` }, { status: 404 });

    const seats = parseJson(combo.models, []);
    const outcomes = await readProbeOutcomes();
    const plan = tuneComboOrder(seats, outcomes);

    return NextResponse.json({
      combo: name,
      seats,
      proposedOrder: plan.order,
      changed: plan.changed,
      scores: plan.scores,
      probedCount: Object.keys(outcomes).length,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST applies the reorder to the combo row.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.combo === "string" && body.combo.trim() ? body.combo.trim() : "jb";

    const combo = await readCombo(name);
    if (!combo) return NextResponse.json({ error: `Combo '${name}' tidak ditemukan` }, { status: 404 });

    const seats = parseJson(combo.models, []);
    const outcomes = await readProbeOutcomes();
    const plan = tuneComboOrder(seats, outcomes);

    // Guard against a no-op write: if the ordering is unchanged, skip the DB
    // update so the combo's updatedAt timestamp still reflects real change.
    if (!plan.changed) {
      return NextResponse.json({ ok: true, changed: false, order: plan.order });
    }

    await writeCombo(name, plan.order);
    return NextResponse.json({ ok: true, changed: true, before: seats, after: plan.order });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
