// Combo healing: drop seats that can never route.
//
// A combo is a stored list of "alias/model" strings with no connection of its
// own. When the provider behind a seat is switched off (or its connection is
// deleted), the seat stays in the list forever: /v1/models stops advertising
// the combo, the UI now marks the seat dead, but the stored row still carries
// it. Every retry walks a seat that cannot answer.
//
// This module is the pure decision layer — no DB, no fetch — so the rules are
// testable and the route stays a thin read/update wrapper.

import { getProviderAlias } from "@/shared/constants/providers";
import { PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

// Live aliases are built exactly like the /v1/models combo-health check: a
// connection contributes its custom prefix, its provider alias, and its raw
// provider id, so a seat written in any of those forms resolves.
export function buildLiveAliases(connections = []) {
  const live = new Set();
  for (const conn of connections) {
    if (!conn || conn.isActive === false) continue;
    const providerId = conn.provider;
    if (!providerId) continue;
    // Register every form a seat could be written in, not just the preferred
    // one. A custom prefix does not replace the provider alias or the raw id:
    // old combos still reference `ds/model` after the operator sets a prefix,
    // and treating those as dead would heal away working seats.
    const prefix = String(conn?.providerSpecificData?.prefix || "").trim();
    if (prefix) live.add(prefix);

    const alias = String(getProviderAlias(providerId) || "").trim();
    if (alias) live.add(alias);

    const staticAlias = String(PROVIDER_ID_TO_ALIAS[providerId] || "").trim();
    if (staticAlias) live.add(staticAlias);

    live.add(providerId);
  }
  return live;
}

// Classify one seat. `nested` seats are combo names, not provider prefixes:
// they are judged by their own members, so they are never healed away here.
export function classifySeat(seat, liveAliases) {
  const raw = String(seat || "").trim();
  if (!raw) return "empty";
  const slash = raw.indexOf("/");
  if (slash === -1) return "nested";
  return liveAliases.has(raw.slice(0, slash)) ? "live" : "dead";
}

// Resolve a nested combo name to its own seats, with cycle protection.
function nestedSeats(name, comboByName, visiting = new Set()) {
  if (!name || visiting.has(name)) return [];
  const members = comboByName[name];
  if (!Array.isArray(members)) return [];
  visiting.add(name);
  const out = [];
  for (const member of members) {
    const raw = typeof member === "string" ? member.trim() : "";
    if (!raw) continue;
    if (comboByName[raw]) out.push(...nestedSeats(raw, comboByName, visiting));
    else out.push(raw);
  }
  visiting.delete(name);
  return out;
}

// A nested combo is alive when at least one of its resolved seats is live.
// Empty nested combos are dead: they resolve to nothing.
function nestedIsAlive(name, liveAliases, comboByName, visiting = new Set()) {
  const seats = nestedSeats(name, comboByName, visiting);
  if (!seats.length) return false;
  return seats.some((seat) => classifySeat(seat, liveAliases) === "live");
}

/**
 * Decide what a heal would do to one combo.
 *
 * @returns {{
 *   keep: string[], removed: string[], deadNested: string[],
 *   total: number, liveCount: number, changed: boolean, wouldEmpty: boolean
 * }}
 */
export function planComboHeal(combo, liveAliases, comboByName = {}) {
  const seats = Array.isArray(combo?.models) ? combo.models : [];
  const keep = [];
  const removed = [];
  const deadNested = [];

  for (const seat of seats) {
    const raw = typeof seat === "string" ? seat.trim() : "";
    if (!raw) continue;
    const kind = classifySeat(raw, liveAliases);

    if (kind === "nested") {
      if (nestedIsAlive(raw, liveAliases, comboByName)) keep.push(raw);
      else deadNested.push(raw);
      continue;
    }

    if (kind === "live") keep.push(raw);
    else removed.push(raw);
  }

  return {
    keep,
    removed,
    deadNested,
    total: seats.length,
    liveCount: keep.length,
    changed: removed.length > 0 || deadNested.length > 0,
    // Healing must never silently produce a combo that routes nowhere: an
    // empty model list looks identical to a brand-new combo and hides the
    // fact that every provider behind it went away.
    wouldEmpty: keep.length === 0 && seats.length > 0,
  };
}

// Apply a plan: dead nested combos are dropped from the list, but their own
// rows are left alone — deleting a combo is a separate, explicit action.
export function applyComboHeal(combo, plan) {
  return { ...combo, models: plan.keep };
}
