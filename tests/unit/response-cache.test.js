import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheKey,
  get,
  set,
  clear,
  stats,
  wantsNoCache,
  shouldCache,
  ttlFor,
  CACHE_LIMITS,
} from "@/lib/responseCache.js";

// Each test starts from a clean cache. The module binds to globalThis for the
// hot-reload case, so a leftover from another test would leak in.
beforeEach(() => {
  clear();
});

describe("responseCache — key derivation", () => {
  it("produces the same key regardless of object key order", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "hi" }], temperature: 0.7 });
    const b = cacheKey({ temperature: 0.7, messages: [{ role: "user", content: "hi" }], model: "m" });
    expect(a).toBe(b);
  });

  it("changes key when the model changes", () => {
    const a = cacheKey({ model: "a", messages: [] });
    const b = cacheKey({ model: "b", messages: [] });
    expect(a).not.toBe(b);
  });

  it("changes key when temperature changes", () => {
    const a = cacheKey({ model: "m", messages: [], temperature: 0.5 });
    const b = cacheKey({ model: "m", messages: [], temperature: 0.9 });
    expect(a).not.toBe(b);
  });

  it("changes key when max_tokens changes", () => {
    const a = cacheKey({ model: "m", messages: [], maxTokens: 1000 });
    const b = cacheKey({ model: "m", messages: [], maxTokens: 4000 });
    expect(a).not.toBe(b);
  });

  it("pulls params from the body when not passed explicitly", () => {
    const a = cacheKey({ model: "m", messages: [], body: { temperature: 0.3, max_tokens: 512 } });
    const b = cacheKey({ model: "m", messages: [], temperature: 0.3, maxTokens: 512 });
    expect(a).toBe(b);
  });
});

describe("responseCache — get / set", () => {
  it("returns what was stored", () => {
    const k = cacheKey({ model: "m", messages: [{ role: "user", content: "q" }] });
    set(k, { answer: "cached" });
    expect(get(k)).toEqual({ answer: "cached" });
  });

  it("returns null for an unknown key", () => {
    expect(get("nope")).toBeNull();
  });

  it("returns null for an empty key without touching storage", () => {
    expect(get("")).toBeNull();
    expect(get(null)).toBeNull();
  });

  it("overwrites on a repeated key", () => {
    const k = cacheKey({ model: "m", messages: [] });
    set(k, { v: 1 });
    set(k, { v: 2 });
    expect(get(k)).toEqual({ v: 2 });
  });
});

describe("responseCache — TTL", () => {
  it("expires an entry past its ttl", async () => {
    const k = cacheKey({ model: "m", messages: [] });
    set(k, { v: 1 }, { ttlMs: 300 });
    expect(get(k)).toEqual({ v: 1 });
    await new Promise((r) => setTimeout(r, 350));
    expect(get(k)).toBeNull();
  });
});

describe("responseCache — header bypass", () => {
  it("detects x-9router-nocache: 1", () => {
    const headers = { get: (k) => (k === "x-9router-nocache" ? "1" : null) };
    expect(wantsNoCache(headers)).toBe(true);
  });

  it("accepts true / yes as bypass values", () => {
    expect(wantsNoCache({ get: () => "true" })).toBe(true);
    expect(wantsNoCache({ get: () => "yes" })).toBe(true);
  });

  it("treats anything else as no-bypass", () => {
    expect(wantsNoCache({ get: () => "0" })).toBe(false);
    expect(wantsNoCache({ get: () => null })).toBe(false);
    expect(wantsNoCache(null)).toBe(false);
    expect(wantsNoCache({})).toBe(false);
  });

  it("reads from a plain object too", () => {
    expect(wantsNoCache({ "x-9router-nocache": "1" })).toBe(true);
  });
});

describe("responseCache — stats", () => {
  it("counts hits and misses", () => {
    const k = cacheKey({ model: "m", messages: [] });
    set(k, { v: 1 });
    get(k);
    get("missing");
    const s = stats();
    expect(s.hits).toBeGreaterThanOrEqual(1);
    expect(s.misses).toBeGreaterThanOrEqual(1);
  });

  it("clear() empties the store", () => {
    const k = cacheKey({ model: "m", messages: [] });
    set(k, { v: 1 });
    clear();
    expect(stats().size).toBe(0);
  });

  it("exposes cache limits", () => {
    expect(CACHE_LIMITS.DEFAULT_TTL_MS).toBe(15 * 60 * 1000);
    expect(CACHE_LIMITS.MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe("responseCache — ttl per category", () => {
  it("benchmark keeps a longer window than chat", () => {
    expect(ttlFor("benchmark")).toBeGreaterThan(ttlFor("chat"));
  });

  it("probe keeps a shorter window than chat", () => {
    expect(ttlFor("probe")).toBeLessThan(ttlFor("chat"));
  });

  it("unknown kind falls back to the chat default", () => {
    expect(ttlFor("who-knows")).toBe(ttlFor("chat"));
  });
});

describe("responseCache — shouldCache", () => {
  const longAnswer = "x".repeat(120);

  it("accepts a substantive answer", () => {
    expect(shouldCache({}, longAnswer).cache).toBe(true);
  });

  it("rejects a one-liner below the threshold", () => {
    expect(shouldCache({}, "ok").reason).toBe("too-short");
  });

  it("rejects a refusal", () => {
    const refusal = "I'm sorry, but I can't help with that request. It goes against my guidelines.";
    expect(shouldCache({}, refusal).reason).toBe("refusal");
  });

  it("rejects a budget-exhausted empty answer", () => {
    const body = { choices: [{ finish_reason: "length" }] };
    expect(shouldCache(body, "").reason).toBe("budget-exhausted");
  });

  it("still caches a truncated but non-empty answer", () => {
    const body = { choices: [{ finish_reason: "length" }] };
    expect(shouldCache(body, longAnswer).cache).toBe(true);
  });
});

describe("responseCache — message normalization", () => {
  it("ignores surrounding whitespace in content", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "hello" }] });
    const b = cacheKey({ model: "m", messages: [{ role: "user", content: "  hello\n" }] });
    expect(a).toBe(b);
  });

  it("ignores per-request metadata fields", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "hi", requestId: "a" }] });
    const b = cacheKey({ model: "m", messages: [{ role: "user", content: "hi", requestId: "b" }] });
    expect(a).toBe(b);
  });

  it("still distinguishes different content", () => {
    const a = cacheKey({ model: "m", messages: [{ role: "user", content: "hello" }] });
    const b = cacheKey({ model: "m", messages: [{ role: "user", content: "goodbye" }] });
    expect(a).not.toBe(b);
  });
});
