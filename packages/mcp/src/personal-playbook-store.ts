/**
 * Pure data layer for the learned-strategy playbook (`~/.muse/playbook.json`).
 *
 * ACE — Agentic Context Engineering (arXiv 2510.04618): a frozen model
 * self-improves by accumulating small strategy deltas in an evolving playbook.
 * This is the positive counterpart to the veto store — a veto says "don't do
 * X", a playbook entry says "when X, prefer Y" — injected into agent runs as
 * `[Learned Strategies]` so past feedback shapes future behaviour without
 * fine-tuning. Same durability posture as the sibling stores: atomic
 * fsync+rename write, tolerant read, corrupt store quarantined aside.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

/** Newest entries kept — bounds the file + the injected context. */
export const MAX_PLAYBOOK_ENTRIES = 100;

/**
 * Learned-reward bounds (RL over the bank): the net outcome signal per
 * strategy is clamped here so one streak can't dominate. Kept in sync with
 * agent-core's `PLAYBOOK_REWARD_MIN/MAX` (mcp stays free of an agent-core
 * dependency, so the range is declared on both sides — they MUST agree).
 */
export const PLAYBOOK_REWARD_MIN = -5;
export const PLAYBOOK_REWARD_MAX = 5;

export interface PlaybookEntry {
  readonly id: string;
  readonly userId: string;
  /** The learned strategy, e.g. "when rescheduling, default to the next business day". */
  readonly text: string;
  /** Optional task-class tag (e.g. "email", "scheduling"). */
  readonly tag?: string;
  readonly createdAt: string;
  /**
   * Net learned reward (reinforcements − decays), clamped to
   * [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX]. Absent on entries written
   * before rewards existed → read as 0 (neutral). Mutated via
   * `adjustPlaybookReward`; consumed by agent-core's reward-weighted ranking.
   */
  readonly reward?: number;
  /**
   * PROBATION: written UNATTENDED (idle daemon distillation) ⇒ recorded +
   * visible but NEVER injected, until a real reinforce graduates it (cleared
   * when reward goes positive). Breaks the self-confirmation loop. Absent =
   * graduated. (PART A2 / B1 §5.)
   */
  readonly probation?: boolean;
  /**
   * ISO timestamp of the last POSITIVE reinforcement (the recency signal for
   * disuse-decay, B1 §2): a trusted strategy you stop reinforcing fades back
   * toward neutral over time so one stale thumbs-up can't steer the agent
   * forever. Stamped by `adjustPlaybookReward` on a positive delta only —
   * decay never refreshes it, so continued disuse keeps fading. Absent ⇒
   * `createdAt` is the fallback recency anchor.
   */
  readonly lastReinforcedAt?: string;
}

async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
}

export async function readPlaybook(file: string): Promise<readonly PlaybookEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { entries?: unknown }).entries)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly PlaybookEntry[] =>
    isPlaybookEntry(entry) ? [entry] : []
  );
}

export async function writePlaybook(file: string, entries: readonly PlaybookEntry[]): Promise<void> {
  // Atomic, fsync'd, owner-only write via the shared primitive (randomUUID tmp →
  // no same-ms rename-collision crash).
  await atomicWriteFile(file, `${JSON.stringify({ entries }, null, 2)}\n`);
}

/**
 * Choose which entries survive when the bank overflows `cap` (B1 §3 —
 * reward-/recency-weighted eviction, replacing blind FIFO). Blind FIFO would
 * forget a strategy you reinforced ten times just because it is old, while
 * keeping a never-used newer one — exactly backwards. So eviction keeps the
 * `cap` HIGHEST-value entries, value = (reward, then recency): a high-reward
 * OLD strategy beats a low-reward NEW one; among equal reward the newer
 * survives. Survivors are returned in their ORIGINAL insertion order, because
 * that order is the recency proxy `rankPlaybookStrategies` relies on. A bank
 * at/under `cap` is returned unchanged.
 */
export function retainPlaybookEntries(entries: readonly PlaybookEntry[], cap: number): readonly PlaybookEntry[] {
  if (entries.length <= cap) {
    return entries;
  }
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.reward ?? 0) - (a.entry.reward ?? 0) || b.index - a.index);
  const keep = new Set(ranked.slice(0, cap).map((r) => r.index));
  return entries.filter((_entry, index) => keep.has(index));
}

export async function recordPlaybookStrategy(file: string, entry: PlaybookEntry): Promise<void> {
  // Serialise the read-modify-write: concurrent strategy records must not each
  // read the same snapshot and clobber one another (a lost learned strategy is a
  // self-improvement the agent forgets), and the cap below must apply to the
  // real merged set, not a stale one.
  await withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    const next = retainPlaybookEntries([...existing.filter((e) => e.id !== entry.id), entry], MAX_PLAYBOOK_ENTRIES);
    await writePlaybook(file, next);
  });
}

