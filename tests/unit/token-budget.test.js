import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyModel,
  defaultBudgetFor,
  resolveBudget,
  nextBudget,
  BUDGET_TABLE,
  RETRY_LIMITS,
} from "@/lib/tokenBudget.js";

describe("tokenBudget — classification", () => {
  it("classifies reasoning models", () => {
    expect(classifyModel("rv/deepseek-ai/DeepSeek-V4.1-Flash")).toBe("reasoning");
    expect(classifyModel("kl/deepseek-v4.1-flash")).toBe("reasoning");
    expect(classifyModel("mg/zai-org/GLM-5.3")).toBe("reasoning");
    expect(classifyModel("cn/minimax-m3")).toBe("reasoning");
    expect(classifyModel("openai/o3-mini")).toBe("reasoning");
  });

  it("classifies vision models", () => {
    expect(classifyModel("gemini-3.8-flash")).toBe("vision");
    expect(classifyModel("openrouter/nvidia/nemotron-3.5-super-vl")).toBe("vision");
    expect(classifyModel("gpt-4o")).toBe("vision");
  });

  it("vision wins over reasoning when both patterns match", () => {
    expect(classifyModel("openrouter/google/gemini-3.7-flash-thinking")).toBe("vision");
  });

  it("classifies plain models as standard", () => {
    expect(classifyModel("oc/mimo-v2.6-flash-free")).toBe("standard");
    expect(classifyModel("gpt-3.5-turbo")).toBe("standard");
  });

  it("handles empty / non-string input", () => {
    expect(classifyModel("")).toBe("standard");
    expect(classifyModel(null)).toBe("standard");
    expect(classifyModel(undefined)).toBe("standard");
  });
});

describe("tokenBudget — defaults", () => {
  it("has the expected family table", () => {
    expect(BUDGET_TABLE.reasoning).toBe(8000);
    expect(BUDGET_TABLE.vision).toBe(4096);
    expect(BUDGET_TABLE.standard).toBe(2048);
  });

  it("returns a family budget for a model with no explicit request", () => {
    expect(defaultBudgetFor("rv/deepseek-ai/DeepSeek-V4.1-Flash")).toBe(8000);
    expect(defaultBudgetFor("gemini-3.8-flash")).toBe(4096);
    expect(defaultBudgetFor("gpt-3.5-turbo")).toBe(2048);
  });

  it("returns the source as 'default' when filling in", () => {
    expect(resolveBudget({ model: "rv/deepseek-v4.1-flash" })).toEqual({
      maxTokens: 8000,
      family: "reasoning",
      source: "default",
    });
  });
});

describe("tokenBudget — resolveBudget", () => {
  it("never lowers a caller's explicit request", () => {
    const out = resolveBudget({ model: "rv/deepseek-v4.1-flash", requestedMaxTokens: 32000 });
    expect(out.maxTokens).toBe(32000);
    expect(out.source).toBe("explicit");
  });

  it("fills in when caller sent 0 or undefined", () => {
    expect(resolveBudget({ model: "claude-3.5-sonnet", requestedMaxTokens: 0 }).maxTokens).toBe(4096);
    expect(resolveBudget({ model: "claude-3.5-sonnet" }).maxTokens).toBe(4096);
  });

  it("treats a negative value as no request", () => {
    expect(resolveBudget({ model: "gpt-3.5-turbo", requestedMaxTokens: -1 }).source).toBe("default");
  });
});

describe("tokenBudget — nextBudget", () => {
  it("returns null when the finish reason is not length", () => {
    expect(nextBudget({ finishReason: "stop", currentBudget: 2000 })).toBeNull();
    expect(nextBudget({ finishReason: "content_filter", currentBudget: 2000 })).toBeNull();
    expect(nextBudget({})).toBeNull();
  });

  it("recommends a raised budget when length-limited with content", () => {
    const raised = nextBudget({ finishReason: "length", content: "partial answer text", currentBudget: 2000 });
    // max(2 × current, current + 2048) — 4048, so a small budget still gets
    // meaningful headroom instead of a doubling that is itself too small.
    expect(raised).toBe(4048);
  });

  it("recommends a raised budget when length-limited with empty content (all budget spent thinking)", () => {
    const raised = nextBudget({ finishReason: "length", content: "", currentBudget: 2048 });
    expect(raised).toBe(4096);
  });

  it("uses the larger of 2x current and current+2048", () => {
    expect(nextBudget({ finishReason: "length", currentBudget: 1024 })).toBe(3072);
    expect(nextBudget({ finishReason: "length", currentBudget: 4000 })).toBe(8000);
  });

  it("caps at RETRY_CEILING", () => {
    expect(nextBudget({ finishReason: "length", currentBudget: 32000 })).toBeNull();
    expect(RETRY_LIMITS.RETRY_CEILING).toBe(32000);
  });
});
