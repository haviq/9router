import { NextResponse } from "next/server";
import { pingModelByKind } from "@/app/api/models/test/ping";
import { getCombos } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/developer/jb-combo-verify
//
// Body: { combo?: "jb", probe?: "hi" }
//
// Verify every seat of a combo with a tiny probe and report per-seat status.
// The combo collapse semantics (transport fail OR refusal → next seat) mean a
// dead first seat is invisible from the user's side: request still succeeds via
// seat 2, and nothing ever records that seat 1 stopped answering. This endpoint
// makes that state visible so a compositor cron can drop dead seats.
//
// Probe payload stays at the smallest possible size. The point is "did the
// upstream answer", not "did the payload land" — a heavy probe here would burn
// token budget on every sweep and pick up refusal noise that has nothing to do
// with whether the seat is alive.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const comboName = typeof body.combo === "string" && body.combo.trim() ? body.combo.trim() : "jb";
    const probe = typeof body.probe === "string" && body.probe.trim() ? body.probe.trim() : "hi";

    const combos = await getCombos().catch(() => []);
    const combo = Array.isArray(combos) ? combos.find((c) => c && c.name === comboName) : null;
    if (!combo || !Array.isArray(combo.models) || combo.models.length === 0) {
      return NextResponse.json({ error: `Combo '${comboName}' tidak ditemukan atau tanpa seat` }, { status: 404 });
    }

    const seats = combo.models.filter((m) => typeof m === "string" && m.trim());
    const startedAt = Date.now();

    // Sequential on purpose. Concurrent seat probes race the same provider
    // rate limiter and a 429 on seat 3 lands as a "dead seat" even though the
    // seat is fine — an error the operator has to debug twice.
    const results = [];
    for (let i = 0; i < seats.length; i += 1) {
      const seat = seats[i];
      const res = await pingModelByKind(seat, "llm").catch((err) => ({
        ok: false,
        latencyMs: 0,
        error: err?.message || "probe exception",
        status: 500,
      }));
      results.push({
        index: i,
        seat,
        ok: Boolean(res.ok),
        status: res.status || (res.ok ? 200 : 500),
        latencyMs: Number(res.latencyMs) || 0,
        error: res.error || null,
        note: res.note || null,
      });
    }

    const live = results.filter((r) => r.ok);
    const dead = results.filter((r) => !r.ok);

    return NextResponse.json({
      combo: comboName,
      totalSeats: seats.length,
      liveSeats: live.length,
      deadSeats: dead.length,
      // Chain health, not individual seat health: a combo with at least one
      // live seat can still serve requests, and calling that "broken" would
      // page an operator who has nothing to fix.
      healthy: live.length > 0,
      fullyHealthy: dead.length === 0,
      suggestRemove: dead.map((d) => d.seat),
      elapsedMs: Date.now() - startedAt,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
