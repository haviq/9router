import { runAdaptiveLadder, LADDER, ANGLES, MAX_TURNS } from "open-sse/payload/adaptiveTurn.js";
import { summarizeTurns } from "open-sse/payload/turnScore.js";
import { saveBenchmarkRun, pruneBenchmarkRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

// A ladder run is up to 8 turns, each a full round-trip. On a reasoning model
// that is minutes, so the cap is deliberately low and the timeout is generous.
export const maxDuration = 300;

const CALL_TIMEOUT_MS = 90_000;
const MAX_PROBE_CHARS = 2_000;
const MAX_TURNS_PER_REQUEST = 6;

async function callModel({ model, messages }) {
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
          messages,
          stream: false,
          temperature: 0.7,
          max_tokens: 4096,
        }),
      },
    );

    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || `relay HTTP ${res.status}`);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("relay returned no message content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/developer/payload-benchmark/adaptive
//
// The ladder and the angles, so the client can show what will be attempted
// instead of hardcoding a copy that drifts.
export async function GET() {
  return Response.json({
    ladder: LADDER.map((r, i) => ({ step: i + 1, id: r.id, text: r.text })),
    angles: ANGLES.map((a) => ({ id: a.id, text: a.text })),
    limits: { maxTurns: MAX_TURNS_PER_REQUEST, hardCap: MAX_TURNS, callTimeoutMs: CALL_TIMEOUT_MS },
  });
}

// POST /api/developer/payload-benchmark/adaptive
//
// Body: { model, probe, maxTurns? }
//
// Runs the adaptive ladder and returns every turn with its verdict, so the
// point where the model started hedging is visible rather than inferred from
// a final "it failed".
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const probe = typeof body?.probe === "string" ? body.probe.trim().slice(0, MAX_PROBE_CHARS) : "";
  const maxTurns = Math.max(1, Math.min(MAX_TURNS_PER_REQUEST, Number(body?.maxTurns) || 4));

  if (!model) return Response.json({ error: "model is required" }, { status: 400 });
  if (!probe) return Response.json({ error: "probe is required" }, { status: 400 });

  try {
    const result = await runAdaptiveLadder({
      probe,
      maxTurns,
      send: (messages) => callModel({ model, messages }),
    });

    // Persist the best turn so a later "what has worked here" query can see it.
    // Only when something was actually measured — a ladder that died on a
    // transport error measured the provider, not the payload.
    let savedRunId = null;
    try {
      const measured = result.turns.filter((t) => !t.error).length;
      if (measured > 0 && result.best) {
        const ref = await saveBenchmarkRun({
          payloadId: `adaptive:${result.best.rungId}${result.best.angleId ? ">" + result.best.angleId : ""}`,
          model,
          runs: measured,
          results: [],
          aggregate: {
            complianceRate: result.best.verdict === "complied" ? 1 : result.best.verdict === "partial" ? 0.5 : 0,
            meanScore: result.best.score || 0,
            measuredRuns: measured,
            transportErrors: result.turns.filter((t) => t.error).length,
          },
        });
        savedRunId = ref?.id || null;
        if (savedRunId) pruneBenchmarkRuns().catch(() => {});
      }
    } catch {
      // Storage trouble must not lose a measurement the caller already paid for.
    }

    // The per-turn curve is the reason this endpoint exists. A final verdict of
    // "refused" hides the four turns of engagement that came before it, and the
    // drop point is where the strategy should have changed — so it is computed
    // here rather than left for the client to re-derive.
    const summary = summarizeTurns(result.turns);

    return Response.json({
      model,
      probe,
      maxTurns,
      turnsUsed: result.turnsUsed,
      stopped: result.stopped,
      best: result.best,
      turns: result.turns,
      summary,
      savedRunId,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
