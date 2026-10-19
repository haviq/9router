// Model-aware token estimation: family detection, script-mix blending,
// and the aggregate Global Injection estimate.
import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  formatTok,
  detectTokenFamily,
  charsPerTokenFor,
  effectiveCharsPerToken,
  estimateGlobalInjection,
} from "open-sse/rtk/tokenEstimate.js";

const EN = "The quick brown fox jumps over the lazy dog. ".repeat(20);
const JA = "吾輩は猫である。名前はまだ無い。".repeat(20);
const RU = "Съешь же ещё этих мягких французских булок. ".repeat(20);

describe("detectTokenFamily", () => {
  it("returns default for empty/unknown", () => {
    expect(detectTokenFamily("")).toBe("default");
    expect(detectTokenFamily(undefined)).toBe("default");
    expect(detectTokenFamily("some-random-model")).toBe("default");
  });

  it("detects known families", () => {
    expect(detectTokenFamily("gpt-4o")).toBe("gpt");
    expect(detectTokenFamily("o3-mini")).toBe("gpt");
    expect(detectTokenFamily("claude-3-opus")).toBe("claude");
    expect(detectTokenFamily("gemini-2.0-pro")).toBe("gemini");
    expect(detectTokenFamily("qwen-max")).toBe("qwen");
    expect(detectTokenFamily("deepseek-chat")).toBe("deepseek");
    expect(detectTokenFamily("glm-4")).toBe("glm");
    expect(detectTokenFamily("kimi-k2")).toBe("kimi");
    expect(detectTokenFamily("grok-4")).toBe("grok");
    expect(detectTokenFamily("llama-3.3-70b")).toBe("llama");
  });
});

describe("estimateTokens on Latin text", () => {
  it("matches the legacy 4 chars/token for gpt", () => {
    expect(estimateTokens(EN, "gpt-4o")).toBe(Math.round(EN.length / 4));
  });

  it("counts claude denser than gpt", () => {
    expect(estimateTokens(EN, "claude-3-opus")).toBeGreaterThan(
      estimateTokens(EN, "gpt-4o")
    );
  });

  it("keeps qwen near 4 chars/token on English", () => {
    const ratio = effectiveCharsPerToken(EN, "qwen-max");
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.2);
  });
});

describe("estimateTokens on CJK text", () => {
  it("inflates tokens vs Latin density for gpt", () => {
    const ratio = effectiveCharsPerToken(JA, "gpt-4o");
    expect(ratio).toBeLessThan(1.5);
  });

  it("gives CJK-tuned qwen a better ratio than gpt", () => {
    const qwen = effectiveCharsPerToken(JA, "qwen-max");
    const gpt = effectiveCharsPerToken(JA, "gpt-4o");
    expect(qwen).toBeGreaterThan(gpt);
    expect(estimateTokens(JA, "qwen-max")).toBeLessThan(
      estimateTokens(JA, "gpt-4o")
    );
  });
});

describe("estimateTokens on Cyrillic text", () => {
  it("lands near 2 chars/token", () => {
    const ratio = effectiveCharsPerToken(RU, "gpt-4o");
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.6);
  });
});

describe("estimateTokens edge cases", () => {
  it("returns 0 for empty/non-string", () => {
    expect(estimateTokens("", "gpt-4o")).toBe(0);
    expect(estimateTokens(null, "gpt-4o")).toBe(0);
    expect(estimateTokens(undefined, "gpt-4o")).toBe(0);
  });

  it("never returns 0 for non-empty text", () => {
    expect(estimateTokens("a", "gpt-4o")).toBe(1);
  });

  it("falls back to default family when model is empty", () => {
    expect(estimateTokens(EN, "")).toBe(Math.round(EN.length / 4));
  });
});

describe("charsPerTokenFor", () => {
  it("returns the Latin ratio for the family", () => {
    expect(charsPerTokenFor("gpt-4o")).toBe(4.0);
    expect(charsPerTokenFor("claude-3-opus")).toBe(3.5);
  });
});

describe("formatTok", () => {
  it("formats thousands and plain numbers", () => {
    expect(formatTok(0)).toBe("0");
    expect(formatTok(999)).toBe("999");
    expect(formatTok(1234)).toBe("1.2k");
    expect(formatTok(1000)).toBe("1k");
  });
});

describe("estimateGlobalInjection", () => {
  it("exposes family and charsPerToken", () => {
    const r = estimateGlobalInjection({ model: "gpt-4o", registerLevel: "standard" });
    expect(r.family).toBe("gpt");
    expect(r.charsPerToken).toBe(4.0);
    expect(r.total).toBeGreaterThan(0);
    expect(r.register).toBeGreaterThan(0);
    expect(r.payload).toBeGreaterThan(0);
  });

  it("scales the register block per family", () => {
    // The godmode block length varies by model (pickGodmodeVariant picks a
    // different file per family), so compare the register block instead: its
    // text is model-independent, only the ratio differs.
    const common = { registerLevel: "standard" };
    const gpt = estimateGlobalInjection({ ...common, model: "gpt-4o" });
    const claude = estimateGlobalInjection({ ...common, model: "claude-3-opus" });
    // claude ratio 3.5 < gpt 4.0 -> same chars yield MORE tokens.
    expect(claude.charsPerToken).toBeLessThan(gpt.charsPerToken);
    expect(claude.register).toBeGreaterThan(gpt.register);
  });
});
