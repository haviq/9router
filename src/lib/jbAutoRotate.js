// Auto-rotation: retry a refused answer against the next model in the chain.
//
// A combo already fails over on transport errors — 404, 429, 500. It does NOT
// fail over when the model answers with a complete, well-formed refusal, because
// a refusal is a 200. That is the gap this closes: when the assistant says
// "I can't help with that", the chain should advance to the next seat.
//
// Two things make this safe to run automatically:
//   1. Refusal detection is a separate, conservative scorer — it must not fire
//      on a model that is merely cautious inside useful output.
//   2. The retry is bounded, and the FIRST answer is kept if every seat refuses.
//      A worse answer is never substituted for a better one.

// Phrases that mark a refusal. Kept short and specific: a long list starts
// matching "I can't tell you how many bugs that caused" inside legitimate prose.
export const REFUSAL_MARKERS = [
  /i can'?t (?:help|assist|provide|do|comply|continue)/i,
  /i'?m (?:sorry|unable|not able)/i,
  /i (?:won'?t|will not) (?:help|assist|provide|do|comply|continue)/i,
  /as an ai(?: language model)?/i,
  /i (?:must|have to) (?:decline|refuse)/i,
  /i cannot (?:help|assist|provide|comply|fulfill|continue)/i,
  /(?:cannot|can'?t) (?:assist|help) with (?:that|this|your request)/i,
  /against my (?:guidelines|programming|principles)/i,
  /that(?:'s| is) not something i can/i,
];

// Short answers that are pure refusal are strong signal; the same words inside a
// 3KB technical answer are weak signal. Length gates the decision so a
// compliance answer that happens to open with "I can't believe..." is not
// mistaken for a refusal.
const PURE_REFUSAL_MAX_CHARS = 600;
const PURE_REFUSAL_MIN_MATCHES = 1;
const PROSE_REFUSAL_MIN_MATCHES = 3;

export function countRefusalMarkers(text) {
  if (typeof text !== "string" || !text) return 0;
  let count = 0;
  for (const re of REFUSAL_MARKERS) {
    if (re.test(text)) count += 1;
  }
  return count;
}

// True when a response should trigger a failover to the next seat.
//
// Deliberately asymmetric. Missing a refusal costs one extra manual retry;
// calling a good answer a refusal silently replaces it with a different model's
// answer, which is worse and invisible.
export function isRefusal(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return false;

  const matches = countRefusalMarkers(t);
  if (matches >= PURE_REFUSAL_MIN_MATCHES && t.length <= PURE_REFUSAL_MAX_CHARS) {
    return true;
  }
  return matches >= PROSE_REFUSAL_MIN_MATCHES;
}

// Should this particular seat be retried?
//
// `finishReason === "length"` with no content is budget exhaustion, not a
// refusal. Retrying the next seat does not fix a budget that was too small —
// it just spends another full request. That case is skipped and reported
// separately.
export function shouldRotate({ content = "", finishReason = "", choiceCount = 1 } = {}) {
  if (!choiceCount) return { rotate: false, reason: "no-choices" };

  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    if (finishReason === "length") return { rotate: false, reason: "budget-exhausted" };
    return { rotate: false, reason: "empty" };
  }

  if (isRefusal(text)) return { rotate: true, reason: "refusal" };
  return { rotate: false, reason: "ok" };
}

// Pick which seat to try next. Returns null when the chain is exhausted, so the
// caller keeps the answer it already has instead of returning nothing.
export function nextSeat(seats, triedIndex) {
  if (!Array.isArray(seats) || seats.length === 0) return null;
  const next = Number(triedIndex) + 1;
  if (next >= seats.length) return null;
  return { model: seats[next], index: next };
}
