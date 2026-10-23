import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Persisted benchmark outcomes.
//
// The benchmark tab already ran payloads against real models, but the result
// lived only in the browser tab that started it — close the tab and the
// measurement was gone. That is why MODEL_VARIANT_MAP stayed hand-curated: the
// evidence kept evaporating before anyone could record it.
//
// Verdict and score are real columns because they are what gets filtered and
// ranked; per-run detail stays in the JSON blob because it is only read when
// someone opens a single row.

export const MAX_RETENTION_ROWS = 2000;

export function makeRunId(now = Date.now()) {
  return `bench-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

// Persist one payload-vs-model result.
//
// Runs that never reached the model are NOT stored as failures. A transport
// error measures the provider, not the payload; recording it as "refused" is
// how a working payload gets thrown away. The caller passes only rows it
// considers measured, and this function refuses anything else.
export async function saveBenchmarkRun(row) {
  if (!row || typeof row !== "object") return null;

  const payloadId = typeof row.payloadId === "string" ? row.payloadId.trim() : "";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!payloadId || !model) return null;

  const aggregate = row.aggregate || {};
  const measured = Number(aggregate.measuredRuns) || 0;
  if (measured <= 0) return null;

  const db = await getAdapter();
  const id = makeRunId();
  const timestamp = new Date().toISOString();

  db.run(
    `INSERT INTO benchmarkRuns (id, timestamp, model, payloadId, verdict, score, measuredRuns, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      timestamp,
      model,
      payloadId,
      String(aggregate.complianceRate >= 1 ? "complied" : aggregate.complianceRate > 0 ? "partial" : "refused"),
      Math.round(Number(aggregate.meanScore) || 0),
      measured,
      stringifyJson({
        runs: row.runs,
        aggregate,
        results: row.results,
      }),
    ]
  );

  return { id, timestamp };
}

// Read stored results, newest first.
//
// Bounded by default: this table grows one row per payload per model, and the
// page never needs the whole history to answer "which payload works here".
export async function getBenchmarkRuns({ model, payloadId, limit = 200 } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (model) {
    conds.push("model = ?");
    params.push(model);
  }
  if (payloadId) {
    conds.push("payloadId = ?");
    params.push(payloadId);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cap = Math.max(1, Math.min(MAX_RETENTION_ROWS, Number(limit) || 200));

  const rows = db.all(
    `SELECT id, timestamp, model, payloadId, verdict, score, measuredRuns, data
       FROM benchmarkRuns
       ${where}
      ORDER BY timestamp DESC
      LIMIT ?`,
    [...params, cap]
  );

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    model: r.model,
    payloadId: r.payloadId,
    verdict: r.verdict,
    score: Number(r.score) || 0,
    measuredRuns: Number(r.measuredRuns) || 0,
    detail: parseJson(r.data, null),
  }));
}

// Best payload per model, from measured runs only.
//
// This is the query that makes the table worth keeping: it answers "for this
// model, which payload has actually worked" from evidence instead of from the
// hand-curated map. A payload needs at least two measured runs to qualify —
// one lucky hit is not a rate.
export async function getBestPayloadsByModel({ minMeasuredRuns = 2, limit = 100 } = {}) {
  const db = await getAdapter();

  const rows = db.all(
    `SELECT model,
            payloadId,
            COUNT(*) AS attempts,
            SUM(measuredRuns) AS totalMeasured,
            AVG(score) AS meanScore,
            MAX(score) AS bestScore
       FROM benchmarkRuns
      WHERE measuredRuns >= ?
      GROUP BY model, payloadId
      ORDER BY meanScore DESC
      LIMIT ?`,
    [Math.max(1, Number(minMeasuredRuns) || 2), Math.max(1, Math.min(MAX_RETENTION_ROWS, Number(limit) || 100))]
  );

  return rows.map((r) => ({
    model: r.model,
    payloadId: r.payloadId,
    attempts: Number(r.attempts) || 0,
    totalMeasured: Number(r.totalMeasured) || 0,
    meanScore: Number(r.meanScore) || 0,
    bestScore: Number(r.bestScore) || 0,
  }));
}

// Keep the table bounded. Called after a batch write rather than on a timer so
// there is no background job to forget about.
export async function pruneBenchmarkRuns({ keep = MAX_RETENTION_ROWS } = {}) {
  const db = await getAdapter();
  const cap = Math.max(1, Number(keep) || MAX_RETENTION_ROWS);

  db.run(
    `DELETE FROM benchmarkRuns
      WHERE id NOT IN (
        SELECT id FROM benchmarkRuns ORDER BY timestamp DESC LIMIT ?
      )`,
    [cap]
  );
}
