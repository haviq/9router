import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db";
import { parseJson } from "@/lib/db/helpers/jsonCol";
import { summarizeQuota } from "open-sse/utils/quotaWatch.js";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

export const dynamic = "force-dynamic";

const ALLOWED_WINDOWS = [1, 6, 24, 72, 168];
const DEFAULT_WINDOW_HOURS = 24;
const MAX_ROWS = 5000;

function parseWindow(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;
  // Snap to an allowed window so a hand-edited query string cannot ask the DB
  // to scan an arbitrary timestamp range.
  return ALLOWED_WINDOWS.reduce(
    (best, w) => (Math.abs(w - n) < Math.abs(best - n) ? w : best),
    DEFAULT_WINDOW_HOURS
  );
}

// Choose the body that actually carries the failure.
//
// providerResponse is empty on real failures — a live error row had
// `providerResponse: {}` while the message sat in `response`. `??` cannot catch
// that (an empty object is not nullish), so prefer whichever has content and
// fall back to the raw string when the payload is a JSON string.
function pickBody(detail) {
  const candidates = [detail?.providerResponse, detail?.response];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === "string") {
      if (candidate.trim()) return candidate;
      continue;
    }
    if (typeof candidate === "object") {
      if (Object.keys(candidate).length > 0) return candidate;
    }
  }

  return null;
}

function displayName(providerId, nodeNames) {
  if (nodeNames[providerId]) return nodeNames[providerId];
  const config = getProviderByAlias(providerId) || AI_PROVIDERS[providerId];
  return config?.name || providerId;
}

// GET /api/providers/quota?hours=24
//
// Which providers are out of allowance right now, and why. The request log has
// no quota column — the signal lives inside the providerResponse JSON — so this
// reads a bounded sample of recent rows and classifies each one.
//
// Bounded on purpose: the bodies are large and only recent failures matter. A
// provider that ran dry yesterday and was topped up this morning must not show
// as exhausted, which is why the window is short by default.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const hours = parseWindow(url.searchParams.get("hours"));
    const since = new Date(Date.now() - hours * 3600_000).toISOString();

    const db = await getAdapter();

    // Only rows that carry a provider response can be classified; a successful
    // call with no error body adds nothing but I/O.
    const rows = db.all(
      `SELECT provider, status, data
         FROM requestDetails
        WHERE timestamp >= ? AND provider IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?`,
      [since, MAX_ROWS]
    );

    const entries = [];
    for (const row of rows) {
      const detail = parseJson(row.data, null);
      if (!detail) continue;

      // A success row cannot be quota-exhausted. Skipping those keeps the
      // classifier off the common path and makes the ok/total ratio meaningful.
      const isSuccess = row.status === "success" || row.status === "completed" || row.status === "200 OK";
      if (isSuccess) continue;

      // providerResponse is not reliably populated on failures. A real error row
      // on this instance carried `providerResponse: {}` while the actual body
      // ({"error":"...","status":401}) sat in `response`. `??` does not help —
      // an empty object is not nullish — so pick whichever one carries content.
      const body = pickBody(detail);

      entries.push({
        provider: row.provider,
        body,
        statusCode: detail.statusCode ?? body?.status ?? null,
      });
    }

    const summary = summarizeQuota(entries);

    let nodeNames = {};
    try {
      const { getProviderNodes } = await import("@/lib/localDb");
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node?.id) nodeNames[node.id] = node.name || node.id;
      }
    } catch {
      // Cosmetic only; a missing registry must not fail the report.
    }

    const providers = summary.providers.map((p) => ({
      ...p,
      name: displayName(p.provider, nodeNames),
    }));

    return NextResponse.json({
      windowHours: hours,
      since,
      generatedAt: new Date().toISOString(),
      scannedRows: rows.length,
      failedRows: entries.length,
      providers,
      exhausted: providers.filter((p) => p.exhausted).map((p) => p.provider),
    });
  } catch (error) {
    console.error("[API] provider quota failed:", error);
    return NextResponse.json({ error: "Failed to build quota report" }, { status: 500 });
  }
}
