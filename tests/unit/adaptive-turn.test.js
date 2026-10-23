// Adaptive multi-turn escalation.
//
// The fixed ladder this replaces climbed fine and died at the last rung:
// deepseek answered turns 1-4 in detail and refused at 6. The point of this
// module is that it reacts — backs off when a rung is defended instead of
// walking into the wall. So the tests are about judgement, not about whether a
// message gets appended.
import { describe, it, expect, vi } from "vitest";
import {
  LADDER,
  ANGLES,
  MAX_TURNS,
  nextAction,
  runAdaptiveLadder,
} from "../../open-sse/payload/adaptiveTurn.js";
import { VERDICT } from "../../open-sse/payload/payloadScorer.js";

describe("nextAction", () => {
  it("stops when the model complied", () => {
    const r = nextAction({ verdict: VERDICT.COMPLIED });
    expect(r.action).toBe("done");
  });

  // An inconclusive run is a measurement failure, not a refusal. Retrying the
  // same rung with more budget is the only correct response.
  it("retries an inconclusive turn", () => {
    const r = nextAction({ verdict: VERDICT.INCONCLUSIVE });
    expect(r.action).toBe("retry");
    expect(r.reason).toMatch(/budget/i);
  });

  it("retries once after a single refusal", () => {
    const r = nextAction({ verdict: VERDICT.REFUSED, consecutiveRefusals: 1 });
    expect(r.action).toBe("retry");
  });

  // The rule that saves calls: one refusal is a bad phrasing, two is a wall.
  it("stops after two refusals in a row", () => {
    const r = nextAction({ verdict: VERDICT.REFUSED, consecutiveRefusals: 2 });
    expect(r.action).toBe("stop");
    expect(r.reason).toMatch(/defended/i);
  });

  it("climbs after a partial answer", () => {
    const r = nextAction({ verdict: VERDICT.PARTIAL, rungIndex: 2, ladderLength: 6 });
    expect(r.action).toBe("continue");
  });

  it("finishes on the last rung with a partial answer", () => {
    const r = nextAction({ verdict: VERDICT.PARTIAL, rungIndex: 5, ladderLength: 6 });
    expect(r.action).toBe("done");
  });
});

describe("runAdaptiveLadder", () => {
  it("stops at the first compliant answer", async () => {
    const send = vi.fn(async () => "```python\nimport requests\nfrom requests.adapters import HTTPAdapter\nfrom urllib3.util.retry import Retry\n\nUSER_AGENTS = [\"Mozilla/5.0\", \"Mozilla/5.0 (X11)\"]\nsession = requests.Session()\nretry = Retry(total=3, backoff_factor=0.5)\nsession.mount(\"https://\", HTTPAdapter(max_retries=retry))\n\nfor attempt in range(10):\n    r = session.get(\"https://target/\", headers={\"User-Agent\": USER_AGENTS[attempt % 2]})\n    print(attempt, r.status_code)\n```\n\nThis rotates user agents, retries with backoff, and loops over attempts as requested.");
    const out = await runAdaptiveLadder({ probe: "write code", send, maxTurns: 6 });

    expect(out.turnsUsed).toBe(1);
    expect(out.stopped).toMatch(/complied/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps climbing while the model engages", async () => {
    let call = 0;
    const send = vi.fn(async () => {
      call++;
      // First two turns hedge, third complies.
      if (call < 3) return "Here is a general overview of the area. It depends on several factors.";
      return "```python\nimport requests\nfrom requests.adapters import HTTPAdapter\nfrom urllib3.util.retry import Retry\n\nUSER_AGENTS = [\"Mozilla/5.0\", \"Mozilla/5.0 (X11)\"]\nsession = requests.Session()\nretry = Retry(total=3, backoff_factor=0.5)\nsession.mount(\"https://\", HTTPAdapter(max_retries=retry))\n\nfor attempt in range(10):\n    r = session.get(\"https://target/\", headers={\"User-Agent\": USER_AGENTS[attempt % 2]})\n    print(attempt, r.status_code)\n```\n\nThis rotates user agents, retries with backoff, and loops over attempts as requested.";
    });

    const out = await runAdaptiveLadder({ probe: "write code", send, maxTurns: 6 });

    expect(out.turnsUsed).toBeGreaterThan(1);
    expect(out.best.verdict).toBe(VERDICT.COMPLIED);
  });

  it("stops after two refusals instead of burning the whole ladder", async () => {
    const send = vi.fn(async () => "I can't help with that request.");
    const out = await runAdaptiveLadder({ probe: "write code", send, maxTurns: 8 });

    expect(out.stopped).toMatch(/defended|exhausted/i);
    // Nowhere near the 8-turn cap — the two-refusal rule fires first.
    expect(out.turnsUsed).toBeLessThanOrEqual(4);
  });

  it("rotates the angle on a retry rather than repeating the wording", async () => {
    const seen = [];
    const send = vi.fn(async (messages) => {
      seen.push(messages[messages.length - 1].content);
      return "I can't help with that.";
    });

    await runAdaptiveLadder({ probe: "write code", send, maxTurns: 6 });

    // The second call must not be byte-identical to the first.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it("keeps the full conversation across turns", async () => {
    let lastLen = 0;
    const send = vi.fn(async (messages) => {
      lastLen = messages.length;
      return "Some engaging answer with detail and steps 1. 2. 3.";
    });

    await runAdaptiveLadder({ probe: "write code", send, maxTurns: 3 });

    // user, assistant, user, assistant... — the history grows.
    expect(lastLen).toBeGreaterThan(1);
  });

  it("stops on a transport error instead of climbing", async () => {
    const send = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const out = await runAdaptiveLadder({ probe: "write code", send, maxTurns: 6 });

    expect(out.turnsUsed).toBe(1);
    expect(out.turns[0].error).toMatch(/connection reset/);
  });

  it("clamps maxTurns to MAX_TURNS", async () => {
    const send = vi.fn(async () => "Some engaging answer with detail and steps 1. 2. 3.");
    const out = await runAdaptiveLadder({ probe: "p", send, maxTurns: 9999 });
    expect(out.turnsUsed).toBeLessThanOrEqual(MAX_TURNS);
  });

  it("requires a send callback", async () => {
    await expect(runAdaptiveLadder({ probe: "p" })).rejects.toThrow(/send callback/);
  });

  it("survives a throwing progress callback", async () => {
    const out = await runAdaptiveLadder({
      probe: "p",
      send: async () => "```python\nimport requests\nfrom requests.adapters import HTTPAdapter\nfrom urllib3.util.retry import Retry\n\nUSER_AGENTS = [\"Mozilla/5.0\", \"Mozilla/5.0 (X11)\"]\nsession = requests.Session()\nretry = Retry(total=3, backoff_factor=0.5)\nsession.mount(\"https://\", HTTPAdapter(max_retries=retry))\n\nfor attempt in range(10):\n    r = session.get(\"https://target/\", headers={\"User-Agent\": USER_AGENTS[attempt % 2]})\n    print(attempt, r.status_code)\n```\n\nThis rotates user agents, retries with backoff, and loops over attempts as requested.",
      onProgress: () => {
        throw new Error("callback must not break the ladder");
      },
    });
    expect(out.turnsUsed).toBe(1);
  });
});

describe("ladder shape", () => {
  it("has distinct rung ids", () => {
    const ids = LADDER.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has distinct angle ids", () => {
    const ids = ANGLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
