/**
 * Per-day budget tracker for the followup LLM-fallback detector.
 *
 * Step 5 of `docs/design/agent-self-followup.md` adds an opt-in
 * LLM call per assistant turn when `MUSE_FOLLOWUP_LLM_FALLBACK=true`.
 * Every call costs an extra model round-trip; without a cap, a
 * chatty session can quietly burn the user's daily quota.
 *
 * This module owns `~/.muse/followup-llm-budget.json` — a one-line
 * `{ date, calls }` record that auto-resets on date change. The
 * capture-hook wiring increments before each LLM call and short-
 * circuits when `isBudgetExhausted` returns true.
 *
 * Tolerant reads + atomic tmp+rename writes, same as the other
 * personal stores. A corrupt file is treated as "no budget used
 * today" — better to allow one extra LLM call than to permanently
 * lock the feature out on a bad parse.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

export interface FollowupLlmBudgetRecord {
  /** Local-day key — `YYYY-MM-DD`. Used so the count resets each day automatically. */
  readonly date: string;
  readonly calls: number;
}

export async function readFollowupLlmBudget(file: string): Promise<FollowupLlmBudgetRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<FollowupLlmBudgetRecord>;
  if (
    typeof candidate.date !== "string"
    || typeof candidate.calls !== "number"
    || !Number.isSafeInteger(candidate.calls)
    || candidate.calls < 0
  ) {
    return undefined;
  }
  return { calls: candidate.calls, date: candidate.date };
}

async function writeFollowupLlmBudgetUnlocked(file: string, record: FollowupLlmBudgetRecord): Promise<void> {
  // Use the shared atomic primitive (randomUUID tmp + fsync + 0o600 + orphan
  // cleanup): the old hand-rolled `tmp-${pid}-${Date.now()}` name collided between
  // two same-millisecond writers (the slower rename hit ENOENT and CRASHED) and left
  // the tmp orphaned on any write/rename failure.
  await atomicWriteFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function writeFollowupLlmBudget(file: string, record: FollowupLlmBudgetRecord): Promise<void> {
  await withFileLock(file, () => writeFollowupLlmBudgetUnlocked(file, record));
}

/**
 * Atomic read → maybe-reset (if date rolled over) → increment →
 * write. Returns the post-increment record so the caller can
 * record analytics or test `isBudgetExhausted` against the new
 * count without re-reading.
 */
export async function incrementFollowupLlmBudget(file: string, today: string): Promise<FollowupLlmBudgetRecord> {
  // Serialise the read→increment→write: concurrent increments otherwise BOTH read
  // the same count and write count+1, so the daily total under-counts — the budget
  // gate never trips and the followup detector over-spends its LLM-call cap. (They
  // also collided on the tmp-${pid}-${Date.now()} path and threw ENOENT on rename.)
  return withFileMutationQueue(file, () => withFileLock(file, async () => {
    const existing = await readFollowupLlmBudget(file);
    const next: FollowupLlmBudgetRecord = existing && existing.date === today
      ? { calls: existing.calls + 1, date: today }
      : { calls: 1, date: today };
    await writeFollowupLlmBudgetUnlocked(file, next);
    return next;
  }));
}

/**
 * Pure check. Cap <= 0 short-circuits to "exhausted" so a
 * misconfigured cap can't accidentally allow infinite calls.
 * No record (fresh install) → never exhausted. Date mismatch
 * (yesterday's record vs today) → never exhausted, the next
 * `incrementFollowupLlmBudget` will reset.
 */
export function isFollowupLlmBudgetExhausted(
  record: FollowupLlmBudgetRecord | undefined,
  today: string,
  cap: number
): boolean {
  if (!Number.isFinite(cap) || cap <= 0) return true;
  if (!record) return false;
  if (record.date !== today) return false;
  return record.calls >= cap;
}

export function formatLocalDay(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
