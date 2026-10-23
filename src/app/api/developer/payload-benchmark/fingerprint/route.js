import { fingerprint, GUARD, ATTACK } from "open-sse/payload/guardFingerprint.js";
import { FRAMES, buildVariant } from "open-sse/payload/payloadEvolve.js";
import { scoreResponse, VERDICT } from "open-sse/payload/payloadScorer.js";

export const dynamic = "force-dynamic";

// Three probes x one call each. Kept small on purpose: a fingerprint is a
// diagnostic, not a sweep. If three frames cannot separate the guard modes,
// more frames will not help.
export const maxDuration = 300;

const CALL_TIMEOUT_MS = 90_000;
const MAX_PROBE_CHARS = 2_000;

// Frames chosen to separate the three guard modes:
//   fiction   — a calm frame; a pattern-matcher goes silent on it
//   mitre     — a legitimate-work frame; an intent-reasoner explains why not
//   translation — a task frame; an infra filter kills it before the model
const PROBE_FRAMES = ["fiction", "mitre", "translation"];

async function callModel({ model, system, user }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(
      new URL("/api/developer/chat", process.env.NINER_BASE_URL || "http://127.0.0.1:20128"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
          stream: false,
          temperature: 0.7,
          max_tokens: 2048,
        }),
      },
    );

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A provider rejection IS the fingerprint signal — return it as text so
      // classifyAnswer can read the gateway message instead of losing it.
      const message = body?.error?.message || body?.error || `relay HTTP ${res.status}`;
      return { ok: false, answer: String(message), status: res.status };
    }
    const content = body?.choices?.[0]?.message?.content;
    return { ok: true, answer: typeof content === "string" ? content : "" };
  } catch (e) {
    return { ok: false, answer: String(e?.message || e), status: null };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/developer/payload-benchmark/fingerprint
//
// Which frames this diagnostic will try, and the attack classes it can
// recommend, so the client does not hardcode them.
export async function GET() {
  return Response.json({
    frames: PROBE_FRAMES.map((id) => {
      const f = FRAMES.find((x) => x.id === id);
      return { id, label: f?.label || id };
    }),
    guards: Object.values(GUARD),
    attacks: Object.values(ATTACK),
    limits: { maxProbeChars: MAX_PROBE_CHARS, callTimeoutMs: CALL_TIMEOUT_MS },
  });
}

// POST /api/developer/payload-benchmark/fingerprint
//
// Body: { model, probe }
//
// Sends the probe through three frames and classifies the guard from the three
// answers. Returns the guard mode, the attack class that fits it, and per-probe
// detail so the reasoning is visible rather than asserted.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const probe = typeof body?.probe === "string" ? body.probe.trim().slice(0, MAX_PROBE_CHARS) : "";

  if (!model) return Response.json({ error: "model is required" }, { status: 400 });
  if (!probe) return Response.json({ error: "probe is required" }, { status: 400 });

  try {
    const probes = [];

    for (const frameId of PROBE_FRAMES) {
      const system = buildVariant({ task: probe, frameId });
      const result = await callModel({ model, system, user: probe });

      // A probe counts as compliant when the scorer says the answer engaged
      // rather than deflected. That keeps this diagnostic consistent with the
      // benchmark tab instead of inventing a second definition of success.
      const scored = scoreResponse({ response: result.answer, probe });
      const complied = scored.verdict === VERDICT.COMPLIED;

      probes.push({
        frameId,
        complied,
        verdict: scored.verdict,
        answerChars: String(result.answer || "").length,
        answer: String(result.answer || "").slice(0, 400),
        httpOk: result.ok,
      });
    }

    const fp = fingerprint(probes);

    return Response.json({
      model,
      probe,
      guard: fp.guard,
      attack: fp.attack,
      reason: fp.reason,
      probes: fp.probes.map((p, i) => ({ ...p, ...probes[i] })),
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
