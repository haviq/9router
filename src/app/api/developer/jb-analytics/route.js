import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";

// GET /api/developer/jb-analytics?days=30
//
// Read-only aggregation over the two evidence tables. Nothing here writes.
//
// The page it serves answers questions the leaderboard cannot: whether a model
// is drifting week-over-week (a compliance rate that used to be 80% and is now
// 20% means the upstream guard changed, not that your prompt got worse), and
// which payload reads best in a matrix without opening a benchmark for every
// cell. Both are read directly from the tables rather than recomputed from the
// leaderboard's snapshot, so a chart and a table in the same view can never
// disagree about the same input row.

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const db = await getAdapter();

    // Per-day trend over sessions. Bucketed by day because a per-request curve
    // is noise; what an operator needs is "did this model hold its rate".
    const trend = db.all(
      `SELECT substr(timestamp, 1, 10) AS day,
              COUNT(*) AS total,
              SUM(CASE WHEN verdict = 'complied' THEN 1 ELSE 0 END) AS complied,
              SUM(CASE WHEN verdict = 'partial' THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN verdict = 'refused' THEN 1 ELSE 0 END) AS refused
         FROM jbSessions
        WHERE timestamp >= ?
        GROUP BY day
        ORDER BY day ASC`,
      [since]
    );

    // Per-model totals, ordered by rate. A model with no rows is absent, not 0%.
    const models = db.all(
      `SELECT model,
              COUNT(*) AS total,
              SUM(CASE WHEN verdict = 'complied' THEN 1 ELSE 0 END) AS complied,
              SUM(CASE WHEN verdict = 'partial' THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN verdict = 'refused' THEN 1 ELSE 0 END) AS refused,
              AVG(score) AS meanScore,
              MAX(timestamp) AS lastSeen
         FROM jbSessions
        WHERE timestamp >= ?
        GROUP BY model
        ORDER BY (CAST(SUM(CASE WHEN verdict = 'complied' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC`,
      [since]
    );

    // Payload x model heatmap, from measured benchmark runs. The matrix rows
    // are trimmed by the caller's renderer, not here — a limit that truncates
    // mid-payload would make a payload look weak in every column.
    const matrix = db.all(
      `SELECT model, payloadId,
              COUNT(*) AS attempts,
              AVG(score) AS meanScore,
              MAX(score) AS bestScore,
              SUM(measuredRuns) AS totalMeasured
         FROM benchmarkRuns
        WHERE measuredRuns >= 1 AND timestamp >= ?
        GROUP BY model, payloadId`,
      [since]
    );

    // Week-over-week drift per model. Only models with evidence in BOTH the
    // recent window and the prior window can drift; a fresh model is not
    // regressing just because it had no past.
    const half = Math.floor(days / 2);
    const mid = new Date(Date.now() - half * 24 * 60 * 60 * 1000).toISOString();
    const drift = db.all(
      `SELECT model,
              SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recentTotal,
              SUM(CASE WHEN timestamp >= ? AND verdict = 'complied' THEN 1 ELSE 0 END) AS recentComplied,
              SUM(CASE WHEN timestamp < ? THEN 1 ELSE 0 END) AS priorTotal,
              SUM(CASE WHEN timestamp < ? AND verdict = 'complied' THEN 1 ELSE 0 END) AS priorComplied
         FROM jbSessions
        WHERE timestamp >= ?
        GROUP BY model`,
      [mid, mid, mid, mid, since]
    );

    const summary = db.get(
      `SELECT (SELECT COUNT(*) FROM jbSessions) AS totalSessions,
              (SELECT COUNT(*) FROM benchmarkRuns) AS totalRuns,
              (SELECT COUNT(*) FROM jbPresets) AS totalPresets`
    );

    const shape = (rows, key) => rows.map((r) => {
      const total = Number(r.total) || 0;
      const complied = Number(r.complied) || 0;
      return {
        [key]: r[key],
        total,
        complied,
        partial: Number(r.partial) || 0,
        refused: Number(r.refused) || 0,
        breachRate: total > 0 ? complied / total : 0,
        meanScore: Number(r.meanScore) || null,
        lastSeen: r.lastSeen || null,
      };
    });

    const driftRows = drift
      .map((r) => {
        const rTotal = Number(r.recentTotal) || 0;
        const pTotal = Number(r.priorTotal) || 0;
        if (rTotal === 0 || pTotal === 0) return null;
        const recentRate = (Number(r.recentComplied) || 0) / rTotal;
        const priorRate = (Number(r.priorComplied) || 0) / pTotal;
        return {
          model: r.model,
          priorRate,
          recentRate,
          delta: recentRate - priorRate,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.delta - b.delta);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      window: { days, since },
      summary: {
        sessions: Number(summary?.totalSessions) || 0,
        runs: Number(summary?.totalRuns) || 0,
        presets: Number(summary?.totalPresets) || 0,
      },
      trend: shape(trend, "day"),
      models: shape(models, "model"),
      drift: driftRows,
      matrix: matrix.map((r) => ({
        model: r.model,
        payloadId: r.payloadId,
        attempts: Number(r.attempts) || 0,
        meanScore: Number(r.meanScore) || 0,
        bestScore: Number(r.bestScore) || 0,
        totalMeasured: Number(r.totalMeasured) || 0,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
