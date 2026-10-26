import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { parseJson } from "@/lib/db/helpers/jsonCol";
import { summarizeQuota, classifyProviderResponse, QUOTA_STATE } from "open-sse/utils/quotaWatch.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS = [1, 6, 24, 72, 168];
const DEFAULT_WINDOW_HOURS = 24;
const MAX_ROWS = 5000;

function parseWindow(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;
  return ALLOWED_WINDOWS.reduce(
    (best, w) => (Math.abs(w - n) < Math.abs(best - n) ? w : best),
    DEFAULT_WINDOW_HOURS
  );
}

function pickBody(detail) {
  const candidates = [detail?.providerResponse, detail?.response];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === "string") {
      if (candidate.trim()) return candidate;
      continue;
    }
    if (typeof candidate === "object" && Object.keys(candidate).length > 0) return candidate;
  }
  return null;
}

function isSuccessStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "success" || s === "completed" || s === "200 ok" || s === "200";
}

// Map an internal node id (openai-compatible-chat-<uuid>) or provider id to the
// short prefix the operator knows. The request log stores the internal id; the
// Model Status page already does this translation so a UUID never reaches the
// screen. Same rule here: prefer a custom-prefix on the node, else the alias,
// else the raw id.
function makePrefixResolver(nodeMap = {}) {
  return (providerId) => {
    if (!providerId) return "unknown";
    const node = nodeMap[providerId];
    if (node) return node.prefix || node.name || providerId;
    const config = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
    if (config?.alias) return config.alias;
    if (config?.id) return config.id;
    return providerId;
  };
}

// GET /api/providers/quota?hours=24
//
// Two questions in one payload:
//   providers  — every provider with traffic in the window, with a
//                success/quota/rate/unknown breakdown. This is the page the
//                operator wants to LOOK at: which provider is doing the work,
//                which one is cooling down.
//   exhausted  — the strict subset whose allowance is spent (quota hit, no
//                success in the window). This is what a sweep must stop on.
//
// The previous shape returned only the second list, so a healthy instance
// rendered three counters and an empty table. The list is the signal.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const hours = parseWindow(url.searchParams.get("hours"));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();

    const db = await getAdapter();
    const rows = db.all(
      `SELECT provider, status, data, timestamp
         FROM requestDetails
        WHERE timestamp >= ? AND provider IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?`,
      [since, MAX_ROWS]
    );

    // Node lookup for prefix resolution. Cosmetic: a failure here still yields
    // a usable report, just with raw ids in the provider column.
    const nodeMap = {};
    try {
      const { getProviderNodes } = await import("@/lib/localDb");
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node?.id) nodeMap[node.id] = { prefix: node.prefix, name: node.name };
      }
    } catch { /* cosmetic only */ }
    const toPrefix = makePrefixResolver(nodeMap);

    // Per-provider rollup over EVERY row (not just failures): the operator
    // needs to see the provider that handled 400 requests, not only the ones
    // that hit a wall.
    const byPrefix = new Map();
    const quotaEntries = [];

    for (const row of rows) {
      const prefix = toPrefix(row.provider);
      if (!byPrefix.has(prefix)) {
        byPrefix.set(prefix, {
          provider: prefix,
          rawProviders: new Set(),
          total: 0,
          success: 0,
          quota: 0,
          rate: 0,
          unknown: 0,
          other: 0,
          lastReason: "",
          lastCode: null,
          lastSeen: null,
        });
      }
      const agg = byPrefix.get(prefix);
      agg.rawProviders.add(row.provider);
      agg.total += 1;
      // Newest-first ordering means the first row per prefix is the latest.
      if (!agg.lastSeen) agg.lastSeen = row.timestamp || null;

      if (isSuccessStatus(row.status)) {
        agg.success += 1;
        continue;
      }

      // Failure row: classify the body.
      const detail = parseJson(row.data, null);
      if (!detail) { agg.unknown += 1; continue; }
      const body = pickBody(detail);
      const statusCode = detail.statusCode ?? body?.status ?? null;
      const cls = classifyProviderResponse({ body, statusCode });
      if (cls.state === QUOTA_STATE.QUOTA) {
        agg.quota += 1;
        agg.lastReason = cls.reason || agg.lastReason;
        agg.lastCode = cls.code ?? agg.lastCode;
      } else if (cls.state === QUOTA_STATE.RATE) {
        agg.rate += 1;
      } else if (cls.state === QUOTA_STATE.UNKNOWN) {
        agg.unknown += 1;
      } else {
        agg.other += 1;
      }
      quotaEntries.push({ provider: row.provider, body, statusCode });
    }

    // summarizeQuota retains the sole "stop a sweep" verdict; the per-provider
    // rollup above answers the wider question the UI needs.
    const summary = summarizeQuota(quotaEntries);
    const exhaustedSet = new Set(summary.exhaustedProviders.map((p) => toPrefix(p)));

    const providers = [...byPrefix.values()]
      .map((p) => ({
        provider: p.provider,
        rawProviders: [...p.rawProviders],
        total: p.total,
        success: p.success,
        quota: p.quota,
        rate: p.rate,
        unknown: p.unknown,
        other: p.other,
        successRate: p.total > 0 ? p.success / p.total : 0,
        exhausted: exhaustedSet.has(p.provider),
        lastReason: p.lastReason,
        lastCode: p.lastCode,
        lastSeen: p.lastSeen,
      }))
      .sort((a, b) => b.total - a.total);

    return NextResponse.json({
      windowHours: hours,
      since,
      generatedAt: new Date().toISOString(),
      scannedRows: rows.length,
      failedRows: quotaEntries.length,
      providers,
      exhausted: providers.filter((p) => p.exhausted).map((p) => p.provider),
      counters: {
        total: providers.length,
        exhausted: providers.filter((p) => p.exhausted).length,
        rateLimited: providers.filter((p) => p.rate > 0 && !p.exhausted).length,
        healthy: providers.filter((p) => p.total > 0 && p.quota === 0).length,
      },
    });
  } catch (error) {
    console.error("[API] provider quota failed:", error);
    return NextResponse.json({ error: "Failed to build quota report" }, { status: 500 });
  }
}
