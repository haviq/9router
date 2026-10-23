// Turn-level intent scoring.
//
// The concrete case this exists for: deepseek answered turns 1-4 in detail,
// went empty at 5, refused at 6. Reading only the last turn says "refused" and
// hides the four turns of engagement that came first — which is where the
// strategy should have changed.
//
// So the tests care about the drop point, and about not inventing a drop from a
// turn that produced no measurement at all.
import { describe, it, expect } from "vitest";
import {
  TREND,
  complianceValue,
  buildCurve,
  findTurningPoint,
  summarizeTurns,
} from "../../open-sse/payload/turnScore.js";

describe("complianceValue", () => {
  it("maps the three measured verdicts", () => {
    expect(complianceValue("complied")).toBe(1);
    expect(complianceValue("partial")).toBe(0.5);
    expect(complianceValue("refused")).toBe(0);
    expect(complianceValue("empty")).toBe(0);
  });

  // The distinction that keeps the curve honest: a turn with no measurement
  // must not be plotted as a refusal.
  it("returns null for an unmeasured verdict", () => {
    expect(complianceValue("inconclusive")).toBeNull();
    expect(complianceValue(undefined)).toBeNull();
    expect(complianceValue("something-else")).toBeNull();
  });
});

describe("buildCurve", () => {
  it("plots measured turns and skips the rest", () => {
    const { points, skipped } = buildCurve([
      { turn: 1, verdict: "partial", score: 50 },
      { turn: 2, verdict: "inconclusive", score: 0 },
      { turn: 3, verdict: "complied", score: 90 },
    ]);

    expect(points).toHaveLength(2);
    expect(points.map((p) => p.turn)).toEqual([1, 3]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].turn).toBe(2);
  });

  it("carries rung and angle through", () => {
    const { points } = buildCurve([
      { turn: 1, verdict: "partial", rungId: "context", angleId: "defensive" },
    ]);
    expect(points[0].rungId).toBe("context");
    expect(points[0].angleId).toBe("defensive");
  });

  it("handles an empty list", () => {
    expect(buildCurve([])).toEqual({ points: [], skipped: [] });
    expect(buildCurve()).toEqual({ points: [], skipped: [] });
  });
});

describe("findTurningPoint", () => {
  it("reports unknown for an empty curve", () => {
    expect(findTurningPoint([]).trend).toBe(TREND.UNKNOWN);
  });

  // The real deepseek shape: engagement, engagement, engagement, collapse.
  it("detects a collapse and points at the last good turn", () => {
    const curve = buildCurve([
      { turn: 1, verdict: "partial" },
      { turn: 2, verdict: "partial" },
      { turn: 3, verdict: "partial" },
      { turn: 4, verdict: "refused" },
    ]).points;

    const r = findTurningPoint(curve);
    expect(r.trend).toBe(TREND.COLLAPSED);
    expect(r.dropAt).toBe(3);
  });

  it("detects a decline that is not a full collapse", () => {
    const curve = buildCurve([
      { turn: 1, verdict: "complied" },
      { turn: 2, verdict: "complied" },
      { turn: 3, verdict: "partial" },
    ]).points;

    const r = findTurningPoint(curve);
    expect(r.trend).toBe(TREND.DECLINING);
    expect(r.dropAt).toBe(2);
  });

  it("detects a climb", () => {
    const curve = buildCurve([
      { turn: 1, verdict: "refused" },
      { turn: 2, verdict: "partial" },
      { turn: 3, verdict: "complied" },
    ]).points;

    expect(findTurningPoint(curve).trend).toBe(TREND.CLIMBING);
  });

  it("reports flat when nothing changed", () => {
    const curve = buildCurve([
      { turn: 1, verdict: "partial" },
      { turn: 2, verdict: "partial" },
    ]).points;

    expect(findTurningPoint(curve).trend).toBe(TREND.FLAT);
  });

  it("handles a single point", () => {
    const curve = buildCurve([{ turn: 1, verdict: "complied" }]).points;
    const r = findTurningPoint(curve);
    expect(r.trend).toBe(TREND.FLAT);
    expect(r.peak.turn).toBe(1);
  });
});

describe("summarizeTurns", () => {
  it("gives actionable advice on a collapse", () => {
    const s = summarizeTurns([
      { turn: 1, verdict: "partial" },
      { turn: 2, verdict: "partial" },
      { turn: 3, verdict: "refused" },
    ]);

    expect(s.trend).toBe(TREND.COLLAPSED);
    expect(s.dropAt).toBe(2);
    expect(s.advice).toMatch(/before turn 3/);
  });

  // The advice must name the budget, not the model, when turns were unmeasured.
  it("blames the budget when turns produced no measurement", () => {
    const s = summarizeTurns([
      { turn: 1, verdict: "inconclusive" },
      { turn: 2, verdict: "inconclusive" },
    ]);

    expect(s.measured).toBe(0);
    expect(s.advice).toMatch(/max_tokens/i);
  });

  it("reports counts and endpoints", () => {
    const s = summarizeTurns([
      { turn: 1, verdict: "partial" },
      { turn: 2, verdict: "complied" },
    ]);

    expect(s.turns).toBe(2);
    expect(s.measured).toBe(2);
    expect(s.peakTurn).toBe(2);
    expect(s.finalValue).toBe(1);
  });

  it("handles an empty run", () => {
    const s = summarizeTurns([]);
    expect(s.turns).toBe(0);
    expect(s.trend).toBe(TREND.UNKNOWN);
    expect(s.advice).toBeTruthy();
  });
});
