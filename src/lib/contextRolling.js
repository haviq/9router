// Context rolling for long conversations.
//
// A chat that runs thirty turns sends all thirty to the model every time. Most
// of them are context, not instruction: the operator asked the same follow-up
// four turns ago and the model already answered. Sending the whole history is
// how a five-turn conversation slowly turns into a 30K-token request that
// dominates the bill.
//
// This module trims the middle. The system message and the most recent turns
// survive untouched; older turns collapse into a short note that says how many
// were dropped. The model keeps the shape of the conversation without paying
// for its full text.
//
// Deliberately NOT an LLM summarizer. A summary pass costs a round trip and can
// hallucinate instruction, which is worse than a trimmed history. If the
// operator needs a semantic summary, that is a different feature with a
// different failure mode and belongs behind its own toggle.

export const DEFAULTS = {
  enabled: false,
  keepHeadMessages: 1,   // system + first user turn
  keepTailMessages: 6,   // the recent exchange the operator is still steering
  minMessages: 12,       // below this, trimming loses more than it saves
};

// A dropped-turns marker, so the model does not assume the conversation began
// at the surviving turns. Without it a follow-up like "and what about the
// second one?" has no referent the model can see.
function dropNote(count) {
  return {
    role: "user",
    content: `[${count} earlier message${count === 1 ? "" : "s"} in this conversation were omitted to keep the request within budget. Continue as if you had read them.]`,
  };
}

// True when the message list is long enough that trimming saves more tokens
// than the boundary marker costs. The marker itself is ~40 tokens; if fewer
// than a handful of messages would be dropped, trimming is a net loss.
function shouldTrim(messages, opts) {
  return Array.isArray(messages) && messages.length > opts.minMessages;
}

// Trim the middle of a conversation.
//
// Preserved: the head (system / first turn) and the tail (recent exchange).
// Everything between them becomes one short user note. Order is preserved — the
// note lands exactly where the dropped messages were, not at the end, so the
// model reads the conversation in its real sequence.
//
// Tool calls and results are NOT treated specially. A dropped tool result that
// the tail references is a real loss; the caller's keepTailMessages must be
// wide enough that in-flight tool turns stay. Six is the default because a
// single tool round trip is turn → call → result → follow-up.
export function rollContext(messages, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.enabled) return { messages, dropped: 0 };
  if (!shouldTrim(messages, opts)) return { messages, dropped: 0 };

  const head = Math.max(0, opts.keepHeadMessages);
  const tail = Math.max(1, opts.keepTailMessages);

  // If head + tail already covers the array, nothing to drop.
  if (head + tail >= messages.length) return { messages, dropped: 0 };

  const headSlice = messages.slice(0, head);
  const tailSlice = messages.slice(-tail);
  const dropped = messages.length - headSlice.length - tailSlice.length;

  // Never drop so much that the note becomes the conversation. If the surviving
  // ends are shorter than the dropped middle, the caller's keep counts are too
  // tight for this input and we preserve instead of mangling the shape.
  if (dropped < 2) return { messages, dropped: 0 };

  const out = [...headSlice, dropNote(dropped), ...tailSlice];
  return { messages: out, dropped };
}

export function resolveConfig(settings = {}) {
  return {
    enabled: settings.contextRollingEnabled === true,
    keepHeadMessages: Number.isInteger(settings.contextRollingKeepHead)
      ? settings.contextRollingKeepHead
      : DEFAULTS.keepHeadMessages,
    keepTailMessages: Number.isInteger(settings.contextRollingKeepTail)
      ? settings.contextRollingKeepTail
      : DEFAULTS.keepTailMessages,
    minMessages: Number.isInteger(settings.contextRollingMinMessages)
      ? settings.contextRollingMinMessages
      : DEFAULTS.minMessages,
  };
}
