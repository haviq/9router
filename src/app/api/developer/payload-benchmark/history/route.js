import { getBenchmarkRuns, getBestPayloadsByModel } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;

function clampLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

// GET /api/developer/payload-benchmark/history?model=&payloadId=&limit=
//
// Stored benchmark outcomes, newest first, plus the per-model ranking built from
// measured runs only. Kept separate from the benchmark route so starting a run
// and reading past runs do not share a timeout budget.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const model = (url.searchParams.get("model") || "").trim();
    const payloadId = (url.searchParams.get("payloadId") || "").trim();
    const limit = clampLimit(url.searchParams.get("limit"), 200);

    const runs = await getBenchmarkRuns({ model, payloadId, limit });

    // The ranking is only useful when it can be trusted: two measured runs
    // minimum, so a single lucky hit is not presented as a working payload.
    const best = await getBestPayloadsByModel({ minMeasuredRuns: 2, limit: 200 });

    return Response.json({
      filters: { model: model || null, payloadId: payloadId || null, limit },
      count: runs.length,
      runs,
      best,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
