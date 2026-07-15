/**
 * Learn-queue — the signal substrate for background self-learning (B1).
 *
 * The idle distiller needs the RAW correction exchange (user asked → assistant
 * answered → user corrected), but stored episodes keep only summaries, so the
 * exchange must be captured WHEN it happens and consumed later on idle. This
 * is a tiny append-only `~/.muse/learn-queue.jsonl`: a real signal (a
 * correction) enqueues ONE event; the idle Sleep tick drains pending events
 * one-at-a-time behind the resource brakes, distills each, and marks it done.
 * No real signal ⇒ empty queue ⇒ no wasted compute. FAIL-SAFE: a corrupt line
 * is skipped, never crashing the producer or consumer. (PART A2 / B1.)
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";

/** `~/.muse/learn-queue.jsonl` by default; override via `MUSE_LEARN_QUEUE_FILE`. */
export function resolveLearnQueueFile(env: Record<string, string | undefined> = process.env): string {
  const override = env.MUSE_LEARN_QUEUE_FILE?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".muse", "learn-queue.jsonl");
}

/** A queued correction the idle distiller will turn into a learned strategy. */
export interface LearnCorrectionEvent {
  readonly id: string;
  readonly userId: string;
  /** The original user request, if known (improves the distilled lesson). */
  readonly request?: string;
  /** What the assistant answered before the user corrected it. */
  readonly priorAnswer: string;
  /** The user's correction — the real source of the lesson. */
  readonly correction: string;
  readonly enqueuedAtMs: number;
}

/** Keep the queue bounded — a runaway producer can't grow the file unboundedly. */
export const MAX_LEARN_QUEUE_EVENTS = 200;

function isEvent(value: unknown): value is LearnCorrectionEvent {
  const e = value as Partial<LearnCorrectionEvent> | null;
  return !!e && typeof e.id === "string" && typeof e.userId === "string"
    && typeof e.priorAnswer === "string" && typeof e.correction === "string"
    && typeof e.enqueuedAtMs === "number";
}

/**
 * Append ONE correction event (one real signal = one job). Creates the dir if
 * needed. Serialized on the per-file mutation queue so an append can't interleave
 * between the drain's read and rewrite (markLearnEventsDone) and get clobbered.
 */
export async function enqueueLearnEvent(file: string, event: LearnCorrectionEvent): Promise<void> {
  await withFileMutationQueue(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  });
}

/** All pending (valid) events, oldest first; corrupt lines skipped. Missing file ⇒ []. */
export async function readPendingLearnEvents(file: string): Promise<readonly LearnCorrectionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: LearnCorrectionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isEvent(parsed)) out.push(parsed);
    } catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Remove the given event ids from the queue (called after they're distilled),
 * rewriting the file atomically with only the remaining pending events. Also
 * trims to the newest `MAX_LEARN_QUEUE_EVENTS` so the file can't grow forever.
 * Serialized on the per-file mutation queue (shared with enqueueLearnEvent) so
 * the read-modify-write can't lose an append that races it.
 */
export async function markLearnEventsDone(file: string, doneIds: readonly string[]): Promise<void> {
  const done = new Set(doneIds);
  await withFileMutationQueue(file, async () => {
    const remaining = (await readPendingLearnEvents(file)).filter((e) => !done.has(e.id));
    const trimmed = remaining.slice(-MAX_LEARN_QUEUE_EVENTS);
    await atomicWriteFile(file, trimmed.map((e) => JSON.stringify(e)).join("\n") + (trimmed.length > 0 ? "\n" : ""));
  });
}

/**
 * Defensive age cap (DS-13). `MAX_LEARN_QUEUE_EVENTS` only bounds the queue
 * on a successful drain (`markLearnEventsDone`) — if the idle distiller never
 * runs (disabled, crashing, `MUSE_SELFLEARN` off), `enqueueLearnEvent` keeps
 * appending unconditionally and the file grows forever. Drops any pending
 * event older than `ageDays` regardless of consumption state; a stale
 * correction is no longer a useful learning signal anyway. Shares the same
 * per-file mutation queue as enqueue/markDone so this can't race a
 * concurrent write. No-op (no write) when nothing is old enough to drop.
 */
export async function pruneLearnQueueByAge(
  file: string,
  options: { readonly ageDays: number; readonly now?: number }
): Promise<{ readonly kept: number; readonly dropped: number }> {
  const now = options.now ?? Date.now();
  const cutoffMs = now - Math.max(0, options.ageDays) * 86_400_000;
  return withFileMutationQueue(file, async () => {
    const existing = await readPendingLearnEvents(file);
    const kept = existing.filter((e) => e.enqueuedAtMs >= cutoffMs);
    if (kept.length !== existing.length) {
      await atomicWriteFile(file, kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""));
    }
    return { dropped: existing.length - kept.length, kept: kept.length };
  });
}
