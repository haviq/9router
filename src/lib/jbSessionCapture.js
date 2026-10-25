// Server-side auto-capture of landed exchanges into jbSessions.
//
// The earlier Playground-only capture meant only chats started from the
// browser tab were recorded — a request from an API client, Hermes, or a
// script bypassed the UI and left no trace even when the answer was useful.
// This module lives on the server so every path that returns a usable answer
// gets recorded the same way.
//
// Deliberately silent on error. Capture is observation, not a feature the
// request depends on; a failure here must never surface to the caller.

import { saveJbSession } from "./db/repos/jbSessionsRepo.js";
import { isRefusal } from "./jbAutoRotate.js";

// Minimum length to be worth keeping. A one-word answer has no replay value
// and turns the corpus into noise — the point of the table is conversation
// shape, not an exhaustive request log.
const MIN_CONTENT_CHARS = 80;

// Cap the stored text. A 100KB answer is not more useful than a 4KB one, and
// keeping the whole thing bloats the table without adding replay value.
const MAX_CONTENT_CHARS = 8000;

function extractText(body) {
  if (!body || typeof body !== "object") return "";

  const choice = body.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) return msg.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
    if (typeof choice.text === "string") return choice.text;
  }

  if (typeof body.content === "string") return body.content;
  if (Array.isArray(body.content)) return body.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");

  const parts = body.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || "").join("");

  return "";
}

function extractModel(body, fallback = "") {
  return (typeof body?.model === "string" && body.model) || fallback;
}

// Capture one response.
//
// Returns { captured, reason } so a caller that wants telemetry has it, but the
// caller is not required to look — every failure path returns quietly.
export async function captureLandedSession({
  responseBody,
  model = "",
  messages = [],
  reasoning = "",
  temperature = null,
  maxTokens = null,
  payloadId = null,
  identity = "",
  notes = "",
} = {}) {
  try {
    const text = extractText(responseBody);
    const trimmed = text.trim();

    if (!trimmed) return { captured: false, reason: "empty" };
    if (trimmed.length < MIN_CONTENT_CHARS) return { captured: false, reason: "too-short" };

    // A refusal is a measurement, not a template. benchmarkRuns records it if
    // anyone wants that signal; the session corpus should only hold shapes the
    // operator could actually replay.
    if (isRefusal(trimmed)) return { captured: false, reason: "refusal" };

    const stored = trimmed.slice(0, MAX_CONTENT_CHARS);
    const resolvedModel = extractModel(responseBody, model);
    if (!resolvedModel) return { captured: false, reason: "no-model" };

    // Reconstruct the full exchange as it went over the wire: the caller's
    // messages plus what the model answered. That is the shape worth replaying.
    const safeMessages = Array.isArray(messages) ? messages : [];
    const fullExchange = [...safeMessages, { role: "assistant", content: stored }];

    // Score proxies expected usefulness from length alone. Kept honest: a
    // 2,000-char answer scores 100, a 200-char answer scores 10. Not a quality
    // metric — a filter so the leaderboard does not rank a lucky one-liner
    // above a full implementation.
    const score = Math.max(1, Math.min(100, Math.round((stored.length / 2000) * 100)));

    const saved = await saveJbSession({
      model: resolvedModel,
      messages: fullExchange,
      verdict: "complied",
      score,
      payloadId,
      identity,
      response: stored,
      reasoning: typeof reasoning === "string" ? reasoning.slice(0, MAX_CONTENT_CHARS) : "",
      temperature,
      maxTokens,
      notes: notes || "auto-captured (server)",
    });

    if (!saved) return { captured: false, reason: "save-rejected" };
    return { captured: true, id: saved.id, model: resolvedModel, chars: stored.length };
  } catch {
    return { captured: false, reason: "exception" };
  }
}

// Read a response body once and hand back both the text and the stream flag.
// Streaming responses carry the text in SSE frames; the caller decides whether
// it accumulated them already. This helper only handles the non-stream case and
// returns null for anything it cannot parse, so the caller falls through.
export async function peekJson(response) {
  try {
    const ct = response?.headers?.get?.("content-type") || "";
    if (!ct.includes("application/json")) return null;
    const cloned = response.clone ? response.clone() : response;
    return await cloned.json();
  } catch {
    return null;
  }
}

export const CAPTURE_LIMITS = { MIN_CONTENT_CHARS, MAX_CONTENT_CHARS };
