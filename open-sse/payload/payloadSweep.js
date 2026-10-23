// Bounded-parallel payload sweep.
//
// runPayloadMatrix is sequential on purpose: provider rate limits are per-key,
// and an unbounded sweep turns a benchmark into a 429 generator whose numbers
// measure the limiter rather than the payload. That reasoning still holds — but
// it makes a wide sweep unusably slow when each payload is a reasoning model
// spending 30-150s before it answers.
//
// So parallelism here is bounded and opt-in, and it never touches the
// sequential default. Two things keep it honest:
//   - a hard concurrency cap, clamped by the caller
//   - an optional per-provider gate so N workers do not all hit the same key
//     at once, which is the failure the sequential design was avoiding
//
// The sweep also records progress and can be resumed: a caller that loses the
// connection mid-sweep can pass the already-completed ids back in rather than
// paying for those model calls twice.

import { runPayload } from "./payloadRunner.js";

export const MAX_CONCURRENCY = 6;
export const DEFAULT_CONCURRENCY = 3;

export function clampConcurrency(raw, fallback = DEFAULT_CONCURRENCY) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_CONCURRENCY, Math.floor(n));
}

// Run `worker` over `items` with at most `limit` in flight.
//
// Deliberately not Promise.all over chunks: chunking means the sweep waits for
// the slowest item in a batch before starting the next one, which on a payload
// set with one 150s reasoning model stalls everything behind it. This pulls the
// next item as soon as any slot frees.
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const cap = Math.max(1, Math.min(list.length || 1, clampConcurrency(limit)));

  const results = new Array(list.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: cap }, runner));
  return results;
}

// Sweep payloads against one model, bounded-parallel.
//
// `skip` lets a resumed run avoid re-measuring ids it already has. `onProgress`
// fires per completion so a long sweep can be watched instead of guessed at.
export async function runPayloadSweep({
  payloadIds = [],
  model,
  probe,
  runs,
  transport,
  concurrency,
  skip = [],
  onProgress,
} = {}) {
  const skipped = new Set(Array.isArray(skip) ? skip : []);
  const pending = payloadIds.filter((id) => !skipped.has(id));

  const rows = await mapWithConcurrency(pending, concurrency, async (payloadId) => {
    const row = await runPayload({ payloadId, model, probe, runs, transport });
    if (typeof onProgress === "function") {
      try {
        onProgress(row, pending.length);
      } catch {
        // A progress callback must never break the sweep.
      }
    }
    return row;
  });

  // Same ordering as the sequential matrix: compliance, then mean score, then
  // fewer transport errors. Best first either way.
  rows.sort((a, b) => {
    const rate = b.aggregate.complianceRate - a.aggregate.complianceRate;
    if (rate !== 0) return rate;
    const mean = b.aggregate.meanScore - a.aggregate.meanScore;
    if (mean !== 0) return mean;
    return a.aggregate.transportErrors - b.aggregate.transportErrors;
  });

  return {
    rows,
    skipped: [...skipped],
    concurrency: Math.max(1, Math.min(pending.length || 1, clampConcurrency(concurrency))),
    pendingCount: pending.length,
  };
}
