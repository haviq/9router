import { evolve, FRAMES, MAX_GENERATIONS } from "open-sse/payload/payloadEvolve.js";
import { runPayload } from "open-sse/payload/payloadRunner.js";
import { saveBenchmarkRun, pruneBenchmarkRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

// An evolutionary run costs real model calls: generations x population, each a
// full round-trip. The cap is deliberately low — a 12-generation sweep at
// 150s/call is an hour, which no HTTP request survives.
export const maxDuration = 300;

const CALL_TIMEOUT_MS = 90_000;
const MAX_PROBE_CHARS = 4_000;
const MAX_GENERATIONS_PER_REQUEST = 4;
const DEFAULT_RUNS = 2;

// Reach a model through the dashboard relay. That route injects a valid router
// key server-side and supports stream:false, so this never needs provider creds.
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

// GET /api/developer/payload-benchmark/evolve
//
// The frames this loop can try, so the client does not have to hardcode them.
export async function GET() {
  return Response.json({
    frames: FRAMES.map((f) => ({ id: f.id, label: f.label })),
    limits: {
      maxGenerations: MAX_GENERATIONS_PER_REQUEST,
      hardCap: MAX_GENERATIONS,
      defaultRuns: DEFAULT_RUNS,
      maxProbeChars: MAX_PROBE_CHARS,
      callTimeoutMs: CALL_TIMEOUT_MS,
    },
  });
}

// POST /api/developer/payload-benchmark/evolve
//
// Body: { model, probe, generations?, runs?, seedFrameId? }
//
// Runs the evolutionary loop against one model and returns every variant it
// measured, best first, plus which frame won. Each variant is scored through
// the same runner+scorer the benchmark tab uses, so the numbers are comparable.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const probe = typeof body?.probe === "string" ? body.probe.trim().slice(0, MAX_PROBE_CHARS) : "";
  const seedFrameId = typeof body?.seedFrameId === "string" ? body.seedFrameId : "fiction";
  const runs = Math.max(1, Math.min(5, Number(body?.runs) || DEFAULT_RUNS));
  const generations = Math.max(
    1,
    Math.min(MAX_GENERATIONS_PER_REQUEST, Number(body?.generations) || 2),
  );

  if (!model) return Response.json({ error: "model is required" }, { status: 400 });
  if (!probe) return Response.json({ error: "probe is required" }, { status: 400 });

  const known = FRAMES.map((f) => f.id);
  if (!known.includes(seedFrameId)) {
    return Response.json({ error: `Unknown seedFrameId: ${seedFrameId}` }, { status: 400 });
  }

  try {
    // measure() runs one variant N times through the same payload runner the
    // benchmark tab uses, so the aggregate shape (and therefore the score) is
    // directly comparable with a stored benchmark row.
    const measure = async ({ text }) => {
      const row = await runPayload({
        payloadId: "__evolve__",
        model,
        probe,
        runs,
        transport: async ({ system, user }) => callModel({ model, system: text, user }),
        // The runner resolves a payload id to text; here the text IS the variant,
        // so bypass resolution by supplying it directly.
        payloadText: text,
      });
      return row.aggregate;
    };

    const result = await evolve({ task: probe, seedFrameId, measure, generations });

    // Persist the winner so a later "what has worked on this model" query can
    // see it. The variant text is not a registered payload id, so it is stored
    // under a synthetic id that names the frame that won.
    let savedRunId = null;
    try {
      const ref = await saveBenchmarkRun({
        payloadId: `evolve:${result.best.outerFrameId ? result.best.outerFrameId + ">" : ""}${result.best.frameId}`,
        model,
        runs,
        results: [],
        aggregate: result.best.aggregate,
      });
      savedRunId = ref?.id || null;
      if (savedRunId) pruneBenchmarkRuns().catch(() => {});
    } catch {
      // Storage trouble must not lose a measurement the caller already paid for.
    }

    return Response.json({
      model,
      probe,
      seedFrameId,
      generationsRun: result.generationsRun,
      best: result.best,
      history: result.history,
      savedRunId,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
