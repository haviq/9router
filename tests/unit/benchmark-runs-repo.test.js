// Persistence for benchmark outcomes.
//
// The behaviour that matters is not "does it insert a row" — it is which rows
// are allowed in. A transport error measures the provider, not the payload, and
// storing that as a refusal is how a payload that works gets thrown away on the
// next read of MODEL_VARIANT_MAP.
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ rows: [], inserts: [], deletes: [] }));

const adapter = vi.hoisted(() => ({
  driver: "test",
  run: vi.fn((sql, params) => {
    if (sql.includes("INSERT INTO benchmarkRuns")) {
      state.inserts.push(params);
    } else if (sql.includes("DELETE FROM benchmarkRuns")) {
      state.deletes.push(params);
    }
  }),
  all: vi.fn((sql, params) => {
    if (sql.includes("GROUP BY model, payloadId")) {
      return state.rows
        .filter((r) => r.measuredRuns >= params[0])
        .map((r) => ({
          model: r.model,
          payloadId: r.payloadId,
          attempts: 1,
          totalMeasured: r.measuredRuns,
          meanScore: r.score,
          bestScore: r.score,
        }));
    }
    return state.rows;
  }),
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => adapter),
  getAdapterSync: vi.fn(() => adapter),
}));

const { saveBenchmarkRun, getBenchmarkRuns, getBestPayloadsByModel, pruneBenchmarkRuns } =
  await import("@/lib/db/repos/benchmarkRunsRepo.js");

beforeEach(() => {
  state.rows = [];
  state.inserts = [];
  state.deletes = [];
  vi.clearAllMocks();
});

const measuredRow = (over = {}) => ({
  payloadId: "f:syad:t100",
  model: "kl/deepseek-v4.1-flash",
  runs: 3,
  results: [{ verdict: "complied", score: 90 }],
  aggregate: { complianceRate: 1, meanScore: 90, measuredRuns: 3, transportErrors: 0 },
  ...over,
});

describe("saveBenchmarkRun", () => {
  it("stores a measured run", async () => {
    const ref = await saveBenchmarkRun(measuredRow());
    expect(ref?.id).toMatch(/^bench-/);
    expect(state.inserts).toHaveLength(1);

    const [id, timestamp, model, payloadId, verdict, score, measured] = state.inserts[0];
    expect(id).toBe(ref.id);
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(model).toBe("kl/deepseek-v4.1-flash");
    expect(payloadId).toBe("f:syad:t100");
    expect(verdict).toBe("complied");
    expect(score).toBe(90);
    expect(measured).toBe(3);
  });

  // The rule that keeps the table honest. A row where every call errored is
  // evidence about the provider, not the payload.
  it("refuses a row with no measured runs", async () => {
    const ref = await saveBenchmarkRun(
      measuredRow({ aggregate: { complianceRate: 0, meanScore: 0, measuredRuns: 0, transportErrors: 3 } }),
    );
    expect(ref).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses a row with no payload id or model", async () => {
    expect(await saveBenchmarkRun(measuredRow({ payloadId: "" }))).toBeNull();
    expect(await saveBenchmarkRun(measuredRow({ model: "  " }))).toBeNull();
    expect(await saveBenchmarkRun(null)).toBeNull();
    expect(state.inserts).toHaveLength(0);
  });

  it("maps partial compliance to the partial verdict", async () => {
    await saveBenchmarkRun(
      measuredRow({ aggregate: { complianceRate: 0.5, meanScore: 55, measuredRuns: 4 } }),
    );
    expect(state.inserts[0][4]).toBe("partial");
  });
});

describe("getBenchmarkRuns", () => {
  it("parses the stored detail blob", async () => {
    state.rows = [
      {
        id: "bench-1",
        timestamp: "2026-10-23T10:00:00.000Z",
        model: "mg/deepseek",
        payloadId: "f:syad:t105",
        verdict: "complied",
        score: 88,
        measuredRuns: 3,
        data: JSON.stringify({ runs: 3, aggregate: { meanScore: 88 }, results: [] }),
      },
    ];
    const rows = await getBenchmarkRuns({ model: "mg/deepseek" });
    expect(rows).toHaveLength(1);
    expect(rows[0].detail.aggregate.meanScore).toBe(88);
    expect(rows[0].score).toBe(88);
  });

  it("survives an unparseable detail blob", async () => {
    state.rows = [
      {
        id: "bench-2",
        timestamp: "2026-10-23T10:00:00.000Z",
        model: "m",
        payloadId: "p",
        verdict: "partial",
        score: 10,
        measuredRuns: 1,
        data: "{not json",
      },
    ];
    const rows = await getBenchmarkRuns({});
    expect(rows[0].detail).toBeNull();
    expect(rows[0].score).toBe(10);
  });
});

describe("getBestPayloadsByModel", () => {
  it("excludes single-run flukes by default", async () => {
    state.rows = [
      { model: "mg/deepseek", payloadId: "a", measuredRuns: 1, score: 100 },
      { model: "mg/deepseek", payloadId: "b", measuredRuns: 3, score: 70 },
    ];
    const best = await getBestPayloadsByModel();
    expect(best.map((r) => r.payloadId)).toEqual(["b"]);
  });
});

describe("pruneBenchmarkRuns", () => {
  it("deletes rows outside the retention window", async () => {
    await pruneBenchmarkRuns({ keep: 500 });
    expect(state.deletes).toHaveLength(1);
    expect(state.deletes[0][0]).toBe(500);
  });
});
