import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";

export const dynamic = "force-dynamic";

// GET /api/developer/cost-summary?days=7&model=...&provider=...
//
// Aggregates the requestDetails rows the dashboard already stores. Two rollups:
// per-model (which model costs the most) and per-day (is spending trending).
//
// Only rows with a numeric token count contribute to the totals. A transport
// error stores zero tokens, and folding those into a per-call average would drag
// the mean down and hide the real cost driver.
//
// No pricing table is imported. The caller passes an optional per-model price
// map (`pricing` query param, JSON), or reads the totals as tokens. Guessing a
// price is worse than reporting a token count — the operator can money-convert
// with their real rates instead of a stale table.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 7));
    const model = url.searchParams.get("model") || undefined;
    const provider = url.searchParams.get("provider") || undefined;

    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const db = await getAdapter();

    const conds = ["timestamp >= ?"];
    const params = [sinceIso];
    if (model) { conds.push("model = ?"); params.push(model); }
    if (provider) { conds.push("provider = ?"); params.push(provider); }
    const where = `WHERE ${conds.join(" AND ")}`;

    const rows = db.all(
      `SELECT timestamp, provider, model, status, data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT 20000`,
      params
    );

    const byModel = new Map();
    const byDay = new Map();
    let totalTokens = 0;
    let totalRequests = 0;
    let errorRequests = 0;

    for (const r of rows) {
      const d = parseJson(r.data, {}) || {};
      const usage = d.usage || d.tokens || {};
      const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? d.inTok) || 0;
      const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? d.outTok) || 0;
      const total = inTok + outTok;

      totalRequests += 1;
      if (String(r.status || "").toLowerCase().startsWith("4") || String(r.status || "").toLowerCase().startsWith("5")) {
        errorRequests += 1;
      }
      totalTokens += total;

      const mKey = r.model || "unknown";
      const mRow = byModel.get(mKey) || { model: mKey, provider: r.provider || "?", requests: 0, tokens: 0, inputTokens: 0, outputTokens: 0, errorCount: 0 };
      mRow.requests += 1;
      mRow.tokens += total;
      mRow.inputTokens += inTok;
      mRow.outputTokens += outTok;
      if (String(r.status || "").toLowerCase().startsWith("4") || String(r.status || "").toLowerCase().startsWith("5")) mRow.errorCount += 1;
      byModel.set(mKey, mRow);

      const day = String(r.timestamp || "").slice(0, 10);
      const dayRow = byDay.get(day) || { day, requests: 0, tokens: 0, errors: 0 };
      dayRow.requests += 1;
      dayRow.tokens += total;
      if (String(r.status || "").toLowerCase().startsWith("4") || String(r.status || "").toLowerCase().startsWith("5")) dayRow.errors += 1;
      byDay.set(day, dayRow);
    }

    const models = Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens);
    const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

    return NextResponse.json({
      windowDays: days,
      totals: {
        requests: totalRequests,
        errors: errorRequests,
        tokens: totalTokens,
        avgTokensPerRequest: totalRequests > 0 ? Math.round(totalTokens / totalRequests) : 0,
      },
      models,
      daily,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
