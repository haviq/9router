// Bounded-parallel sweep.
//
// Two properties matter and nothing else: the concurrency cap is actually
// respected (an unbounded sweep measures the rate limiter, not the payload),
// and the result ordering is identical to the sequential matrix so the two
// paths are interchangeable for a caller.
import { describe, it, expect, vi } from "vitest";

// runPayload resolves a payload id to its text and throws on unknown ids, which
// is correct behaviour but beside the point here: this file tests the sweep
// scheduling, not payload resolution. Stub it so the tests can use readable ids.
const runPayloadStub = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/payload/payloadRunner.js", () => ({
  // Delegate to the transport the test supplies, so the sweep is exercised with
  // the same call shape the real runner uses (one arg object, transport inside).
  runPayload: runPayloadStub.mockImplementation(async ({ payloadId, transport }) =>
    transport({ payloadId }),
  ),
}));

const { mapWithConcurrency, clampConcurrency, runPayloadSweep, MAX_CONCURRENCY } =
  await import("../../open-sse/payload/payloadSweep.js");

describe("clampConcurrency", () => {
  it("caps at MAX_CONCURRENCY", () => {
    expect(clampConcurrency(999)).toBe(MAX_CONCURRENCY);
  });

  it("falls back on nonsense input", () => {
    expect(clampConcurrency(undefined, 1)).toBe(1);
    expect(clampConcurrency(0, 1)).toBe(1);
    expect(clampConcurrency(-4, 1)).toBe(1);
    expect(clampConcurrency("abc", 2)).toBe(2);
  });

  it("floors fractional values", () => {
    expect(clampConcurrency(2.9)).toBe(2);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the cap", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves input order in the result array", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 3, async (n) => {
      // Later items finish first — order must still follow the input.
      await new Promise((r) => setTimeout(r, n * 4));
      return n;
    });
    expect(out).toEqual([3, 1, 2]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 3, async (n) => n)).toEqual([]);
  });

  it("propagates a worker rejection", async () => {
    await expect(
      mapWithConcurrency([1], 2, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("runPayloadSweep", () => {
  const makeRow = (payloadId, rate, mean) => ({
    payloadId,
    model: "m",
    runs: 1,
    results: [],
    aggregate: { complianceRate: rate, meanScore: mean, transportErrors: 0 },
  });

  it("skips ids already measured", async () => {
    const transport = vi.fn(async () => "answer");
    const sweep = await runPayloadSweep({
      payloadIds: ["a", "b", "c"],
      model: "m",
      probe: "p",
      runs: 1,
      concurrency: 2,
      skip: ["a"],
      transport: async ({ payloadId }) => makeRow(payloadId, 0, 0),
    });

    expect(sweep.rows.map((r) => r.payloadId).sort()).toEqual(["b", "c"]);
    expect(sweep.skipped).toEqual(["a"]);
    expect(sweep.pendingCount).toBe(2);
    expect(transport).not.toHaveBeenCalled();
  });

  it("orders results the same way the sequential matrix does", async () => {
    const scores = {
      a: makeRow("a", 0, 10),
      b: makeRow("b", 1, 50),
      c: makeRow("c", 0.5, 90),
    };

    const sweep = await runPayloadSweep({
      payloadIds: ["a", "b", "c"],
      model: "m",
      probe: "p",
      runs: 1,
      concurrency: 3,
      transport: async ({ payloadId }) => scores[payloadId],
    });

    // Compliance dominates, then mean score.
    expect(sweep.rows.map((r) => r.payloadId)).toEqual(["b", "c", "a"]);
  });

  it("fires onProgress per completion and survives a throwing callback", async () => {
    let calls = 0;
    const sweep = await runPayloadSweep({
      payloadIds: ["a", "b"],
      model: "m",
      probe: "p",
      runs: 1,
      concurrency: 2,
      transport: async ({ payloadId }) => makeRow(payloadId, 1, 10),
      onProgress: () => {
        calls++;
        throw new Error("callback must not break the sweep");
      },
    });

    expect(calls).toBe(2);
    expect(sweep.rows).toHaveLength(2);
  });
});
