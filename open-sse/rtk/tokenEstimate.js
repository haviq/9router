// Model-aware token-cost estimator for injected steering payloads.
//
// Why an estimate: tokenizers differ per model family. Shipping a real
// tokenizer (tiktoken/HF) on the hot request path is too heavy — native
// bindings, per-family model files, 100MB+ of vocab. Instead we calibrate
// a chars-per-token ratio per family from published tokenizer behaviour
// and correct for script density (CJK/Cyrillic/emoji tokenize far denser
// than Latin prose).
//
// Accuracy: within ~10-15% for English prose, which is the shape of the
// steering payloads this estimates. Good enough for cost gating; the
// result is still labelled "est" wherever it surfaces.
//
// Public API is backward compatible:
//   estimateTokens(text)            -> legacy 4 chars/token
//   estimateTokens(text, model)     -> family-aware
//   formatTok(n)                    -> compact "1.2k"
//   estimateGlobalInjection({...})  -> now accepts `model` per part

// chars-per-token for LATIN script, by family. This is the ratio that
// matters for the English-shaped steering payloads this estimator serves.
// Family vocab size affects Latin density only slightly; CJK density is
// handled separately below (a CJK-tuned vocab like Qwen is still ~4
// chars/token on English prose — its advantage shows up on CJK text).
const LATIN_RATIOS = {
  gpt: 4.0,        // cl100k_base / o200k_base
  claude: 3.5,     // Anthropic tokenizer
  gemini: 4.0,     // SentencePiece, ~4 on English
  llama: 3.6,      // Llama 3 tokenizer
  qwen: 3.9,
  deepseek: 3.7,
  glm: 3.6,
  kimi: 3.7,
  grok: 3.8,
  mistral: 3.8,
  command: 3.9,    // Cohere
  default: 4.0,
};

// chars-per-token for CJK script, by family. CJK-tuned vocabs merge common
// CJK bigrams, so they land ~1.4-1.8 chars/token where Latin-first vocabs
// (GPT/Claude) sit near 1.0-1.2.
const CJK_RATIOS = {
  gpt: 1.1,
  claude: 1.0,
  gemini: 1.2,
  llama: 1.1,
  qwen: 1.7,
  deepseek: 1.5,
  glm: 1.6,
  kimi: 1.6,
  grok: 1.1,
  mistral: 1.1,
  command: 1.1,
  default: 1.1,
};

// Ordered most-specific-first; first match wins.
const FAMILY_PATTERNS = [
  { family: "claude",   pattern: /claude|anthropic|sonnet|opus|haiku|fable|mythos/i },
  { family: "gpt",      pattern: /gpt|openai|(^|\/)o\d|codex|davinci/i },
  { family: "gemini",   pattern: /gemini|vertex|google|palm|imagen|veo/i },
  { family: "qwen",     pattern: /qwen|tongyi|alibaba/i },
  { family: "deepseek", pattern: /deepseek/i },
  { family: "glm",      pattern: /glm|zhipu|chatglm/i },
  { family: "kimi",     pattern: /kimi|moonshot|k2/i },
  { family: "grok",     pattern: /grok|x-ai|xai/i },
  { family: "mistral",  pattern: /mistral|mixtral|codestral|magistral/i },
  { family: "command",  pattern: /command|cohere/i },
  { family: "llama",    pattern: /llama|meta-llama|gemma|phi/i },
];

// Detect family from a model id. Returns a LATIN_RATIOS / CJK_RATIOS key.
export function detectTokenFamily(model) {
  if (!model || typeof model !== "string") return "default";
  for (const { family, pattern } of FAMILY_PATTERNS) {
    if (pattern.test(model)) return family;
  }
  return "default";
}

// Latin-script ratio for a model id. This is the headline number surfaced
// in UI/logs ("chars/token"), and the one that governs English payloads.
export function charsPerTokenFor(model) {
  const fam = detectTokenFamily(model);
  return LATIN_RATIOS[fam] ?? LATIN_RATIOS.default;
}

