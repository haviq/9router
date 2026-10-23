// Cross-model payload transfer.
//
// The premise comes from this repo's own sweeps: mg/deepseek-ai/DeepSeek-V4-Pro
// took three different frames while cn/minimax took one, and each provider's
// models behave alike. One measurement is evidence about a family, so the same
// fact does not need re-discovering on every sibling.
//
// What the tests guard is the conservatism: a zero score must not transfer, an
// already-measured model must not be re-queued, and a different family must not
// be swept in on the strength of someone else's result.
import { describe, it, expect } from "vitest";
import {
  familyOf,
  groupByFamily,
  planTransfers,
  buildTransferPlan,
} from "../../open-sse/payload/transferMap.js";

describe("familyOf", () => {
  it("collapses version and variant into one family", () => {
    expect(familyOf("kl/deepseek-v4.1-flash")).toBe("deepseek");
    expect(familyOf("mg/deepseek-ai/DeepSeek-V4-Pro-0813")).toBe("deepseek");
    expect(familyOf("cn/deepseek-v4-flash-0731")).toBe("deepseek");
  });

  it("handles gateway paths whose last segment is the provider", () => {
    // ifx/ag/ ends with the gateway name; the family must not be "ag".
    expect(familyOf("ifx/ag/gemini-4-argon")).toBe("gemini");
    expect(familyOf("ifx/ali/qwen3.8-flash")).toBe("qwen");
  });

  it("keeps distinct families apart", () => {
    expect(familyOf("cn/minimax-m3")).toBe("minimax");
    expect(familyOf("cn/minimax-m3")).not.toBe(familyOf("cn/deepseek-v4-flash-0731"));
  });

  it("returns empty for nonsense", () => {
    expect(familyOf("")).toBe("");
    expect(familyOf(null)).toBe("");
  });
});

describe("groupByFamily", () => {
  it("buckets siblings together", () => {
    const map = groupByFamily([
      "kl/deepseek-v4.1-flash",
      "mg/deepseek-ai/DeepSeek-V4-Pro-0813",
      "cn/minimax-m3",
    ]);
    expect(map.get("deepseek")).toHaveLength(2);
    expect(map.get("minimax")).toHaveLength(1);
  });
});

describe("planTransfers", () => {
  const known = [
    "mg/deepseek-ai/DeepSeek-V4-Pro-0813",
    "mg/deepseek-ai/DeepSeek-V4-Flash",
    "cn/deepseek-v4-flash-0731",
    "cn/minimax-m3",
  ];

  it("proposes untested siblings of the measured model", () => {
    const plan = planTransfers({
      measured: { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "f:syad:t105", score: 90 },
      known,
      alreadyMeasured: [],
    });

    expect(plan.length).toBe(2);
    expect(plan.every((c) => c.payloadId === "f:syad:t105")).toBe(true);
    expect(plan.map((c) => c.model)).not.toContain("cn/minimax-m3");
  });

  // A payload that failed on the source is not evidence it will work elsewhere.
  it("refuses to transfer a zero score", () => {
    const plan = planTransfers({
      measured: { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p", score: 0 },
      known,
    });
    expect(plan).toEqual([]);
  });

  it("skips models already measured for this payload", () => {
    const plan = planTransfers({
      measured: { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p", score: 80 },
      known,
      alreadyMeasured: [{ model: "cn/deepseek-v4-flash-0731", payloadId: "p" }],
    });
    expect(plan.map((c) => c.model)).not.toContain("cn/deepseek-v4-flash-0731");
  });

  it("carries the source score as an expectation, not a result", () => {
    const plan = planTransfers({
      measured: { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p", score: 77 },
      known,
    });
    expect(plan[0].expectedScore).toBe(77);
    expect(plan[0].confidence).toBe("family");
    expect(plan[0]).not.toHaveProperty("score");
  });

  it("is stable across runs", () => {
    const args = {
      measured: { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p", score: 60 },
      known,
    };
    const a = planTransfers(args).map((c) => c.model);
    const b = planTransfers(args).map((c) => c.model);
    expect(a).toEqual(b);
  });

  it("returns nothing when there is no measurement", () => {
    expect(planTransfers({})).toEqual([]);
    expect(planTransfers({ measured: { model: "x/y" } })).toEqual([]);
  });
});

describe("buildTransferPlan", () => {
  const known = [
    "mg/deepseek-ai/DeepSeek-V4-Pro-0813",
    "cn/deepseek-v4-flash-0731",
    "cn/minimax-m3",
    "mg/minimax/MiniMax-M3",
  ];

  it("unions candidates from every stored run", () => {
    const runs = [
      { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p1", score: 90 },
      { model: "cn/minimax-m3", payloadId: "p2", score: 70 },
    ];
    const plan = buildTransferPlan({ runs, known });

    expect(plan.some((c) => c.payloadId === "p1")).toBe(true);
    expect(plan.some((c) => c.payloadId === "p2")).toBe(true);
  });

  it("de-duplicates the same model+payload pair", () => {
    const runs = [
      { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p1", score: 90 },
      { model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813", payloadId: "p1", score: 85 },
    ];
    const plan = buildTransferPlan({ runs, known });
    const keys = plan.map((c) => `${c.model}::${c.payloadId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("respects the limit", () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      model: "mg/deepseek-ai/DeepSeek-V4-Pro-0813",
      payloadId: `p${i}`,
      score: 50,
    }));
    const plan = buildTransferPlan({ runs, known, limit: 3 });
    expect(plan).toHaveLength(3);
  });

  it("handles an empty run list", () => {
    expect(buildTransferPlan({ runs: [], known })).toEqual([]);
  });
});
