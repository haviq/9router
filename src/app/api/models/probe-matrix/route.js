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
export async function GET() {
  try {
    // Fetch active routable models internally via internal headers
    let activeModels = [];
    try {
      const baseUrl = `http://127.0.0.1:${process.env.PORT || 20128}`;
      const { getInternalHeaders } = await import("../test/ping");
      const headers = await getInternalHeaders();
      const v1Res = await fetch(`${baseUrl}/v1/models`, { headers, cache: "no-store" });
      if (v1Res.ok) {
        const data = await v1Res.json();
        if (Array.isArray(data?.data)) {
          activeModels = data.data.map((m) => ({
            id: m.id,
            model: m.id,
            kind: m.kind || "llm",
          }));
        }
      }
    } catch {}

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
