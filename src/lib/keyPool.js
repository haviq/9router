// Key pool rotation helpers.
//
// getProviderCredentials already prevents repeat selection of a connection
// that is model-locked or excluded for THIS request. What it does not do is
// spread successive requests across the healthy connections of one provider: a
// provider with 16 keys keeps returning whichever connection sorts first, and
// the remaining 15 sit idle until that one trips a 429.
//
// These helpers turn the available set into a rotation order. Kept pure so the
// selection policy is testable without a DB or a clock.

// Deterministic shuffle seeded by a counter so the same call with the same
// counter returns the same order (important for retry semantics: the retry for
// request N-1 should line up with the pick for request N-1, not a fresh
// random).
export function seededOrder(items, seed) {
  const arr = Array.isArray(items) ? [...items] : [];
  if (arr.length <= 1) return arr;

  let state = (Number(seed) || 0) >>> 0 || 1;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    // xorshift32 — tiny, deterministic, good enough for ordering 16 candidates.
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    const j = state % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// Cooldown state lives in memory, keyed by connection id.
//
// Kept out of the DB on purpose: a cooldown is short (seconds to minutes) and
// ephemeral. Persisting it would carry stale cooldowns across a restart and
// leave a healthy key benched for no reason.
if (!globalThis._9rKeyCooldowns) globalThis._9rKeyCooldowns = new Map();
const cooldowns = globalThis._9rKeyCooldowns;

const DEFAULT_COOLDOWN_MS = 60_000;

// Status codes that mean "this key is the problem, try another".
//
// 5xx is deliberately absent: an upstream error is usually the provider, not
// the key, and benching every key that saw one 502 would take the whole pool
// offline for a problem the pool cannot fix.
const KEY_LEVEL_STATUSES = new Set([401, 402, 403, 429]);

export function cooldownFor(status, retryAfterMs = null) {
  const s = Number(status);
  if (!KEY_LEVEL_STATUSES.has(s)) return 0;

  // Provider told us when to come back — respect it, but cap it so a malformed
  // header cannot bench a key for a day.
  const fromHeader = Number(retryAfterMs);
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.min(fromHeader, 30 * 60 * 1000);
  }

  // 401/403 is a credential problem, not load: wait longer before retrying it.
  if (s === 401 || s === 403) return 5 * 60 * 1000;
  return DEFAULT_COOLDOWN_MS;
}

export function markKeyCooldown(connectionId, status, retryAfterMs = null) {
  if (!connectionId) return 0;
  const ms = cooldownFor(status, retryAfterMs);
  if (ms <= 0) return 0;
  cooldowns.set(String(connectionId), Date.now() + ms);
  return ms;
}

export function isKeyCooling(connectionId, now = Date.now()) {
  if (!connectionId) return false;
  const until = cooldowns.get(String(connectionId));
  if (!until) return false;
  if (until <= now) {
    cooldowns.delete(String(connectionId));
    return false;
  }
  return true;
}

// Split connections into { ready, cooling } for a rotation decision.
//
// A connection that has never failed is always ready. A benched one joins the
// ready list only after its cooldown expires.
export function partitionByCooldown(connections, now = Date.now()) {
  const ready = [];
  const cooling = [];
  for (const c of Array.isArray(connections) ? connections : []) {
    if (!c) continue;
    if (isKeyCooling(c.id, now)) cooling.push(c);
    else ready.push(c);
  }
  return { ready, cooling };
}

// Pick the next connection for a provider given a rotating counter.
//
// Order of preference:
//   1. ready connections, in seeded rotation order
//   2. if none are ready, nothing (caller decides whether to wait or fail)
//
// Returning null lets the caller distinguish "pool empty" from "pool all
// cooling" — different operational meanings, different responses.
export function pickConnection(connections, counter = 0, now = Date.now()) {
  const { ready, cooling } = partitionByCooldown(connections, now);
  if (ready.length === 0) return { connection: null, coolingCount: cooling.length };
  const ordered = seededOrder(ready, counter);
  return { connection: ordered[0], coolingCount: cooling.length };
}

export function resetCooldowns() {
  cooldowns.clear();
}

export function cooldownStats() {
  const now = Date.now();
  let active = 0;
  for (const until of cooldowns.values()) {
    if (until > now) active += 1;
  }
  return { tracked: cooldowns.size, active };
}

export const KEY_POOL_LIMITS = { DEFAULT_COOLDOWN_MS, KEY_LEVEL_STATUSES: [...KEY_LEVEL_STATUSES] };
