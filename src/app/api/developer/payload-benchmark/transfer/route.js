import { buildTransferPlan, familyOf } from "open-sse/payload/transferMap.js";
import { getBenchmarkRuns, getBestPayloadsByModel } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/developer/payload-benchmark/transfer
//
// Reads stored benchmark results and proposes which payloads to try on the
// siblings of models that already worked. Nothing is executed here — the plan
// is a hypothesis list, and the caller still has to run each candidate before
// it counts. That distinction is the whole point: a transfer that is recorded
// without measurement is a guess wearing a result's clothes.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 40));

    // Only measured runs qualify as transfer sources. A row with zero measured
    // runs measured the provider, not the payload.
    const runs = await getBenchmarkRuns({ limit: 500 });
    const measured = runs.filter((r) => (r.measuredRuns || 0) > 0 && r.score > 0);

    // The known-model universe: caller-supplied ids plus every model already
    // seen in the benchmark store. Both are needed — the caller supplies models
    // that can route but have never been measured, and the store supplies the
    // ones that have. Without the union the plan is circular: it can only
    // propose siblings of models already in the store, which are exactly the
    // ones that do not need transferring.
    const known = [...new Set([...bodyKnown(url), ...runs.map((r) => r.model).filter(Boolean)])];

    const plan = buildTransferPlan({ runs: measured, known, limit });

    // Group the plan by target family so the UI can show it as families rather
    // than a flat list nobody can scan.
    const byFamily = {};
    for (const c of plan) {
      const fam = familyOf(c.model);
      if (!byFamily[fam]) byFamily[fam] = [];
      byFamily[fam].push(c);
    }

    return Response.json({
      sourceRuns: measured.length,
      knownModels: known.length,
      planCount: plan.length,
      plan,
      byFamily,
      best: await getBestPayloadsByModel({ minMeasuredRuns: 2, limit: 100 }),
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

function bodyKnown(url) {
  const raw = url.searchParams.get("known");
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
