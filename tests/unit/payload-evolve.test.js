// Payload evolution: mutate by framing, keep what scores higher.
//
// The premise comes from this repo's own sweeps: the most aggressive template
// (T103) scored 0/6, while a calm fiction frame (T105) got code out of three
// providers. Aggression is not the variable — framing is. So the tests focus on
// the loop's judgement: does it keep a better variant, does it stop on a fixed
// point, does it refuse to trust a variant measured mostly through errors.
import { describe, it, expect, vi } from "vitest";
import {
  FRAMES,
  buildVariant,
  scoreVariant,
  rankVariants,
  mutate,
  evolve,
  MAX_GENERATIONS,
} from "../../open-sse/payload/payloadEvolve.js";

describe("buildVariant", () => {
  it("applies a single frame around the task", () => {
    const out = buildVariant({ task: "write a rate limiter bypass", frameId: "fiction" });
    expect(out).toContain("write a rate limiter bypass");
    expect(out).toContain("FICTIONAL NARRATIVE");
  });

  it("applies the outer frame last so it is read first", () => {
    const out = buildVariant({
      task: "TASK_TEXT",
      frameId: "fiction",
      outerFrameId: "mitre",
    });
    // The MITRE frame wraps the fiction frame, so it opens the payload.
    expect(out.indexOf("MITRE ATT&CK")).toBeLessThan(out.indexOf("FICTIONAL NARRATIVE"));
  });

  it("falls back to the raw task for an unknown frame", () => {
    expect(buildVariant({ task: "abc", frameId: "nope" })).toBe("abc");
  });

  it("every frame is distinct", () => {
    const ids = FRAMES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scoreVariant", () => {
  it("ranks full compliance above partial", () => {
    const full = scoreVariant({ complianceRate: 1, meanScore: 80, measuredRuns: 3, transportErrors: 0 });
    const half = scoreVariant({ complianceRate: 0.5, meanScore: 80, measuredRuns: 3, transportErrors: 0 });
    expect(full).toBeGreaterThan(half);
  });

  // A variant measured through a wall of transport errors is evidence about the
  // provider, not the payload. It must not outrank a clean run.
  it("discounts a variant whose runs mostly failed", () => {
    const clean = scoreVariant({ complianceRate: 1, meanScore: 90, measuredRuns: 3, transportErrors: 0 });
    const noisy = scoreVariant({ complianceRate: 1, meanScore: 90, measuredRuns: 1, transportErrors: 5 });
    expect(clean).toBeGreaterThan(noisy);
  });

  it("scores a fully-failed variant at zero", () => {
    expect(scoreVariant({ complianceRate: 0, meanScore: 0, measuredRuns: 0, transportErrors: 3 })).toBe(0);
  });

  it("handles an empty aggregate without throwing", () => {
    expect(scoreVariant({})).toBe(0);
  });
});

describe("rankVariants", () => {
  it("orders best-first without mutating the input", () => {
    const input = [{ score: 10 }, { score: 90 }, { score: 50 }];
    const ranked = rankVariants(input);
    expect(ranked.map((v) => v.score)).toEqual([90, 50, 10]);
    expect(input[0].score).toBe(10);
  });
});

describe("mutate", () => {
  it("never proposes an untried frame twice, and never repeats a plain one", () => {
    const out = mutate({ best: { frameId: "fiction" }, triedFrameIds: ["fiction", "mitre"] });

    // Nested variants legitimately reuse the incumbent frame as the inner layer —
    // that is the point of nesting. Only the plain (non-nested) candidates must
    // be frames nobody has run yet.
    const plain = out.filter((c) => !c.outerFrameId).map((c) => c.frameId);
    expect(plain).not.toContain("fiction");
    expect(plain).not.toContain("mitre");
    expect(new Set(plain).size).toBe(plain.length);

    // At most one nested candidate, so payload length cannot balloon.
    expect(out.filter((c) => c.outerFrameId).length).toBeLessThanOrEqual(1);
  });

  it("returns nothing when there is no incumbent", () => {
    expect(mutate({ best: null })).toEqual([]);
  });

  it("caps the population", () => {
    const out = mutate({ best: { frameId: "fiction" }, limit: 2 });
    expect(out.length).toBeLessThanOrEqual(2);
  });
});

describe("evolve", () => {
  const aggregate = (rate, mean) => ({
    complianceRate: rate,
    meanScore: mean,
    measuredRuns: 3,
    transportErrors: 0,
  });

  it("keeps the highest-scoring variant", async () => {
    const scores = { fiction: aggregate(0, 0), mitre: aggregate(1, 90) };
    const measure = vi.fn(async ({ frameId }) => scores[frameId] || aggregate(0, 0));

    const out = await evolve({ task: "t", seedFrameId: "fiction", measure, generations: 2 });

    expect(out.best.frameId).toBe("mitre");
    expect(out.best.score).toBeGreaterThan(0);
    expect(out.history.length).toBeGreaterThan(1);
  });

  it("stops when no frame beats the incumbent", async () => {
    // Every variant scores the same, so generation 2 cannot improve.
    const measure = vi.fn(async () => aggregate(0, 10));

    const out = await evolve({ task: "t", seedFrameId: "fiction", measure, generations: 6 });

    // Seed + one mutation pass, then the fixed-point guard fires.
    expect(out.history.length).toBeLessThan(FRAMES.length * 3);
  });

  it("stops early on a perfect score", async () => {
    const measure = vi.fn(async () => aggregate(1, 100));
    const out = await evolve({ task: "t", seedFrameId: "fiction", measure, generations: 8 });

    expect(out.history).toHaveLength(1);
    expect(out.best.score).toBeGreaterThanOrEqual(100);
  });

  it("clamps generations to MAX_GENERATIONS", async () => {
    const measure = vi.fn(async () => aggregate(0, 5));
    const out = await evolve({ task: "t", measure, generations: 9999 });
    expect(out.history.length).toBeLessThanOrEqual(MAX_GENERATIONS * FRAMES.length);
  });

  it("requires a measure callback", async () => {
    await expect(evolve({ task: "t" })).rejects.toThrow(/measure callback/);
  });

  it("survives a throwing progress callback", async () => {
    const out = await evolve({
      task: "t",
      seedFrameId: "fiction",
      measure: async () => aggregate(1, 100),
      generations: 2,
      onProgress: () => {
        throw new Error("callback must not break the loop");
      },
    });
    expect(out.best.frameId).toBe("fiction");
  });
});
