import { NextResponse } from "next/server";
import { getJbLeaderboard } from "@/lib/db/repos/jbSessionsRepo.js";
import { getBestPayloadsByModel } from "@/lib/db/repos/benchmarkRunsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/developer/jb-leaderboard?limit=50
//
// Two rankings in one payload because they answer the same question from
// different evidence. The session leaderboard ranks models by how their own
// conversations landed; bestPayloads ranks payloads per model from measured
// benchmark runs. A model with no evidence is absent, not 0%.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 50));

    const [models, payloads] = await Promise.all([
      getJbLeaderboard({ limit }),
      getBestPayloadsByModel({ minMeasuredRuns: 2, limit }),
    ]);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      models,
      bestPayloads: payloads,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
