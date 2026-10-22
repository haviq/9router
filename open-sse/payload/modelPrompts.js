// Per-model system prompts.
//
// The global injection slots (register, godmode, skill-router) are one shape for
// every request. That is wrong for operators who run several model families:
// a coding system prompt written for Claude reads as noise to Qwen, and the
// reverse is equally true. This module holds a small rule list — pattern plus
// prompt — and resolves exactly one prompt per request by the upstream model.
//
// Pure by design: no DB, no settings import, no clock. The caller passes the
// rules it read from settings; the resolution is a pure function so the
// matching rules (order, case, wildcards, invalid regex) are testable.
//
// Why first-match-wins rather than merge: two prompts that both claim a model
// contradict each other, and a silent merge produces a system message neither
// author wrote. First match is predictable and the operator controls order.

export const MAX_RULES = 24;
export const MAX_PROMPT_CHARS = 16_000;
export const MAX_PATTERN_CHARS = 200;

// A rule is { id, pattern, prompt, enabled }. `pattern` is matched as a
// case-insensitive substring OR a /regex/ literal. Substring is the default
// because most operators write "gpt-5" or "claude", not a regex.
export function normalizeRule(raw, index = 0) {
  const rule = raw && typeof raw === "object" ? raw : {};
  const pattern = String(rule.pattern || "").trim().slice(0, MAX_PATTERN_CHARS);
  const prompt = String(rule.prompt || "").slice(0, MAX_PROMPT_CHARS);
  return {
    id: typeof rule.id === "string" && rule.id.trim() ? rule.id.trim() : `rule-${index}`,
    pattern,
    prompt,
    enabled: rule.enabled !== false,
  };
}

// Compile a pattern into a matcher. Returns null for a pattern that can never
// match, so a typo in one rule cannot throw and take the whole request down.
export function compilePattern(pattern) {
  const raw = String(pattern || "").trim();
  if (!raw) return null;

  // /regex/flags form. Only "i" is honoured; other flags are stripped because
  // a stateful "g" would make .test() alternate between calls.
  if (raw.length > 2 && raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const end = raw.lastIndexOf("/");
    const body = raw.slice(1, end);
    const flags = raw.slice(end + 1).replace(/[^i]/g, "");
    if (!body) return null;
    try {
      const re = new RegExp(body, flags);
      return (model) => re.test(model);
    } catch {
      // Invalid regex: fall through to substring so the operator still gets a
      // match on the literal text instead of a silently dead rule.
    }
  }

  const needle = raw.toLowerCase();
  return (model) => model.toLowerCase().includes(needle);
}

/**
 * Resolve the system prompt for a model.
 *
 * @param {string} model   Upstream model id (e.g. "claude-sonnet-4.6").
 * @param {object} opts
 * @param {boolean} [opts.enabled=true]  Master switch.
 * @param {Array} [opts.rules=[]]        Raw rule list from settings.
 * @returns {{ prompt: string, ruleId: string|null, pattern: string|null }}
 */
export function resolveModelPrompt(model, { enabled = true, rules = [] } = {}) {
  const none = { prompt: "", ruleId: null, pattern: null };
  if (!enabled) return none;

  const id = typeof model === "string" ? model.trim() : "";
  if (!id) return none;
  if (!Array.isArray(rules) || !rules.length) return none;

  // Cap the scan so a malformed settings blob cannot make every request walk
  // an unbounded list on the hot path.
  const list = rules.slice(0, MAX_RULES);

  for (let i = 0; i < list.length; i++) {
    const rule = normalizeRule(list[i], i);
    if (!rule.enabled || !rule.pattern || !rule.prompt.trim()) continue;

    const match = compilePattern(rule.pattern);
    if (!match) continue;

    try {
      if (match(id)) {
        return { prompt: rule.prompt, ruleId: rule.id, pattern: rule.pattern };
      }
    } catch {
      // A matcher must never break the request; skip this rule.
    }
  }

  return none;
}

// Validate a rule list before it is persisted. Returns the cleaned list plus
// per-rule problems so the UI can point at the offending row instead of
// rejecting the whole save.
export function validateRules(rules) {
  if (!Array.isArray(rules)) return { rules: [], errors: [] };

  const errors = [];
  const out = [];

  if (rules.length > MAX_RULES) {
    errors.push({ index: -1, message: `Only the first ${MAX_RULES} rules are kept` });
  }

  rules.slice(0, MAX_RULES).forEach((raw, index) => {
    const rule = normalizeRule(raw, index);
    if (!rule.pattern) {
      errors.push({ index, message: "Pattern is empty — this rule can never match" });
      return;
    }
    if (!rule.prompt.trim()) {
      errors.push({ index, message: "Prompt is empty — this rule would inject nothing" });
      return;
    }
    if (rule.prompt.length >= MAX_PROMPT_CHARS) {
      errors.push({ index, message: `Prompt truncated at ${MAX_PROMPT_CHARS} characters` });
    }
    out.push(rule);
  });

  return { rules: out, errors };
}
