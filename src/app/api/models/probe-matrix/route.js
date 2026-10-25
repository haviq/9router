import { NextResponse } from "next/server";
import { pingModelByKind } from "../test/ping";
import { getAdapter } from "@/lib/db/driver.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;

// Cache in memory for instant display
let liveCache = new Map();
let lastBatchRun = null;

// Run bounded-parallel ping across candidate models
async function runBatchProbe(models, concurrency = DEFAULT_CONCURRENCY) {
  const cap = Math.max(1, Math.min(MAX_CONCURRENCY, Number(concurrency) || DEFAULT_CONCURRENCY));
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < models.length) {
      const idx = cursor++;
      const item = models[idx];
      const modelId = typeof item === "string" ? item : item.id || item.model;
      const kind = (typeof item === "object" ? item.kind : null) || "llm";
      
      try {
        const res = await pingModelByKind(modelId, kind);
        const record = {
          id: modelId,
          kind,
          ok: Boolean(res.ok),
          status: res.status || (res.ok ? 200 : 500),
          latencyMs: res.latencyMs || 0,
          error: res.error || null,
          note: res.note || null,
          testedAt: new Date().toISOString(),
        };
        liveCache.set(modelId, record);
        results.push(record);
      } catch (err) {
        const record = {
          id: modelId,
          kind,
          ok: false,
          status: 500,
          latencyMs: 0,
          error: err.message || "Probe exception",
          note: null,
          testedAt: new Date().toISOString(),
        };
        liveCache.set(modelId, record);
        results.push(record);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, models.length) }, worker));
  lastBatchRun = new Date().toISOString();
  return results;
}

// GET /api/models/probe-matrix
//
// Returns cached probe results plus a live model list. The model list is
// fetched internally because the dashboard caller has no API key; that fetch
// used to abort at 5s, and under load (a busy sweep, a burst of chat traffic)
// it timed out and the page rendered with zero models — reading as "9router is
// down" when the router was healthy. Two changes: a wider window, and a
// non-fatal fallback so a slow internal fetch degrades the list, not the page.
export async function GET() {
  let activeModels = [];
  let modelsError = null;
  try {
    // Fetch active routable models internally via direct database API key
    try {
      const { getApiKeys } = await import("@/lib/db/repos/apiKeysRepo.js");
      const keys = await getApiKeys().catch(() => []);
      const activeKey = keys.find((k) => k.isActive)?.key || keys[0]?.key || "";

      const port = process.env.PORT || 20128;
      const headers = { "Content-Type": "application/json" };
      if (activeKey) headers["Authorization"] = `Bearer ${activeKey}`;

      const v1Res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers,
        cache: "no-store",
        // 20s. The route lives in the same process as the request itself, so a
        // loop-back fetch competes with whatever else the event loop is doing.
        // 5s was enough on an idle box and not enough on a busy one.
        signal: AbortSignal.timeout(20000),
      });

      if (v1Res.ok) {
        const data = await v1Res.json();
        if (Array.isArray(data?.data)) {
          activeModels = data.data.map((m) => ({
            id: m.id,
            model: m.id,
            kind: m.kind || "llm",
          }));
        }
      } else {
        modelsError = `internal /v1/models returned HTTP ${v1Res.status}`;
      }
    } catch (e) {
      modelsError = e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message || "")
        ? "internal model fetch timed out"
        : (e?.message || "internal model fetch failed");
      console.error("[probe-matrix] Failed to fetch active models:", modelsError);
    }

    const cacheArray = Array.from(liveCache.values());
    const total = cacheArray.length;
    const healthy = cacheArray.filter((m) => m.ok).length;
    const errors = total - healthy;

    return NextResponse.json({
      lastRun: lastBatchRun,
      activeModels,
      stats: {
        total,
        healthy,
        errors,
        healthyPercent: total > 0 ? Math.round((healthy / total) * 100) : 0,
      },
      results: cacheArray,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/models/probe-matrix
// Body: { models: string[] | { id, kind }[], concurrency?: number, single?: boolean }
export async function POST(request) {
  try {
    const body = await request.json();
    const { models, model, kind, concurrency } = body;

    if (model) {
      // Single model probe
      const res = await pingModelByKind(model, kind || "llm");
      const record = {
        id: model,
        kind: kind || "llm",
        ok: Boolean(res.ok),
        status: res.status || (res.ok ? 200 : 500),
        latencyMs: res.latencyMs || 0,
        error: res.error || null,
        note: res.note || null,
        testedAt: new Date().toISOString(),
      };
      liveCache.set(model, record);
      return NextResponse.json(record);
    }

    if (!Array.isArray(models) || models.length === 0) {
      return NextResponse.json({ error: "No models provided for probe" }, { status: 400 });
    }

    const results = await runBatchProbe(models, concurrency);
    return NextResponse.json({
      tested: results.length,
      lastRun: lastBatchRun,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
