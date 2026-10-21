// Combo healing: which seats survive, and when healing must refuse to act.
// Pure functions — every branch is reachable without a DB.
import { describe, it, expect } from "vitest";
import {
  buildLiveAliases,
  classifySeat,
  planComboHeal,
  applyComboHeal,
} from "@/lib/comboHeal.js";

const live = (...aliases) => new Set(aliases);

function conn(provider, extra = {}) {
  return { provider, isActive: true, providerSpecificData: {}, ...extra };
}

describe("buildLiveAliases", () => {
  it("returns an empty set for no connections", () => {
    expect(buildLiveAliases([]).size).toBe(0);
    expect(buildLiveAliases(undefined).size).toBe(0);
  });

  it("skips switched-off connections", () => {
    const set = buildLiveAliases([conn("deepseek", { isActive: false })]);
    expect(set.size).toBe(0);
  });

  it("registers the provider id and its alias", () => {
    const set = buildLiveAliases([conn("deepseek")]);
    expect(set.has("deepseek")).toBe(true);
    expect(set.has("ds")).toBe(true);
  });

  it("honours a custom prefix alongside the defaults", () => {
    const set = buildLiveAliases([conn("deepseek", { providerSpecificData: { prefix: "mine" } })]);
    expect(set.has("mine")).toBe(true);
    expect(set.has("ds")).toBe(true);
  });
});

describe("classifySeat", () => {
  it("classifies empty, nested, live and dead", () => {
    expect(classifySeat("", live("ds"))).toBe("empty");
    expect(classifySeat("  ", live("ds"))).toBe("empty");
    expect(classifySeat("inner-combo", live("ds"))).toBe("nested");
    expect(classifySeat("ds/deepseek-chat", live("ds"))).toBe("live");
    expect(classifySeat("ghost/model", live("ds"))).toBe("dead");
  });
});

describe("planComboHeal", () => {
  it("removes dead seats and keeps live ones", () => {
    const plan = planComboHeal(
      { models: ["ds/deepseek-chat", "ghost/model"] },
      live("ds")
    );
    expect(plan.keep).toEqual(["ds/deepseek-chat"]);
    expect(plan.removed).toEqual(["ghost/model"]);
    expect(plan.changed).toBe(true);
    expect(plan.wouldEmpty).toBe(false);
  });

  it("reports no change when every seat is live", () => {
    const plan = planComboHeal(
      { models: ["ds/deepseek-chat", "ds/deepseek-reasoner"] },
      live("ds")
    );
    expect(plan.changed).toBe(false);
    expect(plan.removed).toEqual([]);
    expect(plan.liveCount).toBe(2);
  });

  it("flags wouldEmpty when no seat survives", () => {
    const plan = planComboHeal({ models: ["ghost/a", "ghost/b"] }, live("ds"));
    expect(plan.keep).toEqual([]);
    expect(plan.removed).toEqual(["ghost/a", "ghost/b"]);
    expect(plan.wouldEmpty).toBe(true);
  });

  it("never flags wouldEmpty for an already-empty combo", () => {
    const plan = planComboHeal({ models: [] }, live("ds"));
    expect(plan.wouldEmpty).toBe(false);
    expect(plan.changed).toBe(false);
  });

  it("drops a nested combo whose members are all dead", () => {
    const plan = planComboHeal(
      { models: ["dead-inner", "ds/deepseek-chat"] },
      live("ds"),
      { "dead-inner": ["ghost/model"] }
    );
    expect(plan.deadNested).toEqual(["dead-inner"]);
    expect(plan.keep).toEqual(["ds/deepseek-chat"]);
  });

  it("keeps a nested combo with at least one live member", () => {
    const plan = planComboHeal(
      { models: ["mixed-inner"] },
      live("ds"),
      { "mixed-inner": ["ghost/model", "ds/deepseek-chat"] }
    );
    expect(plan.keep).toEqual(["mixed-inner"]);
    expect(plan.deadNested).toEqual([]);
  });

  it("drops a nested combo that resolves to nothing", () => {
    const plan = planComboHeal({ models: ["empty-inner"] }, live("ds"), { "empty-inner": [] });
    expect(plan.deadNested).toEqual(["empty-inner"]);
  });

  it("survives a nested cycle without hanging", () => {
    const plan = planComboHeal(
      { models: ["loop-a"] },
      live("ds"),
      { "loop-a": ["loop-b"], "loop-b": ["loop-a"] }
    );
    expect(plan.deadNested).toEqual(["loop-a"]);
    expect(plan.keep).toEqual([]);
  });

  it("resolves deeply nested live members", () => {
    const plan = planComboHeal(
      { models: ["outer"] },
      live("ds"),
      { outer: ["inner"], inner: ["ds/deepseek-chat"] }
    );
    expect(plan.keep).toEqual(["outer"]);
  });

  it("skips blank entries instead of counting them dead", () => {
    const plan = planComboHeal({ models: ["", "  ", "ds/deepseek-chat"] }, live("ds"));
    expect(plan.removed).toEqual([]);
    expect(plan.keep).toEqual(["ds/deepseek-chat"]);
  });
});

describe("applyComboHeal", () => {
  it("replaces models with the kept seats and preserves the rest", () => {
    const combo = { id: "1", name: "c", kind: null, models: ["ds/a", "ghost/b"] };
    const plan = planComboHeal(combo, live("ds"));
    const healed = applyComboHeal(combo, plan);

    expect(healed.models).toEqual(["ds/a"]);
    expect(healed.id).toBe("1");
    expect(healed.name).toBe("c");
  });
});
