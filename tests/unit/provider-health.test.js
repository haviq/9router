// Per-provider health aggregation: exact counts from SQL, bounded latency
// sample from the JSON blob, and the guarantee that unused providers are not
// painted as failing.
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the SQLite adapter. Each test seeds `rows`.
const state = vi.hoisted(() => ({ rows: [] }));

const adapter = vi.hoisted(() => ({
  driver: "test",
  all: vi.fn((sql, params) => {
    if (sql.includes("GROUP BY provider, status")) {
      const since = params[0];
      const agg = new Map();
      for (const r of state.rows) {
        if (r.timestamp < since || !r.provider) continue;
        const key = `${r.provider}::${r.status || "unknown"}`;
        agg.set(key, (agg.get(key) || 0) + 1);
      }
      return [...agg.entries()].map(([key, c]) => {
        const [provider, status] = key.split("::");
        return { provider, status, c };
      });
    }
    if (sql.includes("SELECT provider, data")) {
      const since = params[0];
      const limit = params[1];
      return state.rows
        .filter((r) => r.timestamp >= since && r.provider)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, limit)
        .map((r) => ({ provider: r.provider, data: r.data }));
    }
    return [];
  }),
  get: vi.fn(() => ({ c: 0 })),
  run: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => adapter),
  getAdapterSync: vi.fn(() => adapter),
}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({})),
}));

const { getProviderHealth } = await import("@/lib/db/repos/requestDetailsRepo.js");

const now = () => new Date().toISOString();
const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();

function row(provider, status, latencyMs, timestamp = now()) {
  return {
    provider,
    status,
    timestamp,
    data: JSON.stringify({ latency: { total: latencyMs, ttft: 0 } }),
  };
}

beforeEach(() => {
  state.rows = [];
});

describe("getProviderHealth", () => {
  it("counts successes and failures per provider", async () => {
    state.rows = [
      row("alpha", "success", 100),
      row("alpha", "success", 200),
      row("alpha", "error", 900),
      row("beta", "success", 50),
    ];
    const health = await getProviderHealth({ hours: 24 });
    const alpha = health.providers.find((p) => p.provider === "alpha");
    const beta = health.providers.find((p) => p.provider === "beta");

    expect(alpha).toMatchObject({ total: 3, ok: 2, failed: 1 });
    expect(alpha.successRate).toBeCloseTo(2 / 3, 5);
    expect(beta).toMatchObject({ total: 1, ok: 1, failed: 0 });
    expect(beta.successRate).toBe(1);
  });

  it("sorts providers by request volume", async () => {
    state.rows = [
      row("small", "success", 10),
      row("big", "success", 10),
      row("big", "success", 20),
      row("big", "success", 30),
    ];
    const health = await getProviderHealth({ hours: 24 });
    expect(health.providers.map((p) => p.provider)).toEqual(["big", "small"]);
  });

  it("ignores rows outside the window", async () => {
    state.rows = [row("alpha", "success", 100, ago(48)), row("beta", "success", 100)];
    const health = await getProviderHealth({ hours: 24 });
    expect(health.providers.map((p) => p.provider)).toEqual(["beta"]);
  });

  it("computes latency percentiles from the sample", async () => {
    state.rows = [100, 200, 300, 400, 500].map((ms) => row("alpha", "success", ms));
    const health = await getProviderHealth({ hours: 24, latencySample: 100 });
    const alpha = health.providers.find((p) => p.provider === "alpha");

    expect(alpha.latency.samples).toBe(5);
    expect(alpha.latency.p50).toBe(300);
    expect(alpha.latency.p95).toBe(500);
    expect(alpha.latency.max).toBe(500);
  });

  it("skips rows whose latency is missing or non-positive", async () => {
    state.rows = [
      row("alpha", "success", 0),
      { provider: "alpha", status: "success", timestamp: now(), data: "{}" },
      { provider: "alpha", status: "success", timestamp: now(), data: "not-json" },
      row("alpha", "success", 250),
    ];
    const health = await getProviderHealth({ hours: 24 });
    const alpha = health.providers.find((p) => p.provider === "alpha");

    // All four rows count; only the valid one contributes latency.
    expect(alpha.total).toBe(4);
    expect(alpha.latency.samples).toBe(1);
    expect(alpha.latency.p50).toBe(250);
  });

  it("returns null percentiles when no latency is available", async () => {
    state.rows = [row("alpha", "error", 0)];
    const health = await getProviderHealth({ hours: 24 });
    const alpha = health.providers.find((p) => p.provider === "alpha");

    expect(alpha.latency.samples).toBe(0);
    expect(alpha.latency.p50).toBeNull();
    expect(alpha.latency.p95).toBeNull();
    expect(alpha.latency.max).toBeNull();
  });

  it("reports the sample cap and coverage so the UI can label it a sample", async () => {
    state.rows = Array.from({ length: 10 }, (_, i) => row("alpha", "success", 100 + i));
    const health = await getProviderHealth({ hours: 24, latencySample: 4 });

    expect(health.latencySampleCap).toBe(4);
    expect(health.sampledRows).toBe(4);
    expect(health.latencyCoverage).toBe(1);
  });

  it("returns an empty list when nothing was recorded", async () => {
    const health = await getProviderHealth({ hours: 24 });
    expect(health.providers).toEqual([]);
    expect(health.sampledRows).toBe(0);
    expect(health.latencyCoverage).toBeNull();
  });

  it("treats an unknown status as a failure, not a success", async () => {
    state.rows = [row("alpha", null, 100), row("alpha", "success", 100)];
    const health = await getProviderHealth({ hours: 24 });
    const alpha = health.providers.find((p) => p.provider === "alpha");

    expect(alpha.ok).toBe(1);
    expect(alpha.failed).toBe(1);
    expect(alpha.byStatus.unknown).toBe(1);
  });
});
