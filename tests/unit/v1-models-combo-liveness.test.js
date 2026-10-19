// /v1/models must never advertise a model a client cannot reach.
//
// A combo has no connection of its own — it is a stored list of model ids.
// Switching every provider a combo depends on off must therefore drop the
// combo from the listing, or clients pick it and hard-fail at request time.
// Nested combos resolve recursively with cycle protection.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

function conn(provider, extra = {}) {
  return { id: 1, provider, isActive: true, providerSpecificData: {}, ...extra };
}

async function listWith(connections, combos) {
  db.getProviderConnections.mockResolvedValue(connections);
  db.getCombos.mockResolvedValue(combos);
  setCatalogSource(null);
  return buildModelsList(["llm"]);
}

beforeEach(() => {
  vi.clearAllMocks();
  setCatalogSource(null);
});

describe("/v1/models combo liveness", () => {
  it("drops a combo whose only provider is switched off", async () => {
    const models = await listWith(
      [conn("deepseek", { isActive: false })],
      [{ name: "dead-combo", models: ["ds/deepseek-chat"] }],
    );
    expect(models.find((m) => m.id === "dead-combo")).toBeUndefined();
  });

  it("keeps a combo whose provider is live", async () => {
    const models = await listWith(
      [conn("deepseek")],
      [{ name: "live-combo", models: ["ds/deepseek-chat"] }],
    );
    expect(models.find((m) => m.id === "live-combo")).toBeDefined();
  });

  it("keeps a combo when at least one member is reachable", async () => {
    const models = await listWith(
      [conn("deepseek")],
      [{ name: "mixed-combo", models: ["ghost/nonexistent", "ds/deepseek-chat"] }],
    );
    expect(models.find((m) => m.id === "mixed-combo")).toBeDefined();
  });

  it("drops a nested combo whose inner combo is dead", async () => {
    const models = await listWith(
      [conn("deepseek", { isActive: false })],
      [
        { name: "inner-dead", models: ["ds/deepseek-chat"] },
        { name: "outer", models: ["inner-dead"] },
      ],
    );
    expect(models.find((m) => m.id === "inner-dead")).toBeUndefined();
    expect(models.find((m) => m.id === "outer")).toBeUndefined();
  });

  it("keeps a nested combo whose inner combo is live", async () => {
    const models = await listWith(
      [conn("deepseek")],
      [
        { name: "inner-live", models: ["ds/deepseek-chat"] },
        { name: "outer", models: ["inner-live"] },
      ],
    );
    expect(models.find((m) => m.id === "inner-live")).toBeDefined();
    expect(models.find((m) => m.id === "outer")).toBeDefined();
  });

  it("survives a combo cycle without hanging", async () => {
    const models = await listWith(
      [conn("deepseek")],
      [
        { name: "loop-a", models: ["loop-b"] },
        { name: "loop-b", models: ["loop-a"] },
      ],
    );
    // Neither resolves to a live model seat -> both dropped, and we returned.
    expect(models.find((m) => m.id === "loop-a")).toBeUndefined();
    expect(models.find((m) => m.id === "loop-b")).toBeUndefined();
  });

  it("exposes every combo when the DB has no connections at all", async () => {
    // DB unavailable -> no rows to judge liveness by; hide nothing.
    const models = await listWith([], [{ name: "any-combo", models: ["ds/deepseek-chat"] }]);
    expect(models.find((m) => m.id === "any-combo")).toBeDefined();
  });

  it("honours a custom prefix as the combo seat alias", async () => {
    const models = await listWith(
      [conn("deepseek", { providerSpecificData: { prefix: "myprefix" } })],
      [{ name: "prefixed", models: ["myprefix/deepseek-chat"] }],
    );
    expect(models.find((m) => m.id === "prefixed")).toBeDefined();
  });
});
