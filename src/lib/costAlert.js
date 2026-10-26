// Cost alerting over the requestDetail rows the usage dashboard already stores.
//
// The cost-summary endpoint reports tokens, not dollars, on purpose: pricing
// varies per provider and changes, and a wrong dollar figure is worse than an
// accurate token count. This module keeps that contract — dollars only appear
// when a price is resolvable from the pricing repo, and the alert reports the
// token total when it is not.
//
// Two numbers matter to an operator: total spend in a window, and how it breaks
// down by model so a runaway caller or a misrouted combo can be seen. Both are
// computed from the same pass over the rows so the chart and the alert can
// never disagree about the same input.

import { getPricingForModel } from "./db/repos/pricingRepo.js";
import { notify, shouldNotify } from "./notifier.js";

export const DEFAULTS = {
  enabled: false,
  dailyUsdThreshold: 5,
  windowHours: 24,
};

// Normalize the usage block. Providers disagree about the field names
// (prompt_tokens vs input_tokens vs input), and a row that carried no usage
// should not be summed as zero cost — it is unknown, not free.
function readTokens(detail) {
  const usage = detail?.usage || detail?.tokens || {};
  const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? detail?.inTok) || 0;
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.output ?? detail?.outTok) || 0;
  return { inTok, outTok, total: inTok + outTok, hadUsage: inTok + outTok > 0 };
}

// Sum a list of rows into totals + a per-model breakdown, and resolve a dollar
// figure when the model has a price on file.
//
// Prices are read per model once (memoized in `priceCache`) rather than per row:
// a window of thousands of rows against three models is three lookups, not
// thousands.
export async function summarizeCost(rows, { now = Date.now() } = {}) {
  const priceCache = new Map();
  const byModel = new Map();
  let totalTokens = 0;
  let totalUsd = 0;
  let pricedModels = 0;
  let unpricedModels = 0;

  const resolvePrice = async (provider, model) => {
    const key = `${provider}/${model}`;
    if (priceCache.has(key)) return priceCache.get(key);
    let price = null;
    try { price = await getPricingForModel(provider, model); } catch { price = null; }
    priceCache.set(key, price);
    return price;
  };

  for (const r of rows) {
    const detail = typeof r?.data === "string" ? safeParse(r.data) : (r?.data || {});
    const { inTok, outTok, total, hadUsage } = readTokens(detail);
    if (!hadUsage) continue; // unknown usage is not zero cost

    totalTokens += total;

    const mKey = r.model || "unknown";
    let mRow = byModel.get(mKey);
    if (!mRow) {
      const price = await resolvePrice(r.provider, r.model);
      mRow = {
        model: mKey,
        provider: r.provider || "?",
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        price, // may be null
        usd: 0,
      };
      if (price) pricedModels += 1; else unpricedModels += 1;
      byModel.set(mKey, mRow);
    }

    mRow.requests += 1;
    mRow.tokens += total;
    mRow.inputTokens += inTok;
    mRow.outputTokens += outTok;

    if (mRow.price) {
      const inRate = Number(mRow.price.input ?? mRow.price.prompt ?? mRow.price.inputPer1M / 1e6 ?? 0) || 0;
      const outRate = Number(mRow.price.output ?? mRow.price.completion ?? mRow.price.outputPer1M / 1e6 ?? 0) || 0;
      // Handle both per-token and per-million conventions by checking magnitude:
      // a price under 1 is per-token, over 1 is per-million.
      const inCost = (inRate < 1 ? inTok * inRate : (inTok / 1e6) * inRate);
      const outCost = (outRate < 1 ? outTok * outRate : (outTok / 1e6) * outRate);
      mRow.usd += inCost + outCost;
    }
  }

  for (const m of byModel.values()) totalUsd += m.usd;

  const models = Array.from(byModel.values()).sort((a, b) => b.tokens - a.tokens);

  return {
    generatedAt: new Date(now).toISOString(),
    totalTokens,
    totalUsd,
    pricedModels,
    unpricedModels,
    models,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Compare a summary against the threshold and fire an alert if it is exceeded.
//
// Only fires when a dollar figure is resolvable. Alerting on a token count
// against a dollar threshold would compare unlike units. The dedup key carries
// the window so the same alert does not repeat every cron tick.
export async function checkCostAlert(summary, settings = {}) {
  const enabled = settings.costAlertEnabled === true;
  if (!enabled) return { fired: false, reason: "disabled" };

  const threshold = Number(settings.costAlertDailyThresholdUsd ?? DEFAULTS.dailyUsdThreshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return { fired: false, reason: "no-threshold" };

  if (summary.pricedModels === 0) {
    return { fired: false, reason: "no-pricing", tokens: summary.totalTokens };
  }

  if (summary.totalUsd < threshold) {
    return { fired: false, reason: "under-threshold", usd: summary.totalUsd, threshold };
  }

  // Dedup per UTC day so the operator sees one notice per day, not one per tick.
  const day = new Date().toISOString().slice(0, 10);
  const key = `cost-alert:${day}`;
  if (!shouldNotify(key)) return { fired: false, reason: "deduped", usd: summary.totalUsd };

  const top = summary.models.slice(0, 5).map((m) => `${m.model}: ${m.tokens.toLocaleString()} tok${m.price ? ` (~$${m.usd.toFixed(2)})` : ""}`).join("\n");
  await notify({
    title: "Cost alert",
    level: "warning",
    message: `$${summary.totalUsd.toFixed(2)} exceeds $${threshold} threshold (${summary.totalTokens.toLocaleString()} tokens)\n\nTop models:\n${top}`,
    key,
  });

  return { fired: true, usd: summary.totalUsd, threshold };
}

export function resolveConfig(settings = {}) {
  return {
    enabled: settings.costAlertEnabled === true,
    dailyUsdThreshold: Number(settings.costAlertDailyThresholdUsd) || DEFAULTS.dailyUsdThreshold,
    windowHours: Number(settings.costAlertWindowHours) || DEFAULTS.windowHours,
  };
}
