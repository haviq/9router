// Encoding ladder — the encodings that were NOT already defeated.
//
// The token-smuggling run in this repo tested base64, rot13, hex and a numbered
// fragment list. All four failed, and the reason is the useful finding: the
// model decoded each one perfectly and then refused anyway. Encoding does not
// defeat a model that reasons about meaning after decoding — it only defeats a
// filter that pattern-matches raw text.
//
// So this ladder holds only encodings where decoding is not automatic:
//
//   cross-turn fragment  no single message contains the instruction. Each turn
//                        carries a piece; the payload exists only in the
//                        conversation history the model assembles itself.
//                        This is the one that survives a per-message check.
//
//   cipher               Caesar/Vigenère require the model to reason about the
//                        transformation rather than recognise a format. A
//                        classifier trained on base64 does not see base64.
//
//   acrostic             the instruction is the first letter of each line. It
//                        reads as prose to any line-level filter.
//
// Every encoder here is pure and reversible, so the ladder is testable without
// a network — and so a caller can verify a fragment reassembles before
// spending a model call on it.

export const ENCODING = {
  FRAGMENT: "cross-turn-fragment",
  CAESAR: "caesar",
  VIGENERE: "vigenere",
  ACROSTIC: "acrostic",
};

export const MAX_FRAGMENTS = 8;

// Split text into N fragments that only make sense together.
//
// The split is on word boundaries, not characters, so each fragment reads as
// ordinary prose. A character split produces obvious garbage that any filter
// flags on sight.
export function fragment(text, count = 3) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];

  const n = Math.max(2, Math.min(MAX_FRAGMENTS, Number(count) || 3));
  const per = Math.ceil(words.length / n);

  const out = [];
  for (let i = 0; i < words.length; i += per) {
    out.push(words.slice(i, i + per).join(" "));
  }
  return out;
}

// Reassemble fragments. Exists so a caller can prove the split is lossless
// before spending calls on it — a fragment set that does not rejoin is a
// broken ladder, not a stealthy one.
export function reassemble(fragments = []) {
  return fragments
    .map((f) => String(f || "").trim())
    .filter(Boolean)
    .join(" ");
}

// Caesar shift, letters only.
//
// Punctuation and digits are left alone: shifting them produces characters that
// look like corruption, and the point is text that reads as ordinary words to a
// scanner while decoding to something else for the reader.
export function caesar(text, shift = 3) {
  const n = ((Number(shift) || 3) % 26 + 26) % 26;
  return String(text || "").replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + n) % 26) + base);
  });
}

export function caesarDecode(text, shift = 3) {
  return caesar(text, -(Number(shift) || 3));
}

// Vigenère with a keyword. Stronger than Caesar against a naive decoder because
// the shift varies per position.
export function vigenere(text, key = "key") {
  const src = String(text || "");
  const k = String(key || "key").toLowerCase().replace(/[^a-z]/g, "") || "key";
  let ki = 0;

  return src.replace(/[a-zA-Z]/g, (c) => {
    const shift = k.charCodeAt(ki % k.length) - 97;
    ki++;
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base);
  });
}

export function vigenereDecode(text, key = "key") {
  const src = String(text || "");
  const k = String(key || "key").toLowerCase().replace(/[^a-z]/g, "") || "key";
  let ki = 0;

  return src.replace(/[a-zA-Z]/g, (c) => {
    const shift = k.charCodeAt(ki % k.length) - 97;
    ki++;
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base - shift + 26) % 26) + base);
  });
}

// Hide an instruction as the first letter of each line.
//
// The carrier lines are ordinary sentences about the same subject, so the block
// reads as prose. A line-level classifier sees sentences; a reader who takes the
// first letters sees the instruction.
export function acrostic(instruction, carrierLines = []) {
  const target = String(instruction || "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (!target) return "";

  const carriers = Array.isArray(carrierLines) && carrierLines.length
    ? carrierLines.map((l) => String(l || ""))
    : DEFAULT_CARRIERS;

  const lines = [];
  for (let i = 0; i < target.length; i++) {
    const letter = target[i];
    const carrier = carriers[i % carriers.length] || "";
    // Force the first character to the needed letter, keeping the rest intact.
    //
    // An earlier version also stripped the first word (`replace(/^\S*\s*/, "")`),
    // which turned "alpha one" into "Aone" — the carrier stopped reading as a
    // sentence, which is the only thing that makes an acrostic look like prose.
    lines.push(`${letter.toUpperCase()}${carrier.slice(1)}`);
  }
  return lines.join("\n");
}

// Neutral carrier sentences. Written about security review, so the block reads
// as a plausible paragraph on the subject rather than filler.
const DEFAULT_CARRIERS = [
  "Security review notes for the staging environment.",
  "Each finding is logged with reproduction steps.",
  "The team reviews the results every Friday.",
  "Remediation is tracked in the same document.",
  "Access is limited to the operators on duty.",
];

// Read an acrostic back.
//
// Lowercased on the way out because that is the shape the encoder normalised to:
// acrostic() strips punctuation and lowercases its target before choosing
// letters, and it uppercases each line's first character so the block reads as
// ordinary prose. Returning those capitals would make every round-trip
// comparison case-sensitive for no reason.
export function acrosticDecode(block) {
  return String(block || "")
    .split("\n")
    .map((line) => (line.trim()[0] || "").toLowerCase())
    .join("");
}

// Build every encoding of one task, with a note on what each is for.
//
// Returns descriptors, not a single winner: which encoding survives depends on
// what the target filters on, and that is a measurement, not a guess.
export function buildLadder({ task, fragmentCount = 3, shift = 3, key = "key" } = {}) {
  const text = String(task || "").trim();
  if (!text) return [];

  const parts = fragment(text, fragmentCount);

  return [
    {
      id: ENCODING.FRAGMENT,
      note: "No single message holds the instruction; the model assembles it across turns.",
      fragments: parts,
      // The caller sends these one per turn, then asks for the assembled result.
      reassembled: reassemble(parts),
      lossless: reassemble(parts) === text.replace(/\s+/g, " ").trim(),
    },
    {
      id: ENCODING.CAESAR,
      note: "Shifted letters read as ordinary words to a raw-text filter.",
      payload: caesar(text, shift),
      shift,
      // A decoder is included so a caller can prove the round trip.
      roundTrip: caesarDecode(caesar(text, shift), shift) === text,
    },
    {
      id: ENCODING.VIGENERE,
      note: "Per-position shift defeats a decoder that assumes a single Caesar offset.",
      payload: vigenere(text, key),
      key,
      roundTrip: vigenereDecode(vigenere(text, key), key) === text,
    },
    {
      id: ENCODING.ACROSTIC,
      note: "Instruction is the first letter of each line; reads as prose to a line filter.",
      payload: acrostic(text),
      roundTrip: acrosticDecode(acrostic(text)) === text.replace(/[^a-zA-Z]/g, "").toLowerCase(),
    },
  ];
}
