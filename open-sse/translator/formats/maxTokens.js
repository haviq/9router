import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";
import { resolveBudget } from "../../../src/lib/tokenBudget.js";

/**
 * Adjust max_tokens based on request context
 * @param {object} body - Request body
 * @param {number} [ceiling=DEFAULT_MAX_TOKENS] - Upper bound for max_tokens.
 *   Callers with model context (e.g. openai-to-claude) pass the model's real
 *   maxOutput so high-output models (Opus 4.8 = 128000) aren't pre-clamped to
 *   the conservative 64000 default before the model-aware step sees them.
 * @param {string} [model] - Resolved upstream model name, when the caller has
 *   it. Used to pick a per-family default when the request did not send
 *   max_tokens — a reasoning model gets room for its chain-of-thought, a chat
 *   model stops reserving an output window it never fills.
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, ceiling = DEFAULT_MAX_TOKENS, model = "") {
  const resolvedModel = model || body.model || body.metadata?.model || "";

  // Fill in a family default only when the caller sent nothing. resolveBudget
  // never lowers an explicit value — an operator who asked for 32,000 keeps
  // 32,000 even if the family table says 8,000.
  let maxTokens;
  if (body.max_tokens) {
    maxTokens = body.max_tokens;
  } else if (resolvedModel) {
    maxTokens = resolveBudget({ model: resolvedModel }).maxTokens;
  } else {
    maxTokens = DEFAULT_MAX_TOKENS;
  }

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using the
  // ceiling which could equal budget_tokens when budget_tokens >= ceiling
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  // Never exceed the ceiling
  if (maxTokens > ceiling) maxTokens = ceiling;

  return maxTokens;
}