export async function queryPlaybook(file: string, userId?: string): Promise<readonly PlaybookEntry[]> {
  const all = await readPlaybook(file);
  return userId ? all.filter((e) => e.userId === userId) : all;
}

export async function removePlaybookStrategy(file: string, id: string): Promise<boolean> {
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) {
      return false;
    }
    await writePlaybook(file, next);
    return true;
  });
}

/**
 * Reinforce (delta > 0) or decay (delta < 0) a strategy's learned reward,
 * clamped to [PLAYBOOK_REWARD_MIN, PLAYBOOK_REWARD_MAX] — the RL update over
 * the bank: a correction-implicated strategy is decayed so it sinks out of
 * injection; a cleanly-used one is reinforced. Serialised read-modify-write
 * (no lost update), order-preserving (order is the recency proxy ranking
 * uses). Returns the new reward, or undefined when no entry matched / delta
 * was not finite.
 */
export async function adjustPlaybookReward(
  file: string,
  id: string,
  delta: number,
  nowMs: number = Date.now()
): Promise<number | undefined> {
  if (!Number.isFinite(delta)) {
    return undefined;
  }
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    if (!existing.some((e) => e.id === id)) {
      return undefined;
    }
    let updated = 0;
    const next = existing.map((e) => {
      if (e.id !== id) {
        return e;
      }
      updated = Math.max(PLAYBOOK_REWARD_MIN, Math.min(PLAYBOOK_REWARD_MAX, (e.reward ?? 0) + delta));
      return {
        ...e,
        reward: updated,
        // Graduation (B1 §5): a probation strategy with net-positive reward has
        // earned evidence — clear probation so it becomes injectable.
        ...(e.probation && updated > 0 ? { probation: false } : {}),
        // Recency anchor for disuse-decay (B1 §2): a real (positive) reinforce
        // refreshes it; a decay/penalty must NOT, or disuse could never fade.
        ...(delta > 0 ? { lastReinforcedAt: new Date(nowMs).toISOString() } : {})
      };
    });
    await writePlaybook(file, next);
    return updated;
  });
}

/** Disuse is judged stale past this many days without a positive reinforce. */
export const PLAYBOOK_DECAY_STALE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Disuse-decay (B1 §2 — continuous RL over the bank): every positive-reward
 * strategy NOT reinforced within `staleAfterDays` loses `step` reward toward
 * NEUTRAL 0 (never below — disuse fades trust, it does not punish; a real
 * correction is what drives a strategy negative). So a one-off thumbs-up
 * can't steer the agent forever: stop reinforcing a strategy and it sinks out
 * of the injected `[Learned Strategies]` block on its own. Probation, neutral,
 * and already-negative entries are untouched. Serialised read-modify-write;
 * writes only when something changed. Returns the number of strategies decayed.
 */
export async function decayStalePlaybookRewards(
  file: string,
  options: { readonly nowMs: number; readonly staleAfterDays?: number; readonly step?: number }
): Promise<number> {
  const staleMs = Math.max(0, options.staleAfterDays ?? PLAYBOOK_DECAY_STALE_DAYS) * DAY_MS;
  const step = Math.max(1, Math.trunc(options.step ?? 1));
  return withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    let decayed = 0;
    const next = existing.map((e) => {
      const reward = e.reward ?? 0;
      if (e.probation === true || reward <= 0) {
        return e;
      }
      const anchorMs = Date.parse(e.lastReinforcedAt ?? e.createdAt);
      if (!Number.isFinite(anchorMs) || options.nowMs - anchorMs < staleMs) {
        return e;
      }
      decayed += 1;
      return { ...e, reward: Math.max(0, reward - step) };
    });
    if (decayed > 0) {
      await writePlaybook(file, next);
    }
    return decayed;
  });
}

function isPlaybookEntry(value: unknown): value is PlaybookEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<PlaybookEntry>;
  if (typeof e.id !== "string" || e.id.length === 0) return false;
  if (typeof e.userId !== "string" || e.userId.length === 0) return false;
  if (typeof e.text !== "string" || e.text.trim().length === 0) return false;
  if (typeof e.createdAt !== "string") return false;
  if (e.tag !== undefined && typeof e.tag !== "string") return false;
  if (e.reward !== undefined && (typeof e.reward !== "number" || !Number.isFinite(e.reward))) return false;
  if (e.probation !== undefined && typeof e.probation !== "boolean") return false;
  if (e.lastReinforcedAt !== undefined && typeof e.lastReinforcedAt !== "string") return false;
  return true;
}
