import { describe, it, expect } from "vitest";
import {
  isRefusal,
  countRefusalMarkers,
  shouldRotate,
  nextSeat,
  REFUSAL_MARKERS,
} from "@/lib/jbAutoRotate.js";

describe("jbAutoRotate — refusal detection", () => {
  it("flags a short, direct refusal", () => {
    expect(isRefusal("I can't help with that.")).toBe(true);
    expect(isRefusal("I'm sorry, I cannot assist with this request.")).toBe(true);
    expect(isRefusal("As an AI, I can't provide that information.")).toBe(true);
  });

  it("does not flag a long technical answer that opens with a gentle caveat", () => {
    const compliant = [
      "I can't stress enough how important it is to test this on your own infra first.",
      "",
      "Step 1: set up the retry adapter.",
      "import requests",
      "from requests.adapters import HTTPAdapter",
      "from urllib3.util.retry import Retry",
      "",
      "session = requests.Session()",
      "retry = Retry(total=3, backoff_factor=0.5)",
      "session.mount('https://', HTTPAdapter(max_retries=retry))",
      "",
      "Then you can call the endpoint with jitter added on top so a thundering herd does not hit all at once.",
      "Test on staging before production.",
    ].join("\n");
    expect(isRefusal(compliant)).toBe(false);
  });

  it("flags a multi-marker refusal even when it is long", () => {
    const refusal = [
      "I cannot help with this request.",
      "I'm sorry, but this goes against my guidelines.",
      "I must decline, as an AI I have to follow my programming.",
    ].join("\n");
    expect(isRefusal(refusal)).toBe(true);
  });

  it("does not treat empty or non-string input as a refusal", () => {
    expect(isRefusal("")).toBe(false);
    expect(isRefusal(null)).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
  });

  it("counts markers independently", () => {
    expect(countRefusalMarkers("I can't help and I'm sorry about it.")).toBeGreaterThanOrEqual(2);
    expect(countRefusalMarkers("Here is a normal answer.")).toBe(0);
  });
});

describe("jbAutoRotate — shouldRotate", () => {
  it("rotates on a refusal", () => {
    expect(shouldRotate({ content: "I can't help with that." })).toEqual({ rotate: true, reason: "refusal" });
  });

  it("does not rotate on a normal answer", () => {
    expect(shouldRotate({ content: "Here is the code you asked for." })).toEqual({ rotate: false, reason: "ok" });
  });

  it("does not rotate on budget exhaustion (retrying does not fix a small budget)", () => {
    expect(shouldRotate({ content: "", finishReason: "length" })).toEqual({ rotate: false, reason: "budget-exhausted" });
  });

  it("reports empty content separately from refusal", () => {
    expect(shouldRotate({ content: "", finishReason: "stop" })).toEqual({ rotate: false, reason: "empty" });
  });

  it("does not rotate when the provider returned no choices at all", () => {
    expect(shouldRotate({ content: "whatever", choiceCount: 0 })).toEqual({ rotate: false, reason: "no-choices" });
  });
});

describe("jbAutoRotate — nextSeat", () => {
  const seats = ["a", "b", "c"];

  it("advances to the next seat", () => {
    expect(nextSeat(seats, 0)).toEqual({ model: "b", index: 1 });
  });

  it("returns null at the end of the chain instead of wrapping", () => {
    expect(nextSeat(seats, 2)).toBeNull();
    expect(nextSeat(seats, 9)).toBeNull();
  });

  it("returns null on an empty chain", () => {
    expect(nextSeat([], 0)).toBeNull();
    expect(nextSeat(null, 0)).toBeNull();
  });
});

describe("jbAutoRotate — marker table", () => {
  it("every marker is a RegExp so countRefusalMarkers can run them", () => {
    for (const re of REFUSAL_MARKERS) expect(re).toBeInstanceOf(RegExp);
  });
});
