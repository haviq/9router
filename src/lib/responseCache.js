// Exact-match response cache for 9router.
//
// Benchmark loops, combo verification sweeps, and repeated probe runs send the
// same request body within minutes of each other. Every one hits the upstream
// provider and pays for a full round trip that was already answered. A
// time-bounded exact-match cache removes that duplication without touching the
// semantics of a real, non-repeated request.
//
// In-memory by design. Persisting responses to SQLite would survive restart but
// resurrect stale answers after a deployment — the one moment the operator
// least wants the old model behaviour back. A restart clearing the cache is a
// feature.
//
// Exact-match by design. Semantic caching (embedding similarity) is a different
// feature with a different failure mode: it can serve a wrong answer because
// the request "looked" similar. That is not acceptable as a silent default.

import { isRefusal } from "./jbAutoRotate.js";

// TTL per request category. A chat answer is worth caching longer than a probe
// (which is a connectivity check the operator probably wants to re-measure),
// and a benchmark result is deterministic enough to keep indefinitely within
// the process lifetime.
const TTL_BY_KIND = {
  chat: 15 * 60 * 1000,
  probe: 5 * 60 * 1000,
  benchmark: 60 * 60 * 1000,
};

const DEFAULT_TTL_MS = TTL_BY_KIND.chat;
const MAX_ENTRIES = 500;
const MAX_KEY_BYTES = 200_000;

// Below this size, the response is a one-liner that will not save meaningful
// upstream work — caching it turns the map into noise that evicts useful rows.
const MIN_CACHEABLE_CHARS = 80;

if (!globalThis._9rResponseCache) {
  globalThis._9rResponseCache = { entries: new Map(), hits: 0, misses: 0, evictions: 0, skips: 0 };
}
const state = globalThis._9rResponseCache;

// Stable key derivation. Object key order must not affect the hash, or the same
// request with keys re-ordered would count as a cache miss and the map would
// fill with duplicates.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// Normalize a message list before hashing.
//
// The point of the cache is that the SAME semantic request hits. Fields that
// vary per request (a requestId, a timestamp, a client tag) make every send
// unique and defeat the cache for reasons the operator cannot see. Content is
// trimmed for the same reason — one trailing newline should not be a miss.
//
// Only the fields that change the answer survive: role and content.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const role = m.role || "";
    const content = typeof m.content === "string" ? m.content.trim() : m.content;
    return { role, content };
  });
}

function computeKey({ model, messages, temperature, topP, maxTokens, body } = {}) {
  const bucketed = {
    model: model || "",
    messages: normalizeMessages(messages),
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

// True when a response should be stored.
//
// THREE cases are excluded:
//   - refusals: caching a "I can't help" answer means every retry inside TTL
//     gets the same refusal, which reads as a broken model.
//   - budget exhaustion (finish_reason: "length" with no content): a retry with
//     a larger max_tokens should hit the upstream, not the cache.
//   - tiny answers: not worth the slot.
export function shouldCache(body, content = "") {
  const text = typeof content === "string" ? content.trim() : "";

  // Order matters.
  // Budget exhaustion first: an empty answer with finish_reason "length" is
  // not "too short", it is a retry candidate.
  // Refusal next: a short refusal must still be labelled a refusal, not
  // swallowed by the length threshold, or the cache will re-serve it.
  // Length last: only substantive, non-refusal answers are worth a slot.
  const finish = body?.choices?.[0]?.finish_reason;
  if (finish === "length" && text.length === 0) return { cache: false, reason: "budget-exhausted" };

  if (isRefusal(text)) return { cache: false, reason: "refusal" };
  if (text.length < MIN_CACHEABLE_CHARS) return { cache: false, reason: "too-short" };

  return { cache: true };
}

export function ttlFor(kind = "chat") {
  return TTL_BY_KIND[kind] ?? DEFAULT_TTL_MS;
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
    skips: state.skips,
    hitRate: total > 0 ? state.hits / total : 0,
  };
}

// Named multi-cache wrapper. Benchmark loops benefit from an "infinite"
// (process-lifetime) cache because the payload + model pair is deterministic;
// chat benefits from a shorter one because the operator's follow-ups may look
// like the previous turn. The caller decides by passing a kind to `set`.
export const CACHE_LIMITS = { DEFAULT_TTL_MS, MAX_ENTRIES, MAX_KEY_BYTES, MIN_CACHEABLE_CHARS, TTL_BY_KIND };
