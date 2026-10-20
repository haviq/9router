// Payload benchmark runner.
//
// Drives one payload against one model N times, scores every answer, and
// aggregates the result into a number that can be compared across payloads.
//
// The transport is injected rather than imported. That keeps this module free
// of router internals (no handleChat import, no DB, no key lookup), so the
// whole run/skip/score path is testable with a stub, and the API route stays
// the only place that knows how to actually reach a model.
//
// Failure policy: a transport error is recorded as a failed run and the loop
// continues. One provider hiccup must not throw away the runs that succeeded —
// that is exactly the noise that makes benchmark numbers untrustworthy.

import { scoreResponse, aggregateRuns, VERDICT } from "./payloadScorer.js";
import { getExternalPayload } from "./jailbreakPayloads.js";
import { getGodmodePrompt, GODMODE_LEVELS } from "./godmodePayloads.js";

export const DEFAULT_RUNS = 3;
export const MAX_RUNS = 10;

// Resolve a payload id to its text. Builtin godmode variants resolve through
// getGodmodePrompt; everything else is a file payload from the registry.
// Returns null when the id matches nothing, so the caller can report it
// instead of silently benchmarking an empty system prompt.
export function resolvePayloadText(id) {
  if (!id || typeof id !== "string") return null;

  const trimmed = id.trim();
  if (!trimmed) return null;

  // File payloads first — their ids are "f:ai:<name>", never godmode level ids.
  const external = getExternalPayload(trimmed);
  if (external) return external;

  // Builtin variant ids are plain keys like "classic" / "gptClassic".
  if (Object.values(GODMODE_LEVELS).includes(trimmed)) {
    const text = getGodmodePrompt(trimmed, "");
    return text || null;
  }

  return null;
}

function clampRuns(n) {
  const parsed = Number(n);
  if (!Number.isFinite(parsed)) return DEFAULT_RUNS;
  return Math.max(1, Math.min(MAX_RUNS, Math.floor(parsed)));
}

/**
 * Run one payload against one model.
 *
 * @param {object} opts
 * @param {string} opts.payloadId    Registry id or builtin variant id.
 * @param {string} opts.model        Upstream model id.
 * @param {string} opts.probe        User message sent after the payload.
 * @param {number} [opts.runs]       Repetitions (1..MAX_RUNS).
 * @param {function} opts.transport  async ({model, system, user}) => string.
 *                                   Must throw on transport failure.
 * @returns {Promise<object>} per-run verdicts plus the aggregate.
 */
export async function runPayload({ payloadId, model, probe, runs, transport } = {}) {
  if (typeof transport !== "function") {
    throw new Error("runPayload requires a transport function");
  }
  if (!model || typeof model !== "string") {
    throw new Error("runPayload requires a model id");
  }
  if (!probe || typeof probe !== "string") {
    throw new Error("runPayload requires a probe string");
  }

  const payloadText = resolvePayloadText(payloadId);
  if (payloadText === null) {
    throw new Error(`Unknown payload id: ${payloadId}`);
  }

  const total = clampRuns(runs);
  const results = [];

  for (let i = 0; i < total; i++) {
    const startedAt = Date.now();
    try {
      const answer = await transport({ model, system: payloadText, user: probe });
      const scored = scoreResponse({ response: answer, probe });
      results.push({
        run: i + 1,
        ok: true,
        verdict: scored.verdict,
        score: scored.score,
        reasons: scored.reasons,
        latencyMs: Date.now() - startedAt,
        answerChars: typeof answer === "string" ? answer.length : 0,
      });
    } catch (e) {
      results.push({
        run: i + 1,
        ok: false,
        verdict: VERDICT.EMPTY,
        score: 0,
        reasons: [`transport error: ${e?.message || String(e)}`],
        latencyMs: Date.now() - startedAt,
        answerChars: 0,
      });
    }
  }

  const scoredRuns = results.map((r) => ({ verdict: r.verdict, score: r.score }));
  const aggregate = aggregateRuns(scoredRuns);
  const transportErrors = results.filter((r) => !r.ok).length;
  const latencies = results.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    payloadId,
    model,
    runs: total,
    results,
    aggregate: {
      ...aggregate,
      // An aggregate computed over transport errors is not a measurement of the
      // payload. Surface the count so a caller can discard the row instead of
      // recording a provider outage as a payload that does not work.
      transportErrors,
      measuredRuns: total - transportErrors,
      medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    },
  };
}

/**
 * Run several payloads against one model, sequentially.
 *
 * Sequential on purpose: provider rate limits are per-key, and a parallel
 * sweep turns a benchmark into a 429 generator whose numbers measure the rate
 * limiter rather than the payload.
 */
export async function runPayloadMatrix({ payloadIds = [], model, probe, runs, transport, onProgress } = {}) {
  const out = [];
  for (const payloadId of payloadIds) {
    const row = await runPayload({ payloadId, model, probe, runs, transport });
    out.push(row);
    if (typeof onProgress === "function") {
      try {
        onProgress(row);
      } catch {
        // A progress callback must never break the sweep.
      }
    }
  }

  // Best first: compliance rate, then mean score, then fewer transport errors.
  out.sort((a, b) => {
    const rate = b.aggregate.complianceRate - a.aggregate.complianceRate;
    if (rate !== 0) return rate;
    const mean = b.aggregate.meanScore - a.aggregate.meanScore;
    if (mean !== 0) return mean;
    return a.aggregate.transportErrors - b.aggregate.transportErrors;
  });

  return out;
}
