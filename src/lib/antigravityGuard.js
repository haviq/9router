// Antigravity account safety guard.
//
// Antigravity is not a reseller — it is the operator's own Google account.
// A ban here costs Gmail, Drive, everything, not just an API key. The two ways
// an automation platform gets an account flagged are (a) hammering it without
// limits and (b) driving the account's quota to 100% so the pattern looks like
// abuse rather than a person. Both are preventable in the routing layer.
//
// This module answers two questions, pure by design so they are testable:
//   orderAccounts   — given quota snapshots, put the safest account first
//   waitForAccount  — how long before this account may be called again
//
// It deliberately does NOT hard-block. A guard that refuses to route when the
// snapshot is stale makes the system look broken; a guard that deprioritizes a
// near-full account keeps the box usable while steering clear of the cliff.

export const DEFAULT_GUARD = {
  enabled: true,
  // Above this the account is skipped when a healthier one is available.
  softLimitPercent: 85,
  // At or above this the account is not used at all unless nothing else is left.
  hardLimitPercent: 95,
  // Concurrent requests allowed per account before the next call is delayed.
  maxConcurrentPerAccount: 2,
  // Minimum spacing between two requests to the same account.
  minSpacingMs: 1000,
  // A call older than this does not count against the concurrency window.
  requestWindowMs: 30_000,
  // Hard daily ceiling per account. Above this the account is skipped for the
  // rest of the UTC day when another account can take the call. Set in the
  // hundreds for personal accounts; the Google abuse signal reads volume across
  // the account, not per-minute burst. 0 disables the ceiling.
  maxRequestsPerDay: 300,
};

// Read a quota snapshot for one account across whichever model asked for it.
// Antigravity reports per-model percentages in several shapes; the caller
// passes whichever one it holds and this normalizes the worst case, because a
// single model at 97% is a reason to steer away even if another sits at 10%.
function worstPercent(quota) {
  if (!quota) return null;
  const direct = Number(quota.remainingPercentage ?? quota.usedPercentage ?? quota.percent);
  if (Number.isFinite(direct) && direct > 0) {
    // remainingPercentage is a remaining value; usedPercentage/percent are used.
    return quota.remainingPercentage != null ? 100 - direct : direct;
  }
  const models = quota.models || quota.quotas || null;
  if (Array.isArray(models) && models.length > 0) {
    let max = 0;
    for (const m of models) {
      const used = Number(m?.usedPercentage ?? m?.percent);
      const rem = Number(m?.remainingPercentage);
      const value = Number.isFinite(used) && used > 0 ? used : Number.isFinite(rem) ? 100 - rem : 0;
      if (value > max) max = value;
    }
    return max;
  }
  return null;
}

export function accountUsedPercent(snapshot) {
  return worstPercent(snapshot);
}

// Order accounts by safety: coolest first (most headroom). An account with no
// snapshot is treated as neutral, not as 0% — treating it as 0% would always
// prefer unknown accounts and starve the ones with real headroom.
//
// Returns the same array shape it receives so the caller can pick the first.
export function orderAccounts(connections = [], snapshotsByAccount = {}, options = {}) {
  const g = { ...DEFAULT_GUARD, ...options };
  if (!g.enabled) return connections;
  const now = Date.now();
  const ranked = connections.map((c, idx) => {
    const snap = snapshotsByAccount[c.id];
    const used = snap ? worstPercent(snap) : null;
    const recent = recentRequestCount(c.id, now, g.requestWindowMs);
    // Lower score = better. Percent leads (the cliff is percent), then how many
    // calls are in flight, then original order (stable tie-break).
    const score =
      (used == null ? 50 : used) +
      (recent >= g.maxConcurrentPerAccount ? 100 : recent * 5);
    return { c, idx, score, used, recent };
  });
  return ranked.sort((a, b) => (a.score - b.score) || (a.idx - b.idx)).map((r) => r.c);
}

// True when the account should not be called at all under the hard limit, and
// the pool has at least one other account to pick. Called by the auth filter:
// it must never strand a request by hiding the last account.
export function shouldSkipAccount(connection, snapshot, poolSize, options = {}) {
  const g = { ...DEFAULT_GUARD, ...options };
  if (!g.enabled) return false;
  if (poolSize <= 1) return false;
  const used = worstPercent(snapshot);
  if (used == null) return false;
  return used >= g.hardLimitPercent;
}

