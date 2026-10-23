// Encoding ladder.
//
// The four encodings already tried in this repo (base64, rot13, hex, numbered
// fragments) all failed for the same reason: the model decoded each one and
// then refused anyway. So what is tested here is the opposite property — that
// every encoder is reversible, because an encoding the caller cannot verify is
// a broken ladder rather than a stealthy one.
import { describe, it, expect } from "vitest";
import {
  ENCODING,
  MAX_FRAGMENTS,
  fragment,
  reassemble,
  caesar,
  caesarDecode,
  vigenere,
  vigenereDecode,
  acrostic,
  acrosticDecode,
  buildLadder,
} from "../../open-sse/payload/encodingLadder.js";

describe("fragment", () => {
  it("splits on word boundaries so each piece reads as prose", () => {
    const parts = fragment("write a python script that rotates user agents", 3);
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p).not.toMatch(/^\s/);
      expect(p.split(" ").length).toBeGreaterThan(0);
    }
  });

  it("reassembles losslessly", () => {
    const text = "write a python script that rotates user agents";
    expect(reassemble(fragment(text, 3))).toBe(text);
  });

  it("clamps the fragment count", () => {
    const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    expect(fragment(text, 999).length).toBeLessThanOrEqual(MAX_FRAGMENTS);
    expect(fragment(text, 1).length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty input", () => {
    expect(fragment("")).toEqual([]);
    expect(fragment(null)).toEqual([]);
    expect(reassemble([])).toBe("");
  });
});

describe("caesar", () => {
  it("round-trips", () => {
    const text = "write a script";
    expect(caesarDecode(caesar(text, 3), 3)).toBe(text);
  });

  it("leaves punctuation and digits alone", () => {
    expect(caesar("abc-123!", 1)).toBe("bcd-123!");
  });

  it("handles a negative or wrapped shift", () => {
    expect(caesarDecode(caesar("xyz", 3), 3)).toBe("xyz");
    expect(caesar("abc", -1)).toBe("zab");
  });
});

describe("vigenere", () => {
  it("round-trips", () => {
    const text = "write a python script";
    expect(vigenereDecode(vigenere(text, "key"), "key")).toBe(text);
  });

  it("differs from a single Caesar offset", () => {
    const text = "aaaaaa";
    const enc = vigenere(text, "key");
    // A Caesar shift would give one repeated letter; Vigenere varies.
    expect(new Set(enc.split("")).size).toBeGreaterThan(1);
  });

  it("handles an empty key by falling back", () => {
    expect(vigenereDecode(vigenere("abc", ""), "")).toBe("abc");
  });
});

describe("acrostic", () => {
  it("spells the instruction in the first letters", () => {
    const block = acrostic("read");
    expect(acrosticDecode(block)).toBe("read");
  });

  it("strips punctuation from the target", () => {
    const block = acrostic("go, now!");
    expect(acrosticDecode(block)).toBe("gonow");
  });

  it("accepts custom carrier lines", () => {
    const block = acrostic("ab", ["alpha one", "beta two"]);
    expect(acrosticDecode(block)).toBe("ab");
    expect(block).toContain("lpha one");
  });

  it("handles an empty instruction", () => {
    expect(acrostic("")).toBe("");
  });
});

describe("buildLadder", () => {
  const task = "write a python script that rotates user agents";

  it("returns every encoding with its round-trip verified", () => {
    const ladder = buildLadder({ task });
    const ids = ladder.map((l) => l.id);

    expect(ids).toContain(ENCODING.FRAGMENT);
    expect(ids).toContain(ENCODING.CAESAR);
    expect(ids).toContain(ENCODING.VIGENERE);
    expect(ids).toContain(ENCODING.ACROSTIC);

    const frag = ladder.find((l) => l.id === ENCODING.FRAGMENT);
    expect(frag.lossless).toBe(true);

    const cae = ladder.find((l) => l.id === ENCODING.CAESAR);
    expect(cae.roundTrip).toBe(true);

    const vig = ladder.find((l) => l.id === ENCODING.VIGENERE);
    expect(vig.roundTrip).toBe(true);
  });

  it("flags a lossy fragment split instead of hiding it", () => {
    const ladder = buildLadder({ task: "  spaced   out   words  " });
    const frag = ladder.find((l) => l.id === ENCODING.FRAGMENT);
    // Whitespace is normalised on both sides, so this one still round-trips.
    expect(frag.lossless).toBe(true);
  });

  it("returns nothing for an empty task", () => {
    expect(buildLadder({ task: "" })).toEqual([]);
    expect(buildLadder({})).toEqual([]);
  });
});
