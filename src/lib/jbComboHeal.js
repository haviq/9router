// JB Combo seat auto-heal.
//
// Reads the same probe outcomes the Model Status page produces, decides whether
// any seat is dead enough to drop, and whether any previously-dropped seat has
// healed enough to return. Pure decision logic — the caller writes the combo.
//
// Two thresholds, not one:
//   DROP after N consecutive failures, so a single 429 does not empty a combo.
//   RESTORE after M consecutive successes, so a seat that got one good probe
//   after a bad day does not flap back in.
// Asymmetric on purpose: dropping a working seat costs latency, dropping a
// broken one saves the fallback loop a full upstream trip per request.

const DEFAULT_DROP_THRESHOLD = 3;
const DEFAULT_RESTORE_THRESHOLD = 2;

if (!globalThis._9rComboHealState) globalThis._9rComboHealState = new Map();
const state = globalThis._9rComboHealState;

function bucketKey(combo, seat) {
  return `${combo}::${seat}`;
}

function getRecord(combo, seat) {
  const key = bucketKey(combo, seat);
  if (!state.has(key)) {
    state.set(key, { consecutiveFails: 0, consecutiveOks: 0, dropped: false, lastSeenAt: 0 });
  }
  return state.get(key);
}

// Record one observation for a seat and return the updated counters.
export function observeSeat(combo, seat, outcome) {
  const rec = getRecord(combo, seat);
  rec.lastSeenAt = Date.now();
  if (outcome?.ok) {
    rec.consecutiveOks += 1;
    rec.consecutiveFails = 0;
  } else {
    rec.consecutiveFails += 1;
    rec.consecutiveOks = 0;
  }
  return { ...rec };
}

// Decide whether the current combination of seats should change.
//
// Returns a plan with `toDrop` and `toRestore` lists. Never touches storage;
// idempotent for the same inputs.
export function planHeal({ combo = "jb", seats = [], outcomes = {}, dropThreshold = DEFAULT_DROP_THRESHOLD, restoreThreshold = DEFAULT_RESTORE_THRESHOLD } = {}) {
  const toDrop = [];
  const toRestore = [];

  for (const seat of seats) {
    const rec = getRecord(combo, seat);
    const outcome = outcomes[seat];

    // Feed the observation into counters before the decision so the caller can
    // pass a fresh snapshot and get a single-call answer.
    if (outcome) {
      if (outcome.ok) {
        rec.consecutiveOks += 1;
        rec.consecutiveFails = 0;
      } else {
        rec.consecutiveFails += 1;
        rec.consecutiveOks = 0;
      }
      rec.lastSeenAt = Date.now();
    }

    if (!rec.dropped && rec.consecutiveFails >= dropThreshold) {
      toDrop.push({ seat, reason: `${rec.consecutiveFails} consecutive failures` });
    } else if (rec.dropped && rec.consecutiveOks >= restoreThreshold) {
      toRestore.push({ seat, reason: `${rec.consecutiveOks} consecutive successes` });
    }
  }

  // Never let a plan empty the combo. If every seat would be dropped, keep the
  // least-bad one — an empty combo routes nothing and reads as "jb is broken".
  const survivors = seats.filter((s) => !toDrop.some((d) => d.seat === s));
  if (survivors.length === 0 && toDrop.length > 0) {
    const keep = toDrop.shift();
    if (keep) toDrop.splice(0, 0);
  }

  return { combo, toDrop, toRestore };
}

// Apply the plan in memory (marking dropped/restored flags). The caller is
// responsible for the DB write. Kept separate so tests can assert on the plan
// without a DB or side effect.
export function applyHeal(plan = {}) {
  const changed = { dropped: [], restored: [] };
  for (const d of plan.toDrop || []) {
    const rec = getRecord(plan.combo, d.seat);
    if (!rec.dropped) {
      rec.dropped = true;
      changed.dropped.push(d.seat);
    }
  }
  for (const r of plan.toRestore || []) {
    const rec = getRecord(plan.combo, r.seat);
    if (rec.dropped) {
      rec.dropped = false;
      changed.restored.push(r.seat);
    }
  }
  return changed;
}

export function getHealState(combo = "jb", seats = []) {
  const out = {};
  for (const seat of seats) out[seat] = { ...getRecord(combo, seat) };
  return out;
}

export function resetHealState() {
  state.clear();
}

export const HEAL_THRESHOLDS = { DEFAULT_DROP_THRESHOLD, DEFAULT_RESTORE_THRESHOLD };
