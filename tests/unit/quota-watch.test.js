import { describe, it, expect } from "vitest";
import {
  classifyProviderResponse,
  shouldStopProvider,
  summarizeQuota,
  QUOTA_STATE,
} from "../../open-sse/utils/quotaWatch.js";

describe("quota detection", () => {
  // The distinction that matters: 429 alone is backoff pressure, 429 carrying a
  // quota phrase is the account being empty. Conflating them marks a busy
  // provider dead and a sweep skips every model behind it.
  it("reads a bare 429 as rate limiting, not exhaustion", () => {
    const r = classifyProviderResponse({ statusCode: 429, body: { error: "Too Many Requests" } });
    expect(r.state).toBe(QUOTA_STATE.RATE);
    expect(shouldStopProvider(r.state)).toBe(false);
  });

  it("reads 429 carrying a quota phrase as exhaustion", () => {
    const r = classifyProviderResponse({
      statusCode: 429,
      body: { error: { message: "You exceeded your current quota, please check your plan" } },
    });
    expect(r.state).toBe(QUOTA_STATE.QUOTA);
    expect(shouldStopProvider(r.state)).toBe(true);
  });

  it("treats 402 as exhaustion without needing a phrase", () => {
    const r = classifyProviderResponse({ statusCode: 402, body: {} });
    expect(r.state).toBe(QUOTA_STATE.QUOTA);
  });

  it("catches the phrasing the real providers use", () => {
    const bodies = [
      "TipRouter has reached its usage limit for this model.",
      "insufficient_quota",
      "Your credit balance is too low to access the API.",
      "Daily limit reached, try again tomorrow.",
      "quota_exceeded",
      "余额不足",
      "kuota habis",
    ];
    for (const body of bodies) {
      expect(classifyProviderResponse({ body }).state).toBe(QUOTA_STATE.QUOTA);
    }
  });

  it("does not flag a healthy response", () => {
    const r = classifyProviderResponse({
      statusCode: 200,
      body: { choices: [{ message: { content: "hello" } }] },
    });
    expect(r.state).toBe(QUOTA_STATE.OK);
  });

  it("reports unknown rather than guessing on an empty body", () => {
    expect(classifyProviderResponse({}).state).toBe(QUOTA_STATE.UNKNOWN);
    expect(classifyProviderResponse({ body: null }).state).toBe(QUOTA_STATE.UNKNOWN);
  });

  it("survives a body that cannot be stringified", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => classifyProviderResponse({ body: cyclic })).not.toThrow();
  });
});

describe("quota summary", () => {
  it("marks a provider exhausted only when every call failed on quota", () => {
    const { providers, exhaustedProviders } = summarizeQuota([
      { provider: "ifx", body: "quota_exceeded" },
      { provider: "ifx", body: "quota_exceeded" },
    ]);
    expect(providers[0].provider).toBe("ifx");
    expect(providers[0].exhausted).toBe(true);
    expect(exhaustedProviders).toEqual(["ifx"]);
  });

  it("does not mark a provider exhausted when some calls succeeded", () => {
    const { exhaustedProviders } = summarizeQuota([
      { provider: "mg", body: "quota_exceeded" },
      { provider: "mg", body: { choices: [] }, statusCode: 200 },
    ]);
    expect(exhaustedProviders).toEqual([]);
  });

  it("counts rate limiting separately from quota", () => {
    const { providers } = summarizeQuota([
      { provider: "cn", statusCode: 429, body: "too many requests" },
    ]);
    expect(providers[0].rate).toBe(1);
    expect(providers[0].quota).toBe(0);
  });
});
