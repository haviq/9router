// Combo auto-tune + model drift detection.
//
// Two related jobs, both pure so they are testable without a clock or a DB:
//
//   tuneComboOrder   — re-rank a combo's seats so the fastest healthy seat is
//                      tried first. Today the order is whatever the operator
//                      typed when the combo was created, which is stale the
//                      moment one seat's provider slows down.
//
//   detectDrift      — compare a model's current probe outcome with its
//                      previous one and report a regression when a seat that
//                      used to answer now refuses or times out.
//
// Both are advisory: they return a proposal, and the caller decides whether to
// write it. Silently reordering someone's combo or silently flagging a model
// as degraded are both actions the operator should be able to inspect first.

// ── combo order ─────────────────────────────────────────────────────────────

// Rank one seat. Lower is better; -1 means "no data, keep as-is".
//
// The weights encode the preference order the operator actually cares about:
//   1. a seat that answers beats a seat that refuses
//   2. a fast answer beats a slow answer
//   3. a known-good seat beats an unknown seat
//
// Latency is bucketed rather than used raw, so a 12 ms difference does not
// reorder a combo on every sweep — only a real speed class change does.
export function scoreSeat(outcome) {
  if (!outcome) return -1;

  const ok = outcome.ok === true;
  if (!ok) return 100_000;

  const latency = Number(outcome.latencyMs);
  if (!Number.isFinite(latency) || latency <= 0) return 50_000;

  // Bucket: <500ms, <1500ms, <5000ms, <15000ms, else.
  if (latency < 500) return latency;
  if (latency < 1500) return 1000 + latency;
  if (latency < 5000) return 3000 + latency;
  if (latency < 15000) return 10_000 + latency;
  return 30_000 + latency;
}

// Produce the reordered seat list for a combo.
//
// `outcomes` maps a seat model id to its last probe result. A seat with no
// entry keeps its original position (returned via stable sort), so a fresh
// combo whose seats were never probed is left alone rather than reshuffled at
// random.
export function tuneComboOrder(seats, outcomes = {}) {
  if (!Array.isArray(seats) || seats.length === 0) return { order: [], changed: false, scores: {} };

  const scores = {};
  seats.forEach((seat, index) => {
    const sc = scoreSeat(outcomes[seat]);
    scores[seat] = sc < 0 ? index : sc;
  });

  const order = seats
    .map((seat, index) => ({ seat, index, score: scores[seat] }))
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .map((entry) => entry.seat);

  const changed = order.some((seat, i) => seat !== seats[i]);
  return { order, changed, scores };
}

// ── model drift ─────────────────────────────────────────────────────────────

// One previous probe vs one current probe.
//
// The interesting transitions are the ones where a seat went from answering to
// not answering (or the reverse). A latency-only change is reported separately
// because it usually means the provider is busy, not that the model changed.
const REGRESSION = "regression";
const RECOVERY = "recovery";
const SLOWER = "slower";
const FASTER = "faster";
const STABLE = "stable";

const LATENCY_DELTA_THRESHOLD = 2.0;    // 2× slower or faster counts
const LATENCY_FLOOR_MS = 500;           // ignore micro-changes below this

export function compareProbes(previous, current) {
  if (!previous || !current) return { verdict: STABLE, reason: "no-baseline" };

  const wasOk = previous.ok === true;
  const isOk = current.ok === true;

  if (wasOk && !isOk) {
    return { verdict: REGRESSION, reason: current.error || "stopped answering" };
  }
  if (!wasOk && isOk) {
    return { verdict: RECOVERY, reason: "started answering again" };
  }
  if (!wasOk && !isOk) {
    return { verdict: STABLE, reason: "still failing" };
  }

  const prev = Number(previous.latencyMs);
  const curr = Number(current.latencyMs);
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) {
    return { verdict: STABLE, reason: "no-latency" };
  }
  if (Math.max(prev, curr) < LATENCY_FLOOR_MS) {
    return { verdict: STABLE, reason: "below-floor" };
  }

  const ratio = curr / prev;
  if (ratio >= LATENCY_DELTA_THRESHOLD) return { verdict: SLOWER, reason: `${Math.round(ratio * 10) / 10}× slower` };
  if (ratio <= 1 / LATENCY_DELTA_THRESHOLD) return { verdict: FASTER, reason: `${Math.round((1 / ratio) * 10) / 10}× faster` };
  return { verdict: STABLE, reason: "within-threshold" };
}

// Run compareProbes across a set of models and return only the notable rows.
//
// A model that is not present in both snapshots is skipped: a first-time
// observation is not a change, and reporting it as drift on every fresh start
// would make the alert useless within a day.
export function detectDrift(previous = {}, current = {}) {
  const rows = [];
  for (const model of Object.keys(current)) {
    if (!previous[model]) continue;
    const verdict = compareProbes(previous[model], current[model]);
    if (verdict.verdict === STABLE) continue;
    rows.push({
      model,
      verdict: verdict.verdict,
      reason: verdict.reason,
      previous: previous[model],
      current: current[model],
    });
  }
  // Regressions first — those are the ones that need action.
  const rank = { regression: 0, slower: 1, recovery: 2, faster: 3 };
  rows.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9));
  return rows;
}

export const DRIFT_VERDICTS = { REGRESSION, RECOVERY, SLOWER, FASTER, STABLE };
export const DRIFT_LIMITS = { LATENCY_DELTA_THRESHOLD, LATENCY_FLOOR_MS };
