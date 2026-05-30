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

export async function recordPlaybookStrategy(file: string, entry: PlaybookEntry): Promise<void> {
  // Serialise the read-modify-write: concurrent strategy records must not each
  // read the same snapshot and clobber one another (a lost learned strategy is a
  // self-improvement the agent forgets), and the FIFO cap below must apply to the
  // real merged set, not a stale one.
  await withFileMutationQueue(file, async () => {
    const existing = await readPlaybook(file);
    const next = [...existing.filter((e) => e.id !== entry.id), entry].slice(-MAX_PLAYBOOK_ENTRIES);
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
export async function adjustPlaybookReward(file: string, id: string, delta: number): Promise<number | undefined> {
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
      return { ...e, reward: updated };
    });
    await writePlaybook(file, next);
    return updated;
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
  return true;
}
