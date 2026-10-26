// Provider-level rotation for combos.
//
// Key pool rotation spreads requests across the *keys* of one provider. This
// module spreads across *providers*: when the combo's primary provider (e.g.
// kl) slows down or its pool is exhausted, the caller can route to the next
// healthy provider (mg, ocz, rv) without rewriting the combo by hand.
//
// Pure decision logic — the caller applies the decision to a combo row.

// Rank one provider from a probe snapshot. Same bucket shape as comboAutoTune
// so both features agree on what "fast" means.
export function scoreProvider(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return -1;

  // Accept either a { ok, latencyMs } object or an aggregate map
  // { modelId: { ok, latencyMs } } — the caller may pass either shape.
  let ok = 0;
  let samples = 0;
  let totalLatency = 0;
  let firstError = null;

  if (typeof snapshot.ok === "boolean") {
    if (!snapshot.ok) return 100_000;
    const lat = Number(snapshot.latencyMs);
    return Number.isFinite(lat) && lat > 0 ? Math.min(30_000, lat) : 50_000;
  }

  for (const k of Object.keys(snapshot)) {
    const v = snapshot[k];
    if (!v) continue;
    samples += 1;
    if (v.ok) {
      ok += 1;
      const lat = Number(v.latencyMs);
      if (Number.isFinite(lat) && lat > 0) totalLatency += lat;
    } else if (!firstError && v.error) {
      firstError = v.error;
    }
  }

  if (samples === 0) return -1;
  if (ok === 0) return 100_000;
  const mean = totalLatency / ok;
  return Math.min(30_000, mean);
}

// Order providers by score. Providers without data sink to the bottom
// (score -1) rather than sorting as fastest.
export function orderProviders(providers = [], snapshots = {}) {
  if (!Array.isArray(providers) || providers.length === 0) return { order: [], changed: false, scores: {} };

  const scores = {};
  for (let i = 0; i < providers.length; i += 1) {
    const p = providers[i];
    const sc = scoreProvider(snapshots[p]);
    scores[p] = sc < 0 ? Number.MAX_SAFE_INTEGER : sc;
  }

  const order = providers
    .map((p, i) => ({ p, i, s: scores[p] }))
    .sort((a, b) => (a.s - b.s) || (a.i - b.i))
    .map((entry) => entry.p);

  const changed = order.some((p, i) => p !== providers[i]);
  return { order, changed, scores };
}

export const PROVIDER_ROTATION_LIMITS = { MAX_SCORE: 100_000, LATENCY_CEILING: 30_000 };
