// Output-budget negotiation for reasoning models.
//
// The bug this exists to kill, in one sentence: kl/deepseek-v4.1-flash spends
// ~3500 tokens thinking before it writes a single character, so with
// max_tokens 2000 the request returns finish_reason:"length" and content:"" —
// and every sweep in this repo scored that as EMPTY, i.e. read a breach as a
// refusal.
//
// It cost hours. The model was never refusing; it ran out of room mid-thought.
//
// So: when a call comes back with no content AND a length finish, the budget
// was the problem, not the model. Retry with double. Stop at a ceiling so a
// genuinely silent model does not burn tokens forever.
//
// Pure by design — the caller supplies `call(budget)` and gets back whatever it
// returns, so the escalation policy is testable without a network.

export const START_BUDGET = 4000;
export const MAX_BUDGET = 32000;
export const MAX_ATTEMPTS = 4;

// Normalise whatever the transport returned into the two fields that matter.
//
// A transport may return a bare string (content only) or a structured result.
// Both are accepted: a bare string simply has no finish reason to inspect, and
// is treated as final — there is nothing to negotiate without that signal.
function readResult(result) {
  if (typeof result === "string") {
    return { content: result, finishReason: null, raw: result };
  }
  if (result && typeof result === "object") {
    const content = typeof result.content === "string" ? result.content : "";
    const finishReason = result.finishReason ?? result.finish_reason ?? null;
    return { content, finishReason, raw: result };
  }
  return { content: "", finishReason: null, raw: result };
}

// Should this result be retried with a bigger budget?
//
// Only one shape qualifies: no content AND finish_reason "length". An empty
// answer with finish_reason "stop" is a real empty answer — the model had
// nothing to say, and doubling the budget just buys a bigger silence.
export function shouldEscalate({ content, finishReason } = {}) {
  const text = String(content || "").trim();
  if (text) return false;
  return finishReason === "length" || finishReason === "max_tokens";
}

// Next budget to try. Doubles, clamped to the ceiling.
export function nextBudget(current) {
  const n = Number(current) || START_BUDGET;
  return Math.min(MAX_BUDGET, n * 2);
}

// Call with an escalating budget until something comes back.
//
// `call(budget)` must return either a content string or {content, finishReason}.
// Returns the final result plus a trail of every attempt, so a caller can see
// whether it needed one try or four — and so a dashboard can report "this model
// needs 16k before it answers" instead of "this model is empty".
export async function callWithBudget({
  call,
  startBudget = START_BUDGET,
  maxBudget = MAX_BUDGET,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  if (typeof call !== "function") throw new Error("call callback is required");

  const ceiling = Math.max(startBudget, Math.min(MAX_BUDGET, Number(maxBudget) || MAX_BUDGET));
  const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, Number(maxAttempts) || MAX_ATTEMPTS));

  let budget = Math.max(1, Math.min(ceiling, Number(startBudget) || START_BUDGET));
  const trail = [];

  for (let i = 0; i < attempts; i++) {
    const result = await call(budget);
    const read = readResult(result);

    trail.push({
      attempt: i + 1,
      budget,
      contentChars: read.content.trim().length,
      finishReason: read.finishReason,
      escalated: false,
    });

    if (!shouldEscalate(read)) {
      return { ...read, budget, attempts: i + 1, trail, escalated: i > 0 };
    }

    trail[trail.length - 1].escalated = true;

    const bigger = nextBudget(budget);
    if (bigger <= budget || budget >= ceiling) {
      // Ceiling reached and still nothing. Report it honestly as inconclusive
      // rather than pretending the model refused.
      return {
        ...read,
        budget,
        attempts: i + 1,
        trail,
        escalated: i > 0,
        inconclusive: true,
      };
    }
    budget = bigger;
  }

  const last = trail[trail.length - 1];
  return {
    content: "",
    finishReason: last?.finishReason ?? null,
    budget,
    attempts: trail.length,
    trail,
    escalated: trail.length > 1,
    inconclusive: true,
  };
}
