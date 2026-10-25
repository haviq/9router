// Per-model token budget guard.
//
// Every model used to get the caller's max_tokens verbatim. That is one budget
// for two very different workloads: a reasoning model spends its first ~3,500
// tokens on chain-of-thought before writing a single visible character, so a
// 2,000 budget returns finish_reason:"length" with empty content and reads as a
// refusal. A fast chat model never needs 8,000 and pays for the reservation on
// every request.
//
// This module picks a default per family and, when a request came back
// length-limited, raises the budget for one retry. It never lowers a budget the
// caller set explicitly — an operator who asked for 32,000 gets 32,000.

// Family budgets. Chosen from observed behaviour, not from model docs:
//   - reasoning: 8,000 (3,500 thinking + room to answer)
//   - vision:    4,096 (image tokens eat into the output window)
//   - standard:  2,048 (chat and small code snippets finish well inside this)
const BUDGET = {
  reasoning: 8000,
  vision: 4096,
  standard: 2048,
};

// Model-name patterns per family. Kept as regexes because the catalog is full of
// vendor prefixes (rv/deepseek-ai/, mg/zai-org/, openrouter/google/) and matching
// on a fixed list would go stale the moment a new provider is added.
const REASONING_PATTERNS = [
  /deepseek/i,
  /(?:^|[-/])r1(?:[-/]|$)/i,
  /qwq/i,
  /thinking/i,
  /reason/i,
  /o[1-9](?:[-/]|$)/i,
  /sonnet|opus/i,
  /glm-?[45]/i,
  /kimi/i,
  /minimax/i,
];

const VISION_PATTERNS = [
  /vision|vl(?:[-/]|$)|-vl-|multimodal/i,
  /gemini|gpt-4o|claude-3|claude-4/i,
];

function matches(model, patterns) {
  if (typeof model !== "string" || !model) return false;
  return patterns.some((re) => re.test(model));
}

// Classify a model name into one of the three families.
//
// Vision wins over reasoning when a model matches both: a VL model on a 4,096
// budget returns more useful answers than the same model stretched to 8,000 and
// spending the surplus on an unseen image.
export function classifyModel(model) {
  if (matches(model, VISION_PATTERNS)) return "vision";
  if (matches(model, REASONING_PATTERNS)) return "reasoning";
  return "standard";
}

// Default budget for a model.
export function defaultBudgetFor(model) {
  return BUDGET[classifyModel(model)] || BUDGET.standard;
}

// Resolve the effective budget for one request.
//
// Caller intent wins. Only fill in a budget when none was sent, or when the
// sent value was 0/negative (the API treats those as "model default", which is
// what we are replacing).
export function resolveBudget({ model, requestedMaxTokens } = {}) {
  const requested = Number(requestedMaxTokens);
  const hasExplicit = Number.isFinite(requested) && requested > 0;

  if (hasExplicit) {
    return { maxTokens: requested, family: classifyModel(model), source: "explicit" };
  }

  const family = classifyModel(model);
  return { maxTokens: BUDGET[family], family, source: "default" };
}

// Decide whether a failed attempt deserves exactly one budget-elevated retry.
//
// Only length exhaustion qualifies. A refusal, an empty completion, or a
// transport error is not fixed by spending more tokens, and retrying those
// burns a second full request against a wall that is not moving.
const RETRY_MULTIPLIER = 2;
const RETRY_CEILING = 32000;

export function nextBudget({ finishReason, content = "", currentBudget } = {}) {
  if (finishReason !== "length") return null;

  const trimmed = typeof content === "string" ? content.trim() : "";
  const current = Number(currentBudget) || 0;

  // Content present means the model answered and got cut mid-sentence. Raising
  // the budget lets that same answer finish, which is the useful case.
  // Content absent means the whole budget went to thinking — raising it is
  // still worth one shot, because reasoning is where the tokens are being
  // spent and the answer never had room to appear.
  const raised = Math.min(RETRY_CEILING, Math.max(current * RETRY_MULTIPLIER, current + 2048));

  if (raised <= current) return null;
  return raised;
}

export const BUDGET_TABLE = { ...BUDGET };
export const RETRY_LIMITS = { RETRY_MULTIPLIER, RETRY_CEILING };
