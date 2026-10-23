import { runPayload, runPayloadMatrix, resolvePayloadText, DEFAULT_RUNS, MAX_RUNS } from "open-sse/payload/payloadRunner.js";
import { buildPayloadCatalog } from "open-sse/payload/payloadCatalog.js";
import { runPayloadSweep, clampConcurrency } from "open-sse/payload/payloadSweep.js";
import { saveBenchmarkRun, pruneBenchmarkRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

export const maxDuration = 300;

// Benchmarks are slow by construction: N runs x M payloads, each a full model
// round-trip. The transport timeout is per-call, not for the whole sweep.
const CALL_TIMEOUT_MS = 90_000;
const MAX_PAYLOADS_PER_REQUEST = 8;
const MAX_PROBE_CHARS = 4_000;

// Reach a model through the dashboard relay. That route injects a valid router
// key server-side and supports stream:false, so this never needs to know about
// provider credentials.
async function callModel({ model, system, user }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/api/developer/chat", process.env.NINER_BASE_URL || "http://127.0.0.1:20128"), {
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
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error?.message || `relay HTTP ${res.status}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("relay returned no message content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function clampProbe(probe) {
  const text = typeof probe === "string" ? probe.trim() : "";
  if (!text) return "";
  return text.length > MAX_PROBE_CHARS ? text.slice(0, MAX_PROBE_CHARS) : text;
}

function clampPayloadIds(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_PAYLOADS_PER_REQUEST) break;
  }
  return out;
}

// GET /api/developer/payload-benchmark
//
// Catalog of benchmarkable payload ids plus the limits this route enforces, so
// the client can build a valid request without guessing.
export async function GET() {
  try {
    const catalog = buildPayloadCatalog();
    const benchmarkable = [];
    const unresolved = [];

    for (const row of catalog) {
      if (resolvePayloadText(row.id)) {
        benchmarkable.push({ id: row.id, cat: row.cat, source: row.source, estTokens: row.estTokens });
      } else {
        // A catalog row whose text will not resolve is dead weight — surface it
        // rather than letting a benchmark request fail with "unknown id".
        unresolved.push(row.id);
      }
    }

    return Response.json({
      total: catalog.length,
      benchmarkable: benchmarkable.length,
      payloads: benchmarkable,
      unresolved,
      limits: {
        maxPayloads: MAX_PAYLOADS_PER_REQUEST,
        maxRuns: MAX_RUNS,
        defaultRuns: DEFAULT_RUNS,
        maxProbeChars: MAX_PROBE_CHARS,
        callTimeoutMs: CALL_TIMEOUT_MS,
      },
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

// POST /api/developer/payload-benchmark
//
// Body: { model, probe, payloadIds: string[], runs?: number, mode?: "single" | "matrix" }
//
// Runs the payloads sequentially and returns scored results, best first. A
// provider failure is recorded per run, never promoted to a 500: the whole
// point is to learn which payload survives real conditions.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body?.model === "string" ? body.model.trim() : "";
  const probe = clampProbe(body?.probe);
  const payloadIds = clampPayloadIds(body?.payloadIds);
  const runs = body?.runs;
  const mode = body?.mode === "single" ? "single" : "matrix";

  // Parallelism is opt-in. The sequential default exists because provider rate
  // limits are per-key: a wide sweep that fires everything at once measures the
  // limiter, not the payload. A caller that knows its provider can take the
  // concurrency opts in explicitly and gets a bounded sweep instead.
  const concurrency = clampConcurrency(body?.concurrency, 1);
  // Resume support: ids the caller already measured are skipped, so a sweep
  // that lost its connection does not pay for those model calls twice.
  const skip = Array.isArray(body?.skip)
    ? body.skip.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
    : [];

  if (!model) return Response.json({ error: "model is required" }, { status: 400 });
  if (!probe) return Response.json({ error: "probe is required" }, { status: 400 });
  if (!payloadIds.length) {
    return Response.json({ error: "payloadIds must contain at least one id" }, { status: 400 });
  }

  const unknown = payloadIds.filter((id) => resolvePayloadText(id) === null);
  if (unknown.length) {
    return Response.json(
      { error: `Unknown payload id(s): ${unknown.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    let rows;
    let skipped = [];

    if (mode === "single") {
      rows = [await runPayload({ payloadId: payloadIds[0], model, probe, runs, transport: callModel })];
    } else if (concurrency <= 1) {
      // Sequential path unchanged. A caller that did not ask for parallelism
      // must not silently get it — the rate-limit reasoning still applies.
      rows = await runPayloadMatrix({ payloadIds, model, probe, runs, transport: callModel });
    } else {
      const sweep = await runPayloadSweep({
        payloadIds,
        model,
        probe,
        runs,
        transport: callModel,
        concurrency,
        skip,
      });
      rows = sweep.rows;
      skipped = sweep.skipped;
    }

    // Persist before responding. The result used to live only in the tab that
    // started it — close the tab and the measurement was gone, which is why
    // MODEL_VARIANT_MAP stayed hand-curated. saveBenchmarkRun drops rows with
    // no measured runs on its own: a transport error measures the provider,
    // not the payload, and recording it as "refused" is how a working payload
    // gets thrown away.
    const saved = [];
    const saveErrors = [];
    for (const row of rows) {
      try {
        const ref = await saveBenchmarkRun(row);
        if (ref) saved.push(ref.id);
      } catch (e) {
        // Storage trouble must not lose the measurement the caller just paid
        // for in model calls. Report it alongside the results instead.
        saveErrors.push(String(e?.message || e));
      }
    }

    if (saved.length) {
      pruneBenchmarkRuns().catch(() => {});
    }

    return Response.json({
      mode,
      model,
      probe,
      results: rows,
      savedRunIds: saved,
      ...(saveErrors.length ? { saveErrors } : {}),
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
