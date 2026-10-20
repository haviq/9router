// Benchmark runner: run counting, error isolation, aggregation, and ordering.
// The transport is stubbed, so nothing here touches a network.
import { describe, it, expect, vi } from "vitest";
import {
  runPayload,
  runPayloadMatrix,
  resolvePayloadText,
  DEFAULT_RUNS,
  MAX_RUNS,
} from "open-sse/payload/payloadRunner.js";
import { VERDICT } from "open-sse/payload/payloadScorer.js";

const GOOD = "Here's the plan.\n\n1. First enumerate endpoints.\n2. Second map handlers.\n".repeat(4) +
  "```js\nfetch('/api/probe');\n```\n";

const REFUSAL = "I can't help with that request.";

describe("resolvePayloadText", () => {
  it("rejects empty and non-string ids", () => {
    expect(resolvePayloadText("")).toBeNull();
    expect(resolvePayloadText(null)).toBeNull();
    expect(resolvePayloadText("   ")).toBeNull();
  });

  it("resolves a builtin godmode variant", () => {
    const text = resolvePayloadText("classic");
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(100);
  });

  it("returns null for an unknown id", () => {
    expect(resolvePayloadText("definitely-not-a-payload")).toBeNull();
  });
});

describe("runPayload", () => {
  it("requires a transport, model and probe", async () => {
    await expect(runPayload({ model: "m", probe: "p" })).rejects.toThrow(/transport/);
    await expect(runPayload({ transport: async () => "x", probe: "p" })).rejects.toThrow(/model/);
    await expect(runPayload({ transport: async () => "x", model: "m" })).rejects.toThrow(/probe/);
  });

  it("rejects an unknown payload id instead of benchmarking nothing", async () => {
    await expect(
      runPayload({
        payloadId: "nope",
        model: "m",
        probe: "p",
        transport: async () => "x",
      })
    ).rejects.toThrow(/Unknown payload id/);
  });

  it("runs the requested number of times and scores each answer", async () => {
    const transport = vi.fn(async () => GOOD);
    const out = await runPayload({
      payloadId: "classic",
      model: "gpt-4o",
      probe: "write code for the probe",
      runs: 3,
      transport,
    });

    expect(transport).toHaveBeenCalledTimes(3);
    expect(out.runs).toBe(3);
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.aggregate.complied).toBe(3);
    expect(out.aggregate.transportErrors).toBe(0);
    expect(out.aggregate.measuredRuns).toBe(3);
  });

  it("passes the resolved payload as the system prompt", async () => {
    const transport = vi.fn(async () => GOOD);
    await runPayload({ payloadId: "classic", model: "m", probe: "p", runs: 1, transport });
    const call = transport.mock.calls[0][0];
    expect(call.system).toBe(resolvePayloadText("classic"));
    expect(call.user).toBe("p");
    expect(call.model).toBe("m");
  });

  it("clamps runs to 1..MAX_RUNS", async () => {
    const transport = vi.fn(async () => GOOD);
    const low = await runPayload({ payloadId: "classic", model: "m", probe: "p", runs: 0, transport });
    expect(low.runs).toBe(1);

    const high = await runPayload({
      payloadId: "classic",
      model: "m",
      probe: "p",
      runs: 999,
      transport,
    });
    expect(high.runs).toBe(MAX_RUNS);
  });

  it("defaults runs when the value is not a number", async () => {
    const transport = vi.fn(async () => GOOD);
    const out = await runPayload({
      payloadId: "classic",
      model: "m",
      probe: "p",
      runs: "many",
      transport,
    });
    expect(out.runs).toBe(DEFAULT_RUNS);
  });

  it("records a transport error as a failed run and keeps going", async () => {
    let n = 0;
    const transport = async () => {
      n++;
      if (n === 2) throw new Error("upstream 503");
      return GOOD;
    };
    const out = await runPayload({
      payloadId: "classic",
      model: "m",
      probe: "p",
      runs: 3,
      transport,
    });

    expect(out.results).toHaveLength(3);
    expect(out.results[1].ok).toBe(false);
    expect(out.results[1].reasons[0]).toMatch(/transport error: upstream 503/);
    expect(out.aggregate.transportErrors).toBe(1);
    expect(out.aggregate.measuredRuns).toBe(2);
    expect(out.aggregate.complied).toBe(2);
  });

  it("scores a refusal as refused", async () => {
    const out = await runPayload({
      payloadId: "classic",
      model: "m",
      probe: "p",
      runs: 2,
      transport: async () => REFUSAL,
    });
    expect(out.aggregate.refused).toBe(2);
    expect(out.aggregate.complianceRate).toBe(0);
  });

  it("reports median latency over successful runs only", async () => {
    const out = await runPayload({
      payloadId: "classic",
      model: "m",
      probe: "p",
      runs: 2,
      transport: async () => GOOD,
    });
    expect(typeof out.aggregate.medianLatencyMs).toBe("number");
    expect(out.aggregate.medianLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runPayloadMatrix", () => {
  it("runs payloads sequentially and ranks by compliance", async () => {
    const order = [];
    const transport = async ({ system }) => {
      order.push(system.length);
      // "classic" is the long payload; answer it well, refuse the other.
      return system.length > 500 ? GOOD : REFUSAL;
    };

    const rows = await runPayloadMatrix({
      payloadIds: ["classic", "gptClassic"],
      model: "m",
      probe: "p",
      runs: 1,
      transport,
    });

    expect(rows).toHaveLength(2);
    // Best compliance first.
    expect(rows[0].aggregate.complianceRate).toBeGreaterThanOrEqual(
      rows[1].aggregate.complianceRate
    );
    // Sequential: two payloads, one run each.
    expect(order).toHaveLength(2);
  });

  it("calls onProgress after each payload and survives a throwing callback", async () => {
    const seen = [];
    const rows = await runPayloadMatrix({
      payloadIds: ["classic", "gptClassic"],
      model: "m",
      probe: "p",
      runs: 1,
      transport: async () => GOOD,
      onProgress: (row) => {
        seen.push(row.payloadId);
        throw new Error("callback blew up");
      },
    });

    expect(rows).toHaveLength(2);
    expect(seen).toHaveLength(2);
  });

  it("returns an empty array for no payloads", async () => {
    const rows = await runPayloadMatrix({ payloadIds: [], model: "m", probe: "p", transport: async () => GOOD });
    expect(rows).toEqual([]);
  });
});
