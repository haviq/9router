import { describe, it, expect } from "vitest";
import { rollContext, resolveConfig, DEFAULTS } from "@/lib/contextRolling.js";

function msgs(n) {
  return Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
}

describe("contextRolling — gating", () => {
  it("returns the messages untouched when disabled", () => {
    const input = msgs(30);
    const out = rollContext(input, { enabled: false, keepHeadMessages: 1, keepTailMessages: 6, minMessages: 12 });
    expect(out.dropped).toBe(0);
    expect(out.messages).toBe(input);
  });

  it("returns the messages untouched when below the min", () => {
    const input = msgs(8);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 1, keepTailMessages: 6, minMessages: 12 });
    expect(out.dropped).toBe(0);
    expect(out.messages).toBe(input);
  });

  it("does nothing when head + tail already covers the list", () => {
    const input = msgs(15);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 7, keepTailMessages: 8, minMessages: 12 });
    expect(out.dropped).toBe(0);
  });
});

describe("contextRolling — trimming", () => {
  it("keeps the head and the tail, dropping the middle", () => {
    const input = msgs(30);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 2, keepTailMessages: 6, minMessages: 12 });
    expect(out.dropped).toBe(22);
    expect(out.messages.length).toBe(2 + 1 + 6); // head + note + tail
    expect(out.messages[0].content).toBe("m0");
    expect(out.messages[1].content).toBe("m1");
    expect(out.messages[out.messages.length - 1].content).toBe("m29");
  });

  it("places the drop note where the dropped messages were", () => {
    const input = msgs(20);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 1, keepTailMessages: 4, minMessages: 12 });
    const noteIdx = out.messages.findIndex((m) => typeof m.content === "string" && m.content.includes("omitted"));
    expect(noteIdx).toBe(1); // right after the head, not at the end
  });

  it("names the count in the drop note", () => {
    const input = msgs(20);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 1, keepTailMessages: 4, minMessages: 12 });
    const note = out.messages[1].content;
    expect(note).toContain("15");
  });

  it("preserves message order", () => {
    const input = msgs(30);
    const out = rollContext(input, { enabled: true, keepHeadMessages: 2, keepTailMessages: 6, minMessages: 12 });
    const tail = out.messages.slice(-6).map((m) => m.content);
    expect(tail).toEqual(["m24", "m25", "m26", "m27", "m28", "m29"]);
  });
});

describe("contextRolling — resolveConfig", () => {
  it("defaults to disabled when settings are empty", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.keepHeadMessages).toBe(DEFAULTS.keepHeadMessages);
    expect(cfg.keepTailMessages).toBe(DEFAULTS.keepTailMessages);
    expect(cfg.minMessages).toBe(DEFAULTS.minMessages);
  });

  it("reads overrides from settings", () => {
    const cfg = resolveConfig({ contextRollingEnabled: true, contextRollingKeepTail: 10 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.keepTailMessages).toBe(10);
  });
});
