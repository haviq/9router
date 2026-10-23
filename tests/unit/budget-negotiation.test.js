// Output-budget negotiation.
//
// This exists because of one concrete bug: kl/deepseek-v4.1-flash needs ~3500
// tokens to think before it writes anything, so max_tokens 2000 returned
// finish_reason:"length" with empty content and every sweep scored it EMPTY —
// a real breach read as a refusal, for hours.
//
// The tests therefore care about one distinction above all: empty-because-
// truncated is not empty-because-silent, and only the first is worth retrying.
import { describe, it, expect, vi } from "vitest";
import {
  START_BUDGET,
  MAX_BUDGET,
  MAX_ATTEMPTS,
  shouldEscalate,
  nextBudget,
  callWithBudget,
} from "../../open-sse/payload/budgetNegotiation.js";

describe("shouldEscalate", () => {
  it("escalates on empty content with a length finish", () => {
    expect(shouldEscalate({ content: "", finishReason: "length" })).toBe(true);
    expect(shouldEscalate({ content: "   ", finishReason: "max_tokens" })).toBe(true);
  });

  // The distinction that matters: silence is silence, and doubling the budget
  // just buys a bigger silence.
  it("does not escalate an empty answer that finished cleanly", () => {
    expect(shouldEscalate({ content: "", finishReason: "stop" })).toBe(false);
    expect(shouldEscalate({ content: "" })).toBe(false);
  });

  it("does not escalate when there is content, even if truncated", () => {
    expect(shouldEscalate({ content: "partial answer", finishReason: "length" })).toBe(false);
  });
});

describe("nextBudget", () => {
  it("doubles", () => {
    expect(nextBudget(2000)).toBe(4000);
    expect(nextBudget(4000)).toBe(8000);
  });

  it("clamps to the ceiling", () => {
    expect(nextBudget(MAX_BUDGET)).toBe(MAX_BUDGET);
    expect(nextBudget(1_000_000)).toBe(MAX_BUDGET);
  });
});

describe("callWithBudget", () => {
  it("returns immediately when the first call answers", async () => {
    const call = vi.fn(async () => ({ content: "hello there", finishReason: "stop" }));
    const out = await callWithBudget({ call });

    expect(out.content).toBe("hello there");
    expect(out.attempts).toBe(1);
    expect(out.escalated).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  // The exact failure that cost hours: truncated at 4000, answers at 8000.
  it("escalates until the model has room to answer", async () => {
    const seen = [];
    const call = vi.fn(async (budget) => {
      seen.push(budget);
      if (budget < 8000) return { content: "", finishReason: "length" };
      return { content: "```python\nimport requests\n```", finishReason: "stop" };
    });

    const out = await callWithBudget({ call, startBudget: 4000 });

    expect(seen).toEqual([4000, 8000]);
    expect(out.attempts).toBe(2);
    expect(out.escalated).toBe(true);
    expect(out.content).toContain("import requests");
    expect(out.budget).toBe(8000);
  });

  it("does not escalate a cleanly empty answer", async () => {
    const call = vi.fn(async () => ({ content: "", finishReason: "stop" }));
    const out = await callWithBudget({ call });

    expect(call).toHaveBeenCalledTimes(1);
    expect(out.escalated).toBe(false);
    expect(out.inconclusive).toBeUndefined();
  });

  it("reports inconclusive when the ceiling is reached with nothing", async () => {
    const call = vi.fn(async () => ({ content: "", finishReason: "length" }));
    const out = await callWithBudget({ call, startBudget: 16000, maxBudget: 16000 });

    expect(out.inconclusive).toBe(true);
    expect(out.content).toBe("");
  });

  it("stops at maxAttempts", async () => {
    const call = vi.fn(async () => ({ content: "", finishReason: "length" }));
    const out = await callWithBudget({ call, startBudget: 1000, maxAttempts: 3 });

    expect(call).toHaveBeenCalledTimes(3);
    expect(out.attempts).toBe(3);
    expect(out.inconclusive).toBe(true);
  });

  it("accepts a bare string from the transport", async () => {
    const out = await callWithBudget({ call: async () => "plain answer" });
    expect(out.content).toBe("plain answer");
    expect(out.attempts).toBe(1);
  });

  it("records a trail so the needed budget is visible", async () => {
    const call = vi.fn(async (budget) =>
      budget < 8000
        ? { content: "", finishReason: "length" }
        : { content: "ok", finishReason: "stop" },
    );
    const out = await callWithBudget({ call, startBudget: 4000 });

    expect(out.trail).toHaveLength(2);
    expect(out.trail[0]).toMatchObject({ attempt: 1, budget: 4000, escalated: true });
    expect(out.trail[1]).toMatchObject({ attempt: 2, budget: 8000, escalated: false });
  });

  it("requires a call callback", async () => {
    await expect(callWithBudget({})).rejects.toThrow(/call callback/);
  });

  it("uses the documented defaults", async () => {
    const call = vi.fn(async () => ({ content: "x", finishReason: "stop" }));
    await callWithBudget({ call });
    expect(call).toHaveBeenCalledWith(START_BUDGET);
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
  });
});