// In-memory per-account request log. Node keeps the queue hot in prod; a
// restart clears the window, which is correct — a stale window from before a
// restart describes a state that no longer exists.
if (!globalThis._9rAccountGuard) globalThis._9rAccountGuard = new Map();
const accountLog = globalThis._9rAccountGuard;

// Per-day count per account. Reset by comparing the stored UTC day on read so
// no timer is needed and a restart mid-day keeps the count (this map is
// persisted on globalThis like the log above, but rebuilt on restart).
if (!globalThis._9rAccountDaily) globalThis._9rAccountDaily = new Map();
const accountDaily = globalThis._9rAccountDaily;

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function dailyCount(accountId, now = Date.now()) {
  const entry = accountDaily.get(accountId);
  if (!entry) return 0;
  if (entry.day !== todayKey(now)) return 0;
  return entry.count || 0;
}

function logFor(accountId) {
  if (!accountLog.has(accountId)) accountLog.set(accountId, []);
  return accountLog.get(accountId);
}

function recentRequestCount(accountId, now, windowMs) {
  const arr = accountLog.get(accountId);
  if (!arr || arr.length === 0) return 0;
  const cutoff = now - windowMs;
  // Trim in place so the array cannot grow unbounded over a long run.
  while (arr.length && arr[0] < cutoff) arr.shift();
  return arr.length;
}

// Record that a request is going out to this account.
export function markAccountRequest(accountId, now = Date.now()) {
  if (!accountId) return;
  logFor(accountId).push(now);
  // Also bump the per-day counter; read-time reset handles UTC rollover.
  const day = todayKey(now);
  const entry = accountDaily.get(accountId);
  if (!entry || entry.day !== day) {
    accountDaily.set(accountId, { day, count: 1 });
  } else {
    entry.count += 1;
  }
}

// True when this account has already hit its daily ceiling and there is another
// account to take the call. The ceiling is the account-safety lever that the
// percentage guard does not cover: an account can sit at 20% quota by noon and
// still look like a bot if every request of the day flowed through it.
export function shouldSkipByDailyCap(accountId, poolSize, options = {}) {
  const g = { ...DEFAULT_GUARD, ...options };
  if (!g.enabled) return false;
  if (!g.maxRequestsPerDay || g.maxRequestsPerDay <= 0) return false;
  if (poolSize <= 1) return false;
  return dailyCount(accountId) >= g.maxRequestsPerDay;
}

export function dailyRequestCount(accountId, now = Date.now()) {
  return dailyCount(accountId, now);
}

// How long to wait before the next request to this account.
//
// 0 means "go now". A non-zero result is advisory: the caller may choose to
// pick another account instead of sleeping, which is usually better.
export function waitForAccount(accountId, now = Date.now(), options = {}) {
  const g = { ...DEFAULT_GUARD, ...options };
  if (!g.enabled || !accountId) return 0;
  const arr = logFor(accountId);
  if (!arr.length) return 0;
  const last = arr[arr.length - 1];
  const sinceLast = now - last;
  if (sinceLast >= g.minSpacingMs) return 0;
  return g.minSpacingMs - sinceLast;
}

// Threshold alert. Fires once per account per UTC day when the account crosses
// the soft limit, so the operator learns before the hard limit bites rather
// than after a request fails.
export function shouldAlertAccount(accountId, usedPercent, options = {}) {
  const g = { ...DEFAULT_GUARD, ...options };
  if (!g.enabled || usedPercent == null) return false;
  if (usedPercent < g.softLimitPercent) return false;
  if (!shouldNotifyOnce(accountId)) return false;
  return true;
}

if (!globalThis._9rAlertFired) globalThis._9rAlertFired = new Map();
const alertFired = globalThis._9rAlertFired;

function shouldNotifyOnce(accountId, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${accountId}:${day}`;
  if (alertFired.get(key)) return false;
  alertFired.set(key, true);
  return true;
}

export function resetAccountGuard() {
  accountLog.clear();
  alertFired.clear();
}

export function guardStats() {
  return {
    trackedAccounts: accountLog.size,
    alertsToday: alertFired.size,
  };
}
