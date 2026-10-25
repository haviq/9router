// Exact-match response cache for 9router.
//
// Benchmark loops, combo verification sweeps, and repeated probe runs send the
// same request body within minutes of each other. Every one hits the upstream
// provider and pays for a full round trip that was already answered. A 5-minute
// exact-match cache removes that duplication without touching the semantics of
// a real, non-repeated request.
//
// Deliberately in-memory. Persisting responses to SQLite would survive restart
// but resurrect stale answers after a deployment — the one moment the operator
// least wants the old model behaviour back. A restart clearing the cache is a
// feature.
//
// Deliberately exact-match. Semantic caching (embedding similarity) is a
// different feature with a different failure mode: it can serve a wrong answer
// because the request "looked" similar. That is not acceptable as a silent
// default.

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_KEY_BYTES = 200_000;

// The cache is per-process. In dev with hot reload the module state resets, so
// bind to globalThis like the DB driver does to avoid unbounded growth when the
// app is restarted many times without a full process restart.
if (!globalThis._9rResponseCache) {
  globalThis._9rResponseCache = { entries: new Map(), hits: 0, misses: 0, evictions: 0 };
}
const state = globalThis._9rResponseCache;

// Stable key derivation. Object key order must not affect the hash, or the same
// request with keys re-ordered would count as a cache miss and the trie would
// fill with duplicates.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Hash the fields that actually change the answer.
//
// Ignored on purpose:
//   - stream: the cached body is JSON; a streaming request gets a non-stream
//     cached response, which a well-behaved client can still read as one event
//   - user / metadata / headers: routing identity, not content
//   - tools: including them would fix the miss rate at ~100% because tool
//     definitions vary by session but the completion is often identical
function computeKey({ model, messages, temperature, topP, maxTokens, body } = {}) {
  const bucketed = {
    model: model || "",
    messages: Array.isArray(messages) ? messages : [],
    temperature: temperature ?? body?.temperature ?? null,
    top_p: topP ?? body?.top_p ?? null,
    max_tokens: maxTokens ?? body?.max_tokens ?? null,
  };
  return stableStringify(bucketed);
}

// True when the caller asked to bypass the cache for this request only.
// A benchmark that wants a fresh sample every time sets this and does not have
// to disable the feature globally for everyone else.
export function wantsNoCache(headers) {
  if (!headers) return false;
  const get = typeof headers.get === "function" ? (k) => headers.get(k) : (k) => headers[k];
  const v = get("x-9router-nocache");
  return v === "1" || v === "true" || v === "yes";
}

export function cacheKey(params) {
  const key = computeKey(params);
  if (key.length > MAX_KEY_BYTES) return null;
  return key;
}

export function get(key) {
  if (!key) return null;
  const hit = state.entries.get(key);
  if (!hit) {
    state.misses += 1;
    return null;
  }
  if (hit.expiresAt <= Date.now()) {
    state.entries.delete(key);
    state.misses += 1;
    return null;
  }
  state.hits += 1;
  return hit.value;
}

// Store one response body.
//
// Overwrites on collision: a newer answer for the same key is more likely to
// reflect the current provider state than the one it replaces.
export function set(key, value, { ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!key) return false;
  if (state.entries.size >= MAX_ENTRIES) {
    const oldest = state.entries.keys().next().value;
    if (oldest !== undefined) {
      state.entries.delete(oldest);
      state.evictions += 1;
    }
  }
  state.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  return true;
}

export function clear() {
  state.entries.clear();
}

export function stats() {
  const total = state.hits + state.misses;
  return {
    size: state.entries.size,
    hits: state.hits,
    misses: state.misses,
    evictions: state.evictions,
    hitRate: total > 0 ? state.hits / total : 0,
  };
}

export const CACHE_LIMITS = { DEFAULT_TTL_MS, MAX_ENTRIES, MAX_KEY_BYTES };
