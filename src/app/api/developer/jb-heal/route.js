import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { planHeal, applyHeal, getHealState } from "@/lib/jbComboHeal.js";
import { notify, shouldNotify } from "@/lib/notifier.js";

export const dynamic = "force-dynamic";

// GET  /api/developer/jb-heal?combo=jb   → plan (advisory, no write)
// POST /api/developer/jb-heal             → apply plan + notify on every change
//
// The plan is derived from the probe snapshot the Model Status page produces.
// A seat that has failed three sweeps in a row gets dropped from the combo; a
// seat that has answered twice in a row after being dropped comes back. The
// caller always sees the plan before it is applied (GET) — silently mutating a
// combo the operator is looking at would be indistinguishable from corruption.

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

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const name = url.searchParams.get("combo") || "jb";
    const combo = await readCombo(name);
    if (!combo) return NextResponse.json({ error: `Combo '${name}' tidak ditemukan` }, { status: 404 });

    const seats = parseJson(combo.models, []);
    const outcomes = await readProbeOutcomes();
    const plan = planHeal({ combo: name, seats, outcomes });
    return NextResponse.json({ combo: name, seats, plan, state: getHealState(name, seats) });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body.combo === "string" && body.combo.trim() ? body.combo.trim() : "jb";
    const combo = await readCombo(name);
    if (!combo) return NextResponse.json({ error: `Combo '${name}' tidak ditemukan` }, { status: 404 });

    const seats = parseJson(combo.models, []);
    const outcomes = await readProbeOutcomes();
    const plan = planHeal({ combo: name, seats, outcomes });
    const changed = applyHeal(plan);

    // Write the combo only if the healed seat list differs from the current one.
    const nextSeats = seats.filter((s) => !changed.dropped.includes(s));
    for (const s of changed.restored) if (!nextSeats.includes(s)) nextSeats.push(s);
    const mutated = changed.dropped.length > 0 || changed.restored.length > 0;
    if (mutated) await writeCombo(name, nextSeats);

    // Notify on every real change — with the dedupe key derived from the event
    // so a seat that flaps up and down does not spam the operator.
    if (mutated && shouldNotify(`heal:${name}:${[...changed.dropped, ...changed.restored].join(",")}`)) {
      const lines = [];
      if (changed.dropped.length) lines.push(`Dropped: ${changed.dropped.join(", ")}`);
      if (changed.restored.length) lines.push(`Restored: ${changed.restored.join(", ")}`);
      await notify({ title: `Combo ${name} healed`, message: lines.join("\n"), level: "warning", key: `heal:${name}` });
    }

    return NextResponse.json({ ok: true, combo: name, changed, seats: nextSeats });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
