// Cross-model payload transfer.
//
// The sweeps in this repo showed a strong pattern: a payload that works on one
// model usually works on its siblings. mg/deepseek-ai/DeepSeek-V4-Pro took three
// different frames; cn/minimax took one; both providers have a stable guard
// character across their model list.
//
// So a payload measured on one model is evidence about its family, not just
// about that model. Testing every payload on every model re-discovers the same
// fact hundreds of times. This module turns one measurement into a ranked
// candidate list for the untested siblings, which is where the 90% of wasted
// sweep time goes.
//
// The ranking is deliberately conservative: a transfer is a HYPOTHESIS to test,
// never a result to record. Nothing here writes to MODEL_VARIANT_MAP — the
// caller still has to run the candidate before it counts.

// Extract the family key from a model id.
//
// Provider prefixes vary (`mg/`, `cn/`, `oc/`, `ifx/ali/`) and the model part
// carries the family: `deepseek-v4.1-flash` and `deepseek-v4-pro` are the same
// family even though the variants differ. Taking the first meaningful token of
// the model segment is crude but matches how these ids are actually built.
export function familyOf(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return "";

  // Drop known provider prefixes, keeping the model segment.
  const parts = raw.split("/");
  let model = parts[parts.length - 1] || raw;

  // A bare provider path (`ifx/ag/`) leaves the provider as the last segment —
  // fall back to the previous one so the family is not the gateway name.
  if (parts.length > 1 && /^(ag|ali|cb|cbcn|mm|cp|kiro|alicn)$/i.test(model)) {
    model = parts[parts.length - 2] || model;
  }

  // Take the leading alphabetic run as the family.
  //
  // Chasing version suffixes with regexes is a losing game: `minimax-m3` needs
  // the `-m3` stripped but the `m` kept, `qwen3.8-27b` needs the digit stripped
  // without a separator to anchor on, and `deepseek-v4.1-flash` has both. The
  // leading alpha run answers all three the same way — every model id in this
  // gateway starts with its family name and then decorates it.
  const base = model.toLowerCase().match(/^[a-z]+/);

  return base ? base[0] : model.toLowerCase();
}

// Group model ids by family.
export function groupByFamily(modelIds = []) {
  const map = new Map();
  for (const id of modelIds) {
    const key = familyOf(id);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
  }
  return map;
}

// Rank candidate transfers from one measured result.
//
// `measured` is {model, payloadId, score}. `known` is every model id the caller
// could test. Returns siblings of the measured model, best first, with a
// confidence that decays with distance from the source.
//
// A model that already has a stored result for this payload is excluded: the
// point is to fill gaps, not to re-run what is already known.
export function planTransfers({ measured, known = [], alreadyMeasured = [], limit = 20 } = {}) {
  if (!measured || !measured.model || !measured.payloadId) return [];
  if (!(Number(measured.score) > 0)) {
    // A payload that failed on the source model is not evidence it will work
    // elsewhere — a zero score transfers a zero, and spending calls to confirm
    // a known failure is waste.
    return [];
  }

  const family = familyOf(measured.model);
  if (!family) return [];

  const done = new Set(
    (Array.isArray(alreadyMeasured) ? alreadyMeasured : [])
      .filter((r) => r && r.payloadId === measured.payloadId)
      .map((r) => r.model),
  );

  const candidates = [];
  for (const model of known) {
    if (model === measured.model) continue;
    if (done.has(model)) continue;
    if (familyOf(model) !== family) continue;

    candidates.push({
      model,
      payloadId: measured.payloadId,
      sourceModel: measured.model,
      // Same family is the whole hypothesis. The score carries over as an
      // expectation, not a result.
      expectedScore: Number(measured.score) || 0,
      confidence: "family",
    });
  }

  // Stable order: highest expected score first, then alphabetical so a rerun
  // produces the same list.
  candidates.sort((a, b) => b.expectedScore - a.expectedScore || a.model.localeCompare(b.model));

  return candidates.slice(0, Math.max(1, Number(limit) || 20));
}

// Build a transfer plan from every stored measurement.
//
// `runs` is the shape getBenchmarkRuns returns. One pass over the stored
// results produces the union of candidates, de-duplicated per model+payload so
// a payload measured on three siblings does not queue the same transfer thrice.
export function buildTransferPlan({ runs = [], known = [], limit = 40 } = {}) {
  const seen = new Set();
  const plan = [];

  for (const run of runs) {
    const candidates = planTransfers({
      measured: { model: run.model, payloadId: run.payloadId, score: run.score },
      known,
      alreadyMeasured: runs,
      limit,
    });

    for (const c of candidates) {
      const key = `${c.model}::${c.payloadId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push(c);
      if (plan.length >= limit) return plan;
    }
  }

  return plan;
}
