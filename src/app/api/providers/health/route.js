import { NextResponse } from "next/server";
import { getProviderHealth } from "@/lib/db";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS = [1, 6, 24, 72, 168];
const DEFAULT_WINDOW_HOURS = 24;
const MAX_LATENCY_SAMPLE = 2000;

function parseWindow(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;
  // Snap to the nearest allowed window so a hand-edited query string cannot
  // ask the DB to scan an arbitrarily wide timestamp range.
  return ALLOWED_WINDOWS.reduce(
    (best, w) => (Math.abs(w - n) < Math.abs(best - n) ? w : best),
    DEFAULT_WINDOW_HOURS
  );
}

function parseSample(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 400;
  return Math.min(MAX_LATENCY_SAMPLE, Math.floor(n));
}

function displayName(providerId, nodeNames) {
  if (nodeNames[providerId]) return nodeNames[providerId];
  const config = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return config?.name || providerId;
}

// GET /api/providers/health?hours=24&sample=400
//
// Rolling per-provider success rate and latency percentiles derived from the
// requestDetails table. Counts are exact for the window; latency is a bounded
// sample of the most recent rows (see getProviderHealth).
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const hours = parseWindow(url.searchParams.get("hours"));
    const latencySample = parseSample(url.searchParams.get("sample"));

    const health = await getProviderHealth({ hours, latencySample });

    // Resolve display names once here rather than shipping the whole provider
    // registry to the client just to label a row.
    let nodeNames = {};
    try {
      const { getProviderNodes } = await import("@/lib/localDb");
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node?.id) nodeNames[node.id] = node.name || node.id;
      }
    } catch {
      // Node names are cosmetic; a missing registry must not fail the report.
    }

    const providers = health.providers.map((entry) => ({
      ...entry,
      name: displayName(entry.provider, nodeNames),
    }));

    const totals = providers.reduce(
      (acc, p) => {
        acc.total += p.total;
        acc.ok += p.ok;
        acc.failed += p.failed;
        return acc;
      },
      { total: 0, ok: 0, failed: 0 }
    );

    return NextResponse.json({
      ...health,
      providers,
      totals: {
        ...totals,
        successRate: totals.total > 0 ? totals.ok / totals.total : null,
        providerCount: providers.length,
      },
    });
  } catch (error) {
    console.error("[API] provider health failed:", error);
    return NextResponse.json({ error: "Failed to build provider health" }, { status: 500 });
  }
}
