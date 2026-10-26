import { describe, it, expect, vi, beforeEach } from "vitest";
import { summarizeCost, resolveConfig, DEFAULTS } from "@/lib/costAlert.js";

// The engine resolves pricing through the pricing repo. Tests stub it so a test
// does not depend on which providers happen to have a price on file.
vi.mock("@/lib/db/repos/pricingRepo.js", () => ({
  getPricingForModel: vi.fn(async (provider, model) => {
    if (provider === "priced") return { inputPer1M: 1, outputPer1M: 2 };
    return null;
  }),
}));

// The alert path sends Telegram; the engine must never call the network in a
// test. The notifier is stubbed to a no-op that records the call.
vi.mock("@/lib/notifier.js", () => ({
  notify: vi.fn(async () => ({ sent: true })),
  shouldNotify: vi.fn(() => true),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function row({ provider = "priced", model = "m", input = 1000, output = 500, data } = {}) {
  return {
    provider,
    model,
    data: data ?? { usage: { prompt_tokens: input, completion_tokens: output } },
  };
}

describe("costAlert — summarizeCost", () => {
  it("sums tokens across rows", async () => {
    const s = await summarizeCost([row({ input: 1000, output: 500 }), row({ input: 2000, output: 1000 })]);
    expect(s.totalTokens).toBe(4500);
  });

  it("groups by model", async () => {
    const s = await summarizeCost([
      row({ model: "a", input: 100, output: 0 }),
      row({ model: "b", input: 500, output: 0 }),
      row({ model: "a", input: 200, output: 0 }),
    ]);
    const a = s.models.find((m) => m.model === "a");
    expect(a.requests).toBe(2);
    expect(a.tokens).toBe(300);
  });

  it("skips rows without usable usage data", async () => {
    const s = await summarizeCost([row({ input: 0, output: 0 })]);
    expect(s.totalTokens).toBe(0);
  });

  it("accepts alternate usage field names", async () => {
    const s = await summarizeCost([
      { provider: "priced", model: "m", data: { usage: { input_tokens: 100, output_tokens: 50 } } },
    ]);
    expect(s.totalTokens).toBe(150);
  });

  it("resolves a dollar figure when the model is priced", async () => {
    const s = await summarizeCost([row({ input: 1_000_000, output: 1_000_000 })]);
    // inputPer1M 1 → $1, outputPer1M 2 → $2
    expect(s.pricedModels).toBe(1);
    expect(s.totalUsd).toBeCloseTo(3, 5);
  });

  it("reports unpriced models without inventing a price", async () => {
    const s = await summarizeCost([row({ provider: "unpriced", input: 1000, output: 500 })]);
    expect(s.pricedModels).toBe(0);
    expect(s.unpricedModels).toBe(1);
    expect(s.totalUsd).toBe(0);
    expect(s.totalTokens).toBe(1500);
  });
});

describe("costAlert — resolveConfig", () => {
  it("defaults to disabled", () => {
    const c = resolveConfig({});
    expect(c.enabled).toBe(false);
    expect(c.dailyUsdThreshold).toBe(DEFAULTS.dailyUsdThreshold);
  });

  it("reads threshold override", () => {
    const c = resolveConfig({ costAlertEnabled: true, costAlertDailyThresholdUsd: 25 });
    expect(c.enabled).toBe(true);
    expect(c.dailyUsdThreshold).toBe(25);
  });
});