// Script mix of a string: share of CJK code points, share of other
// non-Latin code points, share of astral (emoji) code points.
//
// Sampled at most 4000 code points — payloads are 8KB-70KB and the
// distribution is stable enough that sampling is safe on the hot path.
function scriptMix(text) {
  if (!text || text.length < 32) return { cjk: 0, other: 0, astral: 0 };
  let cjk = 0, other = 0, astral = 0, sample = 0;
  const step = Math.max(1, Math.floor(text.length / 4000));
  for (let i = 0; i < text.length; i += step) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    sample++;
    if (cp > 0xFFFF) { astral++; continue; }
    if (
      (cp >= 0x3040 && cp <= 0x30FF) ||  // kana
      (cp >= 0x3400 && cp <= 0x4DBF) ||  // CJK ext A
      (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK unified
      (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul
      (cp >= 0xF900 && cp <= 0xFAFF)     // CJK compat
    ) { cjk++; continue; }
    if (cp > 0x024F) { other++; continue; }
  }
  if (!sample) return { cjk: 0, other: 0, astral: 0 };
  return { cjk: cjk / sample, other: other / sample, astral: astral / sample };
}

// Effective chars/token for this text on this model: blend the family's
// Latin ratio with its CJK ratio by the text's actual script mix.
// Other non-Latin scripts and emoji are counted at ~2 chars/token, which
// is close enough for Cyrillic/Arabic/Devanagari and emoji runs.
export function effectiveCharsPerToken(text, model = "") {
  const fam = detectTokenFamily(model);
  const latin = LATIN_RATIOS[fam] ?? LATIN_RATIOS.default;
  const cjk = CJK_RATIOS[fam] ?? CJK_RATIOS.default;
  const { cjk: cjkShare, other: otherShare, astral: astralShare } = scriptMix(text);
  const latinShare = Math.max(0, 1 - cjkShare - otherShare - astralShare);
  // Convert shares to a weighted harmonic-ish ratio: tokens per char add up,
  // so chars per token = 1 / sum(share_i / ratio_i). This is the correct
  // composition when different scripts contribute tokens independently.
  const tokensPerChar =
    latinShare / latin +
    cjkShare / cjk +
    otherShare / 2.0 +
    astralShare / 1.5;
  if (tokensPerChar <= 0) return latin;
  return 1 / tokensPerChar;
}

export function estimateTokens(text, model = "") {
  if (typeof text !== "string" || !text.length) return 0;
  const ratio = Math.max(1.0, effectiveCharsPerToken(text, model));
  return Math.max(1, Math.round(text.length / ratio));
}

// Compact "1.2k" / "340" form for log lines and UI badges.
export function formatTok(n) {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

// Aggregate estimate of the Global Injection payload set, independent of
// any request: register (plinian preset or custom) + identity + godmode
// variant. Same text selection as injectGlobal() in globalInject.js.
import { getPlinianPrompt } from "../payload/plinianPrompts.js";
import { getGodmodePrompt, pickGodmodeVariant } from "../payload/godmodePayloads.js";
import { getExternalPayload } from "../payload/jailbreakPayloads.js";
import { CARRIER_SLOT, spliceCarrier } from "../payload/payloadCatalog.js";

export function estimateGlobalInjection({
  registerLevel = "standard",
  registerCustom = "",
  identity = "",
  godmodeLevel = "classic",
  godmodeCustom = "",
  model = "",
  carrierEnabled = false,
  carrierLevel = "",
  carrierCustom = "",
} = {}) {
  const regText = registerCustom ? registerCustom : getPlinianPrompt(registerLevel);
  const reg = `${String(identity || "").trim()}\n\n${regText}`.trim();
  // Mirror injectGodmode(): "classic" is the auto-pick sentinel.
  const autoPicked = !godmodeLevel || godmodeLevel === "classic";
  const effectiveLevel = autoPicked && model ? pickGodmodeVariant(model) : (godmodeLevel || "classic");
  const god = getGodmodePrompt(effectiveLevel, godmodeCustom);
  // Mirror injectGlobal() v0.6.0 rework: the carrier warp now lives inside
  // the persona text (identity). When identity carries the [YOUR JAILBREAK
  // HERE] slot, the main payload auto-splices into it; otherwise the legacy
  // carrier column (migration window only) is used; otherwise bare payload.
  const identityTrimmed = String(identity || "").trim();
  const carrierWarp = identityTrimmed.includes(CARRIER_SLOT);
  const legacyCarrierOn =
    !carrierWarp &&
    carrierEnabled &&
    (carrierCustom.trim() || carrierLevel);
  const carrierText = carrierWarp
    ? identityTrimmed
    : legacyCarrierOn
      ? (carrierCustom.trim() || getExternalPayload(carrierLevel) || "")
      : "";
  const finalPayload = carrierText
    ? spliceCarrier(carrierText, god)
    : god;
  const finalCarrier = carrierText || "";
  const family = detectTokenFamily(model);
  return {
    register: estimateTokens(reg, model),
    payload: estimateTokens(god, model),
    total: estimateTokens(reg + "\n\n" + finalPayload, model),
    effectiveLevel,
    carrier: finalCarrier ? estimateTokens(finalCarrier, model) : 0,
    carrierSpliced: !!(finalCarrier && finalCarrier.includes(CARRIER_SLOT)),
    autoPicked,
    family,
    charsPerToken: charsPerTokenFor(model),
  };
}
