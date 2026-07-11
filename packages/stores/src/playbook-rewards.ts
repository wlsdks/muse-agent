/**
 * Pure reward-calc engine over the learned-strategy playbook — reward bounds,
 * the PEVI/Wilson lower-confidence-bound retention utility, and cap eviction.
 * No I/O; the persistence layer (personal-playbook-store.ts) owns reads/writes
 * and calls into this when recording or bounding the bank.
 */

import type { PlaybookEntry } from "./personal-playbook-store.js";

/**
 * Learned-reward bounds (RL over the bank): the net outcome signal per
 * strategy is clamped here so one streak can't dominate. Kept in sync with
 * agent-core's `PLAYBOOK_REWARD_MIN/MAX` (mcp stays free of an agent-core
 * dependency, so the range is declared on both sides — they MUST agree).
 */
export const PLAYBOOK_REWARD_MIN = -5;
export const PLAYBOOK_REWARD_MAX = 5;

/** z for the PEVI lower-confidence bound — mirrors agent-core's PLAYBOOK_PEVI_LAMBDA. */
const PLAYBOOK_PEVI_LAMBDA = 1.96;

export function clampReward(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, value));
}

/** Wilson score-interval lower bound; total ≤ 0 / non-finite inputs → 0. */
function wilsonLower(successes: number, total: number, z: number): number {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || !Number.isFinite(z) || total <= 0) {
    return 0;
  }
  const pHat = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const centre = (pHat + z2 / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt((pHat * (1 - pHat)) / total + z2 / (4 * total * total));
  return Math.max(0, centre - margin);
}

/**
 * PEVI retention utility (arXiv:2012.15085, pessimism under uncertainty) — the
 * SAME ranking agent-core's injection path uses (`rankingUtility`, Wilson LCB),
 * replicated here because mcp deliberately carries no agent-core dependency (see
 * PLAYBOOK_REWARD_MIN/MAX above). A thin-but-lucky strategy must NOT destructively
 * evict a battle-tested one, so survival ranks on the lower confidence bound of
 * the outcome tally, not the raw point-estimate reward. A no-tally entry falls
 * back to `clampReward(reward)` — byte-identical to the prior raw-reward order.
 * Time-free (no recency discount): retention's recency signal is the index
 * tie-break below, mirroring `rankingUtility` called without `nowMs`.
 */
function retentionUtility(entry: PlaybookEntry): number {
  const r = entry.reinforcements;
  const d = entry.decays;
  const validTally =
    typeof r === "number" && Number.isFinite(r) && r >= 0 && Number.isInteger(r) &&
    typeof d === "number" && Number.isFinite(d) && d >= 0 && Number.isInteger(d) &&
    r + d >= 1;
  if (!validTally) {
    return clampReward(entry.reward);
  }
  const n = (r as number) + (d as number);
  const lower = wilsonLower(r as number, n, PLAYBOOK_PEVI_LAMBDA);
  return Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, (2 * lower - 1) * PLAYBOOK_REWARD_MAX));
}

/**
 * Choose which entries survive when the bank overflows `cap`
 * (reward-/recency-weighted eviction, replacing blind FIFO). Blind FIFO would
 * forget a strategy you reinforced ten times just because it is old, while
 * keeping a never-used newer one — exactly backwards. So eviction keeps the
 * `cap` HIGHEST-value entries, value = (PEVI retention utility, then recency):
 * a confidently-proven OLD strategy beats a thin-but-lucky NEW one; among equal
 * utility the newer survives. Survivors are returned in their ORIGINAL insertion
 * order, because that order is the recency proxy `rankPlaybookStrategies` relies
 * on. A bank at/under `cap` is returned unchanged.
 */
export function retainPlaybookEntries(entries: readonly PlaybookEntry[], cap: number): readonly PlaybookEntry[] {
  if (entries.length <= cap) {
    return entries;
  }
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => retentionUtility(b.entry) - retentionUtility(a.entry) || b.index - a.index);
  const keep = new Set(ranked.slice(0, cap).map((r) => r.index));
  return entries.filter((_entry, index) => keep.has(index));
}
