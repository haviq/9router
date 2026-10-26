import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { orderProviders } from "@/lib/providerRotation.js";

export const dynamic = "force-dynamic";

// GET /api/developer/provider-rotation?providers=kl,mg,ocz,rv
//
// Ranks providers by their median probe latency. Reads the same kv snapshot the
// Model Status page writes, so the order it returns matches what the operator
// sees in the grid. Providers with no samples sink to the bottom rather than
// sorting as fastest — a first-time provider is unknown, not fast.

const PROBE_SCOPE = "jbd-probe";
const PROBE_KEY = "latest";

async function readProbeSnapshot() {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [PROBE_SCOPE, PROBE_KEY]);
  return row ? parseJson(row.value, {}) : {};
}

// Group a flat { modelId: outcome } map into { provider: { modelId: outcome } }.
//
// The provider key is the model-id prefix before the first slash — the same
// split the model-status page uses, and the same shape the prompt-rules pattern
// matcher works against. Kept here (not in the pure module) because the module
// should not know how model ids are encoded.
function groupByProvider(flat) {
  const out = {};
  for (const [model, outcome] of Object.entries(flat || {})) {
    if (!model || typeof model !== "string") continue;
    const slash = model.indexOf("/");
    const provider = slash > 0 ? model.slice(0, slash) : "direct";
    if (!out[provider]) out[provider] = {};
    out[provider][model] = outcome;
  }
  return out;
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const explicit = url.searchParams.get("providers");

    const flat = await readProbeSnapshot();
    const grouped = groupByProvider(flat);
    const available = Object.keys(grouped);

    const candidates = explicit
      ? explicit.split(",").map((s) => s.trim()).filter(Boolean)
      : available;

    if (candidates.length === 0) {
      return NextResponse.json({
        order: [],
        changed: false,
        scores: {},
        knownProviders: [],
        hint: "Belum ada snapshot probe. Klik Check All di Model Status dulu.",
      });
    }

    const plan = orderProviders(candidates, grouped);
    return NextResponse.json({
      order: plan.order,
      changed: plan.changed,
      scores: plan.scores,
      knownProviders: available,
      sampleCounts: Object.fromEntries(available.map((p) => [p, Object.keys(grouped[p]).length])),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
