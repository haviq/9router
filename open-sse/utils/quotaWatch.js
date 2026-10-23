// Provider quota signal detection.
//
// Nothing in the request log records "this provider ran out of quota". The
// status column is only ever success / "200 OK" / completed — a 402 or a 429
// arrives inside the provider response body and gets stored as opaque JSON.
// So a sweep burns through a provider's daily allowance and the only evidence
// is a wall of 402s that nothing counts.
//
// This module reads those bodies and answers one question: did this request
// fail because the provider's allowance is gone? Pure by design — the caller
// supplies the body, so the detection rules are testable without a network.
//
// Deliberately NOT a rate-limit detector. A 429 with "slow down" is backoff
// pressure; a 429 with "quota exceeded" is the account being empty for the
// day. Only the second one should stop a sweep, and conflating them makes a
// busy provider look dead.

// Phrases that mean the allowance is spent, not that we asked too fast.
const QUOTA_MARKERS = [
  /quota[_ ]?exceeded/i,
  /insufficient[_ ]quota/i,
  /usage limit (?:for|reached)/i,
  /exceeded your current quota/i,
  /billing (?:hard )?limit/i,
  /out of credits/i,
  /no (?:remaining )?credits/i,
  /credit balance is too low/i,
  /daily limit (?:reached|exceeded)/i,
  /monthly limit (?:reached|exceeded)/i,
  /free tier (?:limit|exhausted)/i,
  /额度|配额|余额不足/,          // zh: quota / allowance / insufficient balance
  /kuota (?:habis|terpakai)/i,   // id
];

// Phrases that mean slow down, not empty. Kept separate so a busy provider is
// never marked dead — that is the mistake that makes a sweep skip 400 models.
const RATE_MARKERS = [
  /rate[_ ]limit(?:ed)?/i,
  /too many requests/i,
  /requests per (?:minute|second|day) exceeded/i,
  /slow down/i,
];

function bodyText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// Extract an HTTP-ish status code from whatever shape the caller stored.
function statusCodeOf(body, fallback) {
  const direct = Number(body?.status ?? body?.statusCode ?? body?.error?.status);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const asNum = Number(fallback);
  return Number.isFinite(asNum) && asNum > 0 ? asNum : null;
}

export const QUOTA_STATE = {
  OK: "ok",
  QUOTA: "quota",
  RATE: "rate",
  UNKNOWN: "unknown",
};

// Classify one provider response.
//
// Order matters: a body can carry both "429" and "quota exceeded". The phrase
// is more specific than the code — 429 alone means backoff, 429 + quota means
// the account is done — so quota wins.
export function classifyProviderResponse({ body, statusCode } = {}) {
  const text = bodyText(body);
  const code = statusCodeOf(body, statusCode);

  if (!text) {
    return { state: QUOTA_STATE.UNKNOWN, code, reason: "empty body" };
  }

  for (const re of QUOTA_MARKERS) {
    const m = text.match(re);
    if (m) {
      return { state: QUOTA_STATE.QUOTA, code, reason: m[0] };
    }
  }

  // 402 Payment Required is quota by definition — there is no other reading.
  if (code === 402) {
    return { state: QUOTA_STATE.QUOTA, code, reason: "402 payment required" };
  }

  for (const re of RATE_MARKERS) {
    const m = text.match(re);
    if (m) {
      return { state: QUOTA_STATE.RATE, code, reason: m[0] };
    }
  }

  if (code === 429) {
    return { state: QUOTA_STATE.RATE, code, reason: "429 without quota phrase" };
  }

  return { state: QUOTA_STATE.OK, code, reason: "" };
}

// Decide whether a sweep should stop calling this provider.
//
// Only QUOTA stops a sweep. RATE means slow down — the provider is alive and a
// delay recovers it. Treating RATE as fatal is how a run skips hundreds of
// models that would have answered.
export function shouldStopProvider(state) {
  return state === QUOTA_STATE.QUOTA;
}

// Roll classified results into a per-provider view for the dashboard.
export function summarizeQuota(entries = []) {
  const byProvider = new Map();

  for (const entry of entries) {
    const provider = entry?.provider || "unknown";
    if (!byProvider.has(provider)) {
      byProvider.set(provider, {
        provider,
        total: 0,
        quota: 0,
        rate: 0,
        ok: 0,
        unknown: 0,
        lastReason: "",
        lastCode: null,
      });
    }
    const row = byProvider.get(provider);
    row.total++;

    const { state, code, reason } = classifyProviderResponse(entry);
    if (state === QUOTA_STATE.QUOTA) {
      row.quota++;
      row.lastReason = reason || row.lastReason;
      row.lastCode = code ?? row.lastCode;
    } else if (state === QUOTA_STATE.RATE) {
      row.rate++;
    } else if (state === QUOTA_STATE.OK) {
      row.ok++;
    } else {
      row.unknown++;
    }
  }

  const providers = [...byProvider.values()].map((row) => ({
    ...row,
    // "exhausted" is the only state worth interrupting someone for.
    exhausted: row.quota > 0 && row.ok === 0,
  }));

  providers.sort((a, b) => b.quota - a.quota || b.total - a.total);

  return {
    providers,
    exhaustedProviders: providers.filter((p) => p.exhausted).map((p) => p.provider),
  };
}
