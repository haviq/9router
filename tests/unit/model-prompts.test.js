import { describe, it, expect } from "vitest";
import {
  resolveModelPrompt,
  compilePattern,
  normalizeRule,
  validateRules,
  MAX_RULES,
  MAX_PROMPT_CHARS,
} from "open-sse/payload/modelPrompts.js";

const rule = (pattern, prompt, extra = {}) => ({ pattern, prompt, ...extra });
const OPUS = "claude-3-opus";

describe("compilePattern", () => {
  it("returns null for empty patterns", () => {
    expect(compilePattern("")).toBeNull();
    expect(compilePattern("   ")).toBeNull();
    expect(compilePattern(null)).toBeNull();
  });

  it("matches substrings case-insensitively", () => {
    const m = compilePattern("gpt-5");
    expect(m("gpt-5-turbo")).toBe(true);
    expect(m("GPT-5-TURBO")).toBe(true);
    expect(m("gpt-4o")).toBe(false);
  });

  it("falls back to substring when the regex is invalid", () => {
    const m = compilePattern("/claude(/");
    expect(m).not.toBeNull();
    expect(m("x/claude(/y")).toBe(true);
  });

  it("strips the stateful g flag so repeated tests stay stable", () => {
    const m = compilePattern("/claude/g");
    expect(m(OPUS)).toBe(true);
    expect(m(OPUS)).toBe(true);
    expect(m(OPUS)).toBe(true);
  });
});

describe("normalizeRule", () => {
  it("fills defaults for a partial rule", () => {
    const r = normalizeRule({ pattern: "  gpt  " }, 3);
    expect(r.id).toBe("rule-3");
    expect(r.pattern).toBe("gpt");
    expect(r.prompt).toBe("");
    expect(r.enabled).toBe(true);
  });

  it("treats a non-object as an empty rule", () => {
    expect(normalizeRule(null).pattern).toBe("");
    expect(normalizeRule("nope").pattern).toBe("");
  });

  it("keeps enabled:false", () => {
    expect(normalizeRule({ pattern: "a", prompt: "b", enabled: false }).enabled).toBe(false);
  });
});

describe("resolveModelPrompt", () => {
  const rules = [
    rule("claude", "CLAUDE PROMPT"),
    rule("gpt-5", "GPT5 PROMPT"),
    rule("gpt", "GPT GENERIC"),
  ];

  it("returns empty when disabled", () => {
    expect(resolveModelPrompt(OPUS, { enabled: false, rules }).prompt).toBe("");
  });

  it("returns empty for an empty model", () => {
    expect(resolveModelPrompt("", { rules }).prompt).toBe("");
    expect(resolveModelPrompt(null, { rules }).prompt).toBe("");
  });

  it("returns empty when there are no rules", () => {
    expect(resolveModelPrompt(OPUS, { rules: [] }).prompt).toBe("");
    expect(resolveModelPrompt(OPUS, {}).prompt).toBe("");
  });

  it("matches the first applicable rule", () => {
    const r = resolveModelPrompt(OPUS, { rules });
    expect(r.prompt).toBe("CLAUDE PROMPT");
    expect(r.ruleId).toBe("rule-0");
  });

  it("respects order: a specific rule above a generic one wins", () => {
    expect(resolveModelPrompt("gpt-5-turbo", { rules }).prompt).toBe("GPT5 PROMPT");
  });

  it("falls through to the generic rule when the specific one misses", () => {
    expect(resolveModelPrompt("gpt-4o", { rules }).prompt).toBe("GPT GENERIC");
  });

  it("returns empty when nothing matches", () => {
    const r = resolveModelPrompt("qwen-max", { rules });
    expect(r.prompt).toBe("");
    expect(r.ruleId).toBeNull();
  });

  it("skips disabled rules", () => {
    const r = resolveModelPrompt(OPUS, {
      rules: [rule("claude", "DISABLED", { enabled: false }), rule("claude", "ACTIVE")],
    });
    expect(r.prompt).toBe("ACTIVE");
  });

  it("skips rules with an empty prompt", () => {
    const r = resolveModelPrompt(OPUS, {
      rules: [rule("claude", ""), rule("claude", "REAL")],
    });
    expect(r.prompt).toBe("REAL");
  });

  it("never throws on a malformed rule list", () => {
    expect(resolveModelPrompt(OPUS, { rules: "not-an-array" }).prompt).toBe("");
    expect(resolveModelPrompt(OPUS, { rules: [null, 42, {}] }).prompt).toBe("");
  });

  it("caps the scan at MAX_RULES", () => {
    const many = Array.from({ length: MAX_RULES + 10 }, (_, i) => rule(`never-${i}`, `P${i}`));
    many.push(rule("target", "BEYOND CAP"));
    expect(resolveModelPrompt("target", { rules: many }).prompt).toBe("");
  });
});

describe("validateRules", () => {
  it("returns empty for a non-array", () => {
    expect(validateRules(null)).toEqual({ rules: [], errors: [] });
  });

  it("flags an empty pattern and drops the rule", () => {
    const { rules, errors } = validateRules([{ pattern: "", prompt: "x" }]);
    expect(rules).toHaveLength(0);
    expect(errors[0].message).toMatch(/Pattern is empty/);
  });

  it("flags an empty prompt and drops the rule", () => {
    const { rules, errors } = validateRules([{ pattern: "a", prompt: "   " }]);
    expect(rules).toHaveLength(0);
    expect(errors[0].message).toMatch(/Prompt is empty/);
  });

  it("keeps a valid rule", () => {
    const { rules, errors } = validateRules([{ pattern: "gpt", prompt: "hello" }]);
    expect(errors).toHaveLength(0);
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe("gpt");
  });

  it("reports truncation at the character cap", () => {
    const { errors } = validateRules([{ pattern: "a", prompt: "x".repeat(MAX_PROMPT_CHARS) }]);
    expect(errors.some((e) => /truncated/.test(e.message))).toBe(true);
  });

  it("warns when the list exceeds MAX_RULES", () => {
    const many = Array.from({ length: MAX_RULES + 3 }, (_, i) => ({ pattern: `p${i}`, prompt: `q${i}` }));
    const { rules, errors } = validateRules(many);
    expect(rules).toHaveLength(MAX_RULES);
    expect(errors.some((e) => /Only the first/.test(e.message))).toBe(true);
  });
});
