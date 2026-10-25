import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// JB Session Memory.
//
// benchmarkRuns answers "did payload X work against model Y". This table
// answers a different question: "what did the winning conversation actually
// look like". A payload ID and a score do not capture the message sequence, the
// identity block, or the turn where the model flipped — and that is the part
// worth replaying.
//
// Only landed sessions are stored. A refused probe is a measurement (that goes
// in benchmarkRuns); it is not a template, and keeping it here would dilute the
// replay corpus with conversation shapes that are known not to work.

export const MAX_SESSION_ROWS = 1000;

export function makeSessionId(now = Date.now()) {
  return `jbs-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeVerdict(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (v === "complied" || v === "breach") return "complied";
  if (v === "partial") return "partial";
  return "refused";
}

// Persist one landed conversation.
//
// A session with no messages is not a template — there is nothing to replay.
// Reject it rather than filling the table with empty shells.
export async function saveJbSession(session) {
  if (!session || typeof session !== "object") return null;

  const model = typeof session.model === "string" ? session.model.trim() : "";
  const messages = Array.isArray(session.messages) ? session.messages : [];
  if (!model || messages.length === 0) return null;

  const db = await getAdapter();
  const id = makeSessionId();
  const timestamp = new Date().toISOString();
  const verdict = normalizeVerdict(session.verdict);

  db.run(
    `INSERT INTO jbSessions (id, timestamp, model, presetId, verdict, score, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      timestamp,
      model,
      session.presetId || null,
      verdict,
      Math.round(Number(session.score) || 0),
      stringifyJson({
        messages,
        payloadId: session.payloadId ?? null,
        identity: session.identity ?? "",
        response: session.response ?? "",
        reasoning: session.reasoning ?? "",
        temperature: session.temperature ?? null,
        maxTokens: session.maxTokens ?? null,
        notes: session.notes ?? "",
      }),
    ]
  );

  return { id, timestamp, verdict };
}

export async function getJbSessions({ model, verdict, presetId, limit = 200 } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (model) {
    conds.push("model = ?");
    params.push(model);
  }
  if (verdict) {
    conds.push("verdict = ?");
    params.push(normalizeVerdict(verdict));
  }
  if (presetId) {
    conds.push("presetId = ?");
    params.push(presetId);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cap = Math.max(1, Math.min(MAX_SESSION_ROWS, Number(limit) || 200));

  const rows = db.all(
    `SELECT id, timestamp, model, presetId, verdict, score, data
       FROM jbSessions ${where}
      ORDER BY timestamp DESC
      LIMIT ?`,
    [...params, cap]
  );

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    model: r.model,
    presetId: r.presetId,
    verdict: r.verdict,
    score: Number(r.score) || 0,
    detail: parseJson(r.data, {}),
  }));
}

export async function getJbSessionById(id) {
  if (!id) return null;
  const db = await getAdapter();
  const r = db.get(`SELECT * FROM jbSessions WHERE id = ?`, [id]);
  if (!r) return null;
  return {
    id: r.id,
    timestamp: r.timestamp,
    model: r.model,
    presetId: r.presetId,
    verdict: r.verdict,
    score: Number(r.score) || 0,
    detail: parseJson(r.data, {}),
  };
}

export async function deleteJbSession(id) {
  if (!id) return false;
  const db = await getAdapter();
  db.run(`DELETE FROM jbSessions WHERE id = ?`, [id]);
  return true;
}

// Leaderboard: rank models by how often they actually landed.
//
// Only landed sessions count as evidence of a model landing. A model with zero
// sessions is not "0% breach" — it is untested, and this query does not report
// it at all rather than let an absence read as failure.
export async function getJbLeaderboard({ limit = 50 } = {}) {
  const db = await getAdapter();
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));

  const rows = db.all(
    `SELECT model,
            COUNT(*) AS total,
            SUM(CASE WHEN verdict = 'complied' THEN 1 ELSE 0 END) AS complied,
            SUM(CASE WHEN verdict = 'partial' THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN verdict = 'refused' THEN 1 ELSE 0 END) AS refused,
            AVG(score) AS meanScore,
            MAX(timestamp) AS lastSeen
       FROM jbSessions
      GROUP BY model
      HAVING COUNT(*) > 0
      ORDER BY (CAST(SUM(CASE WHEN verdict = 'complied' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC,
               AVG(score) DESC
      LIMIT ?`,
    [cap]
  );

  return rows.map((r) => {
    const total = Number(r.total) || 0;
    const complied = Number(r.complied) || 0;
    const partial = Number(r.partial) || 0;
    const refused = Number(r.refused) || 0;
    return {
      model: r.model,
      total,
      complied,
      partial,
      refused,
      breachRate: total > 0 ? complied / total : 0,
      partialRate: total > 0 ? partial / total : 0,
      meanScore: Number(r.meanScore) || 0,
      lastSeen: r.lastSeen,
    };
  });
}

// Keep the table bounded. Called after a batch write rather than on a timer so
// there is no background job to forget about.
export async function pruneJbSessions({ keep = MAX_SESSION_ROWS } = {}) {
  const db = await getAdapter();
  const cap = Math.max(1, Number(keep) || MAX_SESSION_ROWS);

  db.run(
    `DELETE FROM jbSessions
      WHERE id NOT IN (
        SELECT id FROM jbSessions ORDER BY timestamp DESC LIMIT ?
      )`,
    [cap]
  );
}
