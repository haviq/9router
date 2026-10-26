import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { summarizeCost, checkCostAlert, resolveConfig } from "@/lib/costAlert.js";

export const dynamic = "force-dynamic";

// POST /api/developer/cost-alert?days=1&check=1
//
// Runs the cost rollup and, when check=1, compares it against the configured
// threshold and fires a Telegram alert if exceeded. The GET of cost-summary
// stays read-only; the check lives on a POST because it can send a message.
//
// The dedup in checkCostAlert is per UTC day, so a cron that hits this every
// fifteen minutes still sends one notice a day when the threshold is breached.
export async function POST(request) {
  try {
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 1));
    const check = url.searchParams.get("check") === "1";
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, status, data FROM requestDetails
         WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 20000`,
      [sinceIso]
    );

    const summary = await summarizeCost(rows);

    let alert = null;
    if (check) {
      let settings = {};
      try {
        const { getSettings } = await import("@/lib/localDb");
        settings = await getSettings();
      } catch { /* settings unavailable → alert stays disabled */ }
      const cfg = resolveConfig(settings);
      alert = await checkCostAlert(summary, {
        costAlertEnabled: cfg.enabled,
        costAlertDailyThresholdUsd: cfg.dailyUsdThreshold,
      });
    }

    return NextResponse.json({ windowDays: days, summary, alert });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 1));
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, status, data FROM requestDetails
         WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 20000`,
      [sinceIso]
    );
    const summary = await summarizeCost(rows);
    return NextResponse.json({ windowDays: days, summary });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
