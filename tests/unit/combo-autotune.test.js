import { describe, it, expect } from "vitest";
import {
  scoreSeat,
  tuneComboOrder,
  compareProbes,
  detectDrift,
  DRIFT_VERDICTS,
  DRIFT_LIMITS,
} from "@/lib/comboAutoTune.js";

describe("comboAutoTune — scoreSeat", () => {
  it("returns -1 for no outcome", () => {
    expect(scoreSeat(null)).toBe(-1);
    expect(scoreSeat(undefined)).toBe(-1);
  });

  it("ranks a failing seat worst", () => {
    expect(scoreSeat({ ok: false })).toBeGreaterThan(10_000);
  });

  it("ranks an ok seat without latency worse than one with latency", () => {
    expect(scoreSeat({ ok: true, latencyMs: 0 })).toBe(50_000);
    expect(scoreSeat({ ok: true, latencyMs: 400 })).toBeLessThan(50_000);
  });

  it("orders fast before slower within the same bucket class", () => {
    const a = scoreSeat({ ok: true, latencyMs: 400 });
    const b = scoreSeat({ ok: true, latencyMs: 800 });
    expect(a).toBeLessThan(b);
  });

  it("keeps buckets separated: 1200 < 3000 < 6000", () => {
    const ms1200 = scoreSeat({ ok: true, latencyMs: 1200 });
    const ms3000 = scoreSeat({ ok: true, latencyMs: 3000 });
    const ms6000 = scoreSeat({ ok: true, latencyMs: 6000 });
    expect(ms1200).toBeLessThan(ms3000);
    expect(ms3000).toBeLessThan(ms6000);
  });
});

describe("comboAutoTune — tuneComboOrder", () => {
  it("returns an empty result for empty input", () => {
    expect(tuneComboOrder([], {})).toEqual({ order: [], changed: false, scores: {} });
    expect(tuneComboOrder(null, {}).order).toEqual([]);
  });

  it("moves a faster seat to the front", () => {
    const seats = ["slow", "fast"];
    const outcomes = {
      slow: { ok: true, latencyMs: 4000 },
      fast: { ok: true, latencyMs: 400 },
    };
    const result = tuneComboOrder(seats, outcomes);
    expect(result.order).toEqual(["fast", "slow"]);
    expect(result.changed).toBe(true);
  });

  it("moves a failing seat to the back", () => {
    const seats = ["broken", "ok"];
    const outcomes = {
      broken: { ok: false },
      ok: { ok: true, latencyMs: 500 },
    };
    expect(tuneComboOrder(seats, outcomes).order).toEqual(["ok", "broken"]);
  });

  it("leaves unprobed seats at their original position", () => {
    const seats = ["a", "b", "c"];
    const result = tuneComboOrder(seats, {});
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.changed).toBe(false);
  });

  it("is a no-op (changed=false) when the order already matches", () => {
    const seats = ["fast", "slow"];
    const outcomes = {
      fast: { ok: true, latencyMs: 200 },
      slow: { ok: true, latencyMs: 4000 },
    };
    const result = tuneComboOrder(seats, outcomes);
    expect(result.order).toEqual(["fast", "slow"]);
    expect(result.changed).toBe(false);
  });

  it("breaks score ties by original index (stable)", () => {
    const seats = ["a", "b", "c"];
    const outcomes = {
      a: { ok: true, latencyMs: 1000 },
      b: { ok: true, latencyMs: 1000 },
      c: { ok: true, latencyMs: 1000 },
    };
    expect(tuneComboOrder(seats, outcomes).order).toEqual(["a", "b", "c"]);
  });
});

describe("comboAutoTune — compareProbes", () => {
  it("flags a regression when a working seat stops answering", () => {
    const r = compareProbes({ ok: true, latencyMs: 400 }, { ok: false, error: "403 revoked" });
    expect(r.verdict).toBe(DRIFT_VERDICTS.REGRESSION);
    expect(r.reason).toBe("403 revoked");
  });

  it("flags a recovery when a failing seat starts answering", () => {
    const r = compareProbes({ ok: false }, { ok: true, latencyMs: 500 });
    expect(r.verdict).toBe(DRIFT_VERDICTS.RECOVERY);
  });

  it("reports 'still failing' as stable (no change to flag)", () => {
    const r = compareProbes({ ok: false }, { ok: false });
    expect(r.verdict).toBe(DRIFT_VERDICTS.STABLE);
    expect(r.reason).toBe("still failing");
  });

  it("flags slower when latency roughly doubles", () => {
    const r = compareProbes({ ok: true, latencyMs: 1000 }, { ok: true, latencyMs: 2500 });
    expect(r.verdict).toBe(DRIFT_VERDICTS.SLOWER);
  });

  it("flags faster when latency roughly halves", () => {
    const r = compareProbes({ ok: true, latencyMs: 4000 }, { ok: true, latencyMs: 1000 });
    expect(r.verdict).toBe(DRIFT_VERDICTS.FASTER);
  });

  it("ignores micro latency changes below the floor", () => {
    const r = compareProbes({ ok: true, latencyMs: 50 }, { ok: true, latencyMs: 120 });
    expect(r.verdict).toBe(DRIFT_VERDICTS.STABLE);
  });

  it("ignores sub-threshold jitter", () => {
    const r = compareProbes({ ok: true, latencyMs: 1000 }, { ok: true, latencyMs: 1500 });
    expect(r.verdict).toBe(DRIFT_VERDICTS.STABLE);
  });

  it("handles a missing baseline", () => {
    expect(compareProbes(null, { ok: true }).verdict).toBe(DRIFT_VERDICTS.STABLE);
    expect(compareProbes({ ok: true }, null).verdict).toBe(DRIFT_VERDICTS.STABLE);
  });
});

describe("comboAutoTune — detectDrift", () => {
  const previous = {
    good: { ok: true, latencyMs: 500 },
    wasok: { ok: true, latencyMs: 300 },
    stalled: { ok: false },
  };
  const current = {
    good: { ok: true, latencyMs: 500 },     // stable — should not appear
    wasok: { ok: false, error: "timeout" }, // regression
    stalled: { ok: true, latencyMs: 400 },  // recovery
  };

  it("reports only the notable changes", () => {
    const rows = detectDrift(previous, current);
    const models = rows.map((r) => r.model);
    expect(models).not.toContain("good");
    expect(models).toContain("wasok");
    expect(models).toContain("stalled");
  });

  it("ranks regressions above recoveries", () => {
    const rows = detectDrift(previous, current);
    expect(rows[0].model).toBe("wasok");
    expect(rows[0].verdict).toBe(DRIFT_VERDICTS.REGRESSION);
  });

  it("skips models that have no baseline", () => {
    const rows = detectDrift({}, { fresh: { ok: true } });
    expect(rows).toEqual([]);
  });

  it("sorts slower above recovery and faster", () => {
    const rows = detectDrift(
      { a: { ok: true, latencyMs: 1000 }, b: { ok: false }, c: { ok: true, latencyMs: 4000 } },
      { a: { ok: true, latencyMs: 4000 }, b: { ok: true, latencyMs: 500 }, c: { ok: true, latencyMs: 1000 } }
    );
    expect(rows[0].model).toBe("a"); // slower
    expect(rows[0].verdict).toBe(DRIFT_VERDICTS.SLOWER);
  });

  it("exposes the drift limits", () => {
    expect(DRIFT_LIMITS.LATENCY_DELTA_THRESHOLD).toBe(2.0);
    expect(DRIFT_LIMITS.LATENCY_FLOOR_MS).toBe(500);
  });
});
