import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson, stringifyJson } from "@/lib/db/helpers/jsonCol.js";
import { detectDrift } from "@/lib/comboAutoTune.js";

export const dynamic = "force-dynamic";

// Model Drift Alert.
//
// Compares the last two probe snapshots per model and reports what changed:
// a seat that used to answer and now refuses, or a seat whose latency roughly
// doubled. Regressions are ranked first because those are what the operator
// needs to act on.
//
// Snapshots live in the `kv` table under scope `jbd-snapshot` so no new table is
// needed and the row survives a restart. Only the newest snapshot is kept — a
// model's drift interesting window is "what changed since last sweep", not a
// whole history that would need pruning.

const SCOPE = "jbd-snapshot";
const KEY = "latest";

async function readSnapshot() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, KEY]);
  return row ? parseJson(row.value, {}) : {};
}

async function writeSnapshot(snapshot) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, KEY, stringifyJson(snapshot)]
  );
}

// GET /api/developer/jb-drift?current=1
//
// Without `current`, returns the last saved snapshot plus anything currently
// known in the probe cache. The probe cache itself lives in memory in the
// probe-matrix route, so the caller can pass its own view in for a live diff.
export async function GET() {
  try {
    const previous = await readSnapshot();
    return NextResponse.json({
      hasBaseline: Object.keys(previous).length > 0,
      snapshotSize: Object.keys(previous).length,
      previous,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/developer/jb-drift
//
// Body: { current: { modelId: { ok, latencyMs, error }, ... }, save?: boolean }
//
// Runs the comparison, optionally leaves the passed snapshot as the new
// baseline, and returns the drift rows.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.current !== "object" || body.current === null) {
      return NextResponse.json({ error: "current snapshot (object) required" }, { status: 400 });
    }

    const previous = await readSnapshot();
    const drift = detectDrift(previous, body.current);

    // Persist last only when asked. A drift check that mutates the baseline on
    // every read would always compare a snapshot against itself and report
    // nothing — the useful diff is between sweeps, not within one.
    if (body.save === true) await writeSnapshot(body.current);

    return NextResponse.json({
      compared: Object.keys(body.current).length,
      baselineSize: Object.keys(previous).length,
      saved: body.save === true,
      drift,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
