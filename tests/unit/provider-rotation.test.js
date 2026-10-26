import { describe, it, expect } from "vitest";
import {
  scoreProvider,
  orderProviders,
  PROVIDER_ROTATION_LIMITS,
} from "@/lib/providerRotation.js";

describe("providerRotation — scoreProvider", () => {
  it("returns -1 for missing snapshot", () => {
    expect(scoreProvider(null)).toBe(-1);
    expect(scoreProvider(undefined)).toBe(-1);
  });

  it("accepts a single { ok, latencyMs } shape", () => {
    expect(scoreProvider({ ok: true, latencyMs: 400 })).toBe(400);
    expect(scoreProvider({ ok: false })).toBe(100_000);
  });

  it("accepts a per-model aggregate map", () => {
    const snap = {
      "model-a": { ok: true, latencyMs: 400 },
      "model-b": { ok: true, latencyMs: 600 },
    };
    expect(scoreProvider(snap)).toBe(500); // mean of 400 and 600
  });

  it("scores a fully failed provider worst", () => {
    const snap = {
      "model-a": { ok: false },
      "model-b": { ok: false },
    };
    expect(scoreProvider(snap)).toBe(100_000);
  });

  it("ignores failed models when computing mean", () => {
    const snap = {
      "model-a": { ok: true, latencyMs: 400 },
      "model-b": { ok: false },
      "model-c": { ok: true, latencyMs: 800 },
    };
    expect(scoreProvider(snap)).toBe(600); // (400 + 800) / 2
  });

  it("caps latency at the ceiling", () => {
    expect(scoreProvider({ ok: true, latencyMs: 99_999 })).toBe(PROVIDER_ROTATION_LIMITS.LATENCY_CEILING);
  });

  it("returns -1 for an empty aggregate map", () => {
    expect(scoreProvider({})).toBe(-1);
  });
});

describe("providerRotation — orderProviders", () => {
  it("returns an empty result for empty input", () => {
    expect(orderProviders([], {}).order).toEqual([]);
    expect(orderProviders(null, {}).order).toEqual([]);
  });

  it("sorts fastest provider first", () => {
    const providers = ["slow", "fast"];
    const snapshots = {
      slow: { ok: true, latencyMs: 3000 },
      fast: { ok: true, latencyMs: 300 },
    };
    expect(orderProviders(providers, snapshots).order).toEqual(["fast", "slow"]);
  });

  it("pushes fully failed providers to the bottom", () => {
    const providers = ["broken", "ok"];
    const snapshots = {
      broken: { ok: false },
      ok: { ok: true, latencyMs: 500 },
    };
    expect(orderProviders(providers, snapshots).order).toEqual(["ok", "broken"]);
  });

  it("treats providers with no data as last (not first)", () => {
    const providers = ["unknown", "measured"];
    const snapshots = { measured: { ok: true, latencyMs: 700 } };
    expect(orderProviders(providers, snapshots).order).toEqual(["measured", "unknown"]);
  });

  it("is stable for equal scores", () => {
    const providers = ["a", "b", "c"];
    const snapshots = {
      a: { ok: true, latencyMs: 400 },
      b: { ok: true, latencyMs: 400 },
      c: { ok: true, latencyMs: 400 },
    };
    expect(orderProviders(providers, snapshots).order).toEqual(["a", "b", "c"]);
  });

  it("reports changed=false when the order is unchanged", () => {
    const providers = ["fast", "slow"];
    const snapshots = {
      fast: { ok: true, latencyMs: 300 },
      slow: { ok: true, latencyMs: 3000 },
    };
    expect(orderProviders(providers, snapshots).changed).toBe(false);
  });

  it("reports changed=true on a reshuffle", () => {
    const providers = ["slow", "fast"];
    const snapshots = {
      slow: { ok: true, latencyMs: 3000 },
      fast: { ok: true, latencyMs: 300 },
    };
    expect(orderProviders(providers, snapshots).changed).toBe(true);
  });
});
