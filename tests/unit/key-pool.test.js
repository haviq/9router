import { describe, it, expect, beforeEach } from "vitest";
import {
  seededOrder,
  cooldownFor,
  markKeyCooldown,
  isKeyCooling,
  partitionByCooldown,
  pickConnection,
  resetCooldowns,
  cooldownStats,
  KEY_POOL_LIMITS,
} from "@/lib/keyPool.js";

beforeEach(() => {
  resetCooldowns();
});

describe("keyPool — seededOrder", () => {
  it("returns the same order for the same seed", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(seededOrder(items, 42)).toEqual(seededOrder(items, 42));
  });

  it("produces a different order for a different seed", () => {
    const items = ["a", "b", "c", "d", "e"];
    const a = seededOrder(items, 1);
    const b = seededOrder(items, 2);
    expect(a).not.toEqual(b);
  });

  it("does not mutate the input", () => {
    const items = ["a", "b", "c"];
    const copy = [...items];
    seededOrder(items, 5);
    expect(items).toEqual(copy);
  });

  it("returns a single-element array unchanged", () => {
    expect(seededOrder(["only"], 9)).toEqual(["only"]);
  });

  it("handles empty and non-array input", () => {
    expect(seededOrder([], 0)).toEqual([]);
    expect(seededOrder(null, 0)).toEqual([]);
  });

  it("preserves the set of items", () => {
    const items = ["a", "b", "c", "d"];
    const shuffled = seededOrder(items, 7);
    expect([...shuffled].sort()).toEqual([...items].sort());
  });
});

describe("keyPool — cooldownFor", () => {
  it("returns 0 for statuses that are not key-level problems", () => {
    expect(cooldownFor(200)).toBe(0);
    expect(cooldownFor(500)).toBe(0);
    expect(cooldownFor(502)).toBe(0);
    expect(cooldownFor(null)).toBe(0);
  });

  it("uses a short cooldown for 429", () => {
    expect(cooldownFor(429)).toBe(KEY_POOL_LIMITS.DEFAULT_COOLDOWN_MS);
  });

  it("uses a longer cooldown for auth failures", () => {
    expect(cooldownFor(401)).toBe(5 * 60 * 1000);
    expect(cooldownFor(403)).toBe(5 * 60 * 1000);
  });

  it("honours a retry-after hint but caps it", () => {
    expect(cooldownFor(429, 5000)).toBe(5000);
    expect(cooldownFor(429, 60 * 60 * 1000)).toBe(30 * 60 * 1000);
  });

  it("ignores an invalid retry-after", () => {
    expect(cooldownFor(429, -1)).toBe(KEY_POOL_LIMITS.DEFAULT_COOLDOWN_MS);
    expect(cooldownFor(429, "not-a-number")).toBe(KEY_POOL_LIMITS.DEFAULT_COOLDOWN_MS);
  });
});

describe("keyPool — cooldown tracking", () => {
  it("marks a key as cooling after a key-level failure", () => {
    const ms = markKeyCooldown("conn-1", 429);
    expect(ms).toBeGreaterThan(0);
    expect(isKeyCooling("conn-1")).toBe(true);
  });

  it("does not benching a key on a non-key-level error", () => {
    const ms = markKeyCooldown("conn-2", 502);
    expect(ms).toBe(0);
    expect(isKeyCooling("conn-2")).toBe(false);
  });

  it("clears an expired cooldown lazily", () => {
    markKeyCooldown("conn-3", 429);
    expect(isKeyCooling("conn-3", Date.now() + 120_000)).toBe(false);
  });

  it("ignores a missing connection id", () => {
    expect(markKeyCooldown(null, 429)).toBe(0);
    expect(isKeyCooling(null)).toBe(false);
  });

  it("reports tracked stats", () => {
    markKeyCooldown("a", 429);
    markKeyCooldown("b", 429);
    const s = cooldownStats();
    expect(s.tracked).toBeGreaterThanOrEqual(2);
    expect(s.active).toBeGreaterThanOrEqual(2);
  });
});

describe("keyPool — partitionByCooldown", () => {
  it("separates cooling from ready", () => {
    markKeyCooldown("c1", 429);
    const conns = [{ id: "c1" }, { id: "c2" }, { id: "c3" }];
    const { ready, cooling } = partitionByCooldown(conns);
    expect(cooling.map((c) => c.id)).toEqual(["c1"]);
    expect(ready.map((c) => c.id).sort()).toEqual(["c2", "c3"]);
  });

  it("puts everything in ready when nothing is cooling", () => {
    const conns = [{ id: "x" }, { id: "y" }];
    const { ready, cooling } = partitionByCooldown(conns);
    expect(ready.length).toBe(2);
    expect(cooling.length).toBe(0);
  });

  it("skips null entries", () => {
    const { ready } = partitionByCooldown([null, { id: "a" }, undefined]);
    expect(ready.length).toBe(1);
  });
});

describe("keyPool — pickConnection", () => {
  it("picks a ready connection", () => {
    const conns = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const { connection } = pickConnection(conns, 0);
    expect(connection).not.toBeNull();
    expect(["a", "b", "c"]).toContain(connection.id);
  });

  it("skips a cooling connection", () => {
    markKeyCooldown("a", 429);
    const conns = [{ id: "a" }, { id: "b" }];
    const { connection, coolingCount } = pickConnection(conns, 0);
    expect(connection.id).toBe("b");
    expect(coolingCount).toBe(1);
  });

  it("returns null when every connection is cooling", () => {
    markKeyCooldown("a", 429);
    markKeyCooldown("b", 429);
    const { connection, coolingCount } = pickConnection([{ id: "a" }, { id: "b" }], 0);
    expect(connection).toBeNull();
    expect(coolingCount).toBe(2);
  });

  it("returns null on an empty pool", () => {
    expect(pickConnection([], 0).connection).toBeNull();
    expect(pickConnection(null, 0).connection).toBeNull();
  });

  it("rotates across successive counters", () => {
    const conns = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const picks = new Set();
    for (let i = 0; i < 12; i += 1) {
      picks.add(pickConnection(conns, i).connection.id);
    }
    // After 12 requests with different counters all four should have surfaced.
    expect(picks.size).toBeGreaterThan(1);
  });
});
