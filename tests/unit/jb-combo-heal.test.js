import { describe, it, expect, beforeEach } from "vitest";
import {
  planHeal,
  applyHeal,
  getHealState,
  resetHealState,
  HEAL_THRESHOLDS,
} from "@/lib/jbComboHeal.js";
import {
  shouldNotify,
  resetNotifyDedup,
  NOTIFY_LIMITS,
} from "@/lib/notifier.js";

beforeEach(() => {
  resetHealState();
  resetNotifyDedup();
});

describe("jbComboHeal — planHeal", () => {
  const seats = ["a", "b", "c"];

  it("proposes nothing on a clean combo", () => {
    const plan = planHeal({ combo: "jb", seats, outcomes: {} });
    expect(plan.toDrop).toEqual([]);
    expect(plan.toRestore).toEqual([]);
  });

  it("drops a seat after the drop threshold is reached", () => {
    // First two failures do not drop (threshold = 3).
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    const plan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    expect(plan.toDrop.map((d) => d.seat)).toContain("a");
  });

  it("does not touch a healthy seat", () => {
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    const plan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    expect(plan.toDrop).toEqual([]);
  });

  it("reset failure counter on recovery", () => {
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    const plan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    expect(plan.toDrop).toEqual([]); // failure counter was reset
  });

  it("restores a dropped seat after a success streak", () => {
    // Force a drop
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    const dropPlan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: false } } });
    applyHeal(dropPlan);

    // Two successes should be enough to restore
    planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    const restorePlan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: true } } });
    expect(restorePlan.toRestore.map((r) => r.seat)).toContain("a");
  });

  it("never proposes dropping every seat", () => {
    // Fail every seat 3×, check that at least one survives
    for (let i = 0; i < 3; i += 1) {
      planHeal({ combo: "jb", seats, outcomes: { a: { ok: false }, b: { ok: false }, c: { ok: false } } });
    }
    const plan = planHeal({ combo: "jb", seats, outcomes: {} });
    // Either some seats are not dropped, or the guard kicked in and trimmed
    const dropped = new Set(plan.toDrop.map((d) => d.seat));
    expect(dropped.size).toBeLessThan(seats.length);
  });

  it("front-loads a reconcile with observations only", () => {
    const plan = planHeal({ combo: "jb", seats, outcomes: { a: { ok: true }, b: { ok: true } } });
    expect(plan.toDrop).toEqual([]);
    const s = getHealState("jb", ["a", "b"]);
    expect(s.a.consecutiveOks).toBeGreaterThan(0);
    expect(s.b.consecutiveOks).toBeGreaterThan(0);
  });

  it("exposes the default thresholds", () => {
    expect(HEAL_THRESHOLDS.DEFAULT_DROP_THRESHOLD).toBe(3);
    expect(HEAL_THRESHOLDS.DEFAULT_RESTORE_THRESHOLD).toBe(2);
  });
});

describe("notifier — dedupe", () => {
  it("allows the first alert for a key", () => {
    expect(shouldNotify("provider-down:kl")).toBe(true);
  });

  it("suppresses repeated alerts inside the window", () => {
    shouldNotify("provider-down:kl");
    expect(shouldNotify("provider-down:kl")).toBe(false);
  });

  it("allows a different key immediately", () => {
    shouldNotify("provider-down:kl");
    expect(shouldNotify("provider-down:mg")).toBe(true);
  });

  it("allows without a key (no dedup)", () => {
    expect(shouldNotify(null)).toBe(true);
    expect(shouldNotify("")).toBe(true);
  });

  it("expires the dedup window", () => {
    shouldNotify("evt");
    const future = Date.now() + NOTIFY_LIMITS.DEDUP_WINDOW_MS + 1;
    expect(shouldNotify("evt", future)).toBe(true);
  });
});
