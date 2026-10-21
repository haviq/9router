import { NextResponse } from "next/server";
import { getCombos, getProviderConnections, updateCombo } from "@/lib/localDb";
import { resetComboRotation } from "open-sse/services/combo.js";
import {
  buildLiveAliases,
  planComboHeal,
  applyComboHeal,
} from "@/lib/comboHeal.js";

export const dynamic = "force-dynamic";

// POST /api/combos/heal
//
// Body: { dryRun?: boolean, ids?: string[] }
//
// Drops seats whose provider is switched off. Dry-run is the default: healing
// rewrites stored rows, and an operator who only wanted a preview should not
// discover that the list changed because they clicked once.
//
// A combo whose every seat is dead is left untouched and reported instead.
// Emptying it would leave a row that looks like a fresh combo and hides the
// fact that the providers behind it went away — that decision belongs to the
// operator, not to a bulk repair.
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is a valid dry run.
  }

  const dryRun = body?.dryRun !== false;
  const onlyIds = Array.isArray(body?.ids)
    ? new Set(body.ids.filter((id) => typeof id === "string"))
    : null;

  try {
    const [combos, connections] = await Promise.all([
      getCombos(),
      getProviderConnections(),
    ]);

    const liveAliases = buildLiveAliases(connections);
    const comboByName = Object.fromEntries(
      combos.filter((c) => typeof c?.name === "string").map((c) => [c.name, c.models])
    );

    const healed = [];
    const skipped = [];
    const unchanged = [];

    for (const combo of combos) {
      if (onlyIds && !onlyIds.has(combo.id)) continue;

      const plan = planComboHeal(combo, liveAliases, comboByName);

      if (!plan.changed) {
        unchanged.push({ id: combo.id, name: combo.name });
        continue;
      }

      if (plan.wouldEmpty) {
        skipped.push({
          id: combo.id,
          name: combo.name,
          reason: "every seat is unreachable — not emptied automatically",
          dead: [...plan.removed, ...plan.deadNested],
        });
        continue;
      }

      const entry = {
        id: combo.id,
        name: combo.name,
        before: Array.isArray(combo.models) ? combo.models.length : 0,
        after: plan.keep.length,
        removed: plan.removed,
        deadNested: plan.deadNested,
        models: plan.keep,
      };

      if (!dryRun) {
        const next = applyComboHeal(combo, plan);
        const saved = await updateCombo(combo.id, { models: next.models });
        if (!saved) {
          skipped.push({ id: combo.id, name: combo.name, reason: "update failed" });
          continue;
        }
        // Rotation state holds an index into the old model list; after a heal
        // that index may point past the end or at a different seat.
        resetComboRotation(combo.name);
      }

      healed.push(entry);
    }

    return NextResponse.json({
      dryRun,
      healed,
      skipped,
      unchanged,
      summary: {
        combosScanned: combos.length,
        combosHealed: healed.length,
        combosSkipped: skipped.length,
        combosUnchanged: unchanged.length,
        seatsRemoved: healed.reduce((n, h) => n + h.removed.length + h.deadNested.length, 0),
      },
    });
  } catch (error) {
    console.error("[API] combo heal failed:", error);
    return NextResponse.json({ error: "Failed to heal combos" }, { status: 500 });
  }
}
