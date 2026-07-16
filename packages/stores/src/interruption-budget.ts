/**
 * The interruption-budget ledger — a deterministic record of every UNASKED
 * proactive notice actually delivered (pattern firings, ambient notices,
 * follow-ups, background-exit notices, commitment check-ins). A user-scheduled
 * alert (reminder, imminent calendar/task) is never recorded here — the budget
 * exists to cap Muse-initiated interruption, not to gate something the user
 * asked for.
 *
 * `withinInterruptionBudget` is the pure gate a loop consults before sending:
 * sliding windows (trailing 60 minutes / trailing 24 hours), each independently
 * capped. `cap <= 0` (or non-finite) means that window is UNLIMITED — the
 * opposite of `proactive-trust-ledger`'s `withinDailyCap`, where a non-positive
 * cap fails closed. Here the budget is a UX throttle, not a safety gate, so the
 * off position is "let everything through", matching the product decision that
 * a cap of 0 turns the whole budget off.
 *
 * Append prunes entries older than 48h so the ledger never grows unbounded —
 * nothing outside the 24h window is ever read by the gate, so a longer history
 * serves no purpose. Tolerant reads: missing / bad-JSON / wrong-shape → empty
 * array, matching the sibling sidecar stores.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

export interface InterruptionDeliveryEntry {
  /** ISO timestamp of the delivery. */
  readonly at: string;
  /** The firing loop that delivered it, e.g. "pattern-firing", "ambient-notice". */
  readonly source: string;
}

export interface InterruptionBudgetCaps {
  readonly hourlyCap: number;
  readonly dailyCap: number;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const PRUNE_WINDOW_MS = 48 * HOUR_MS;

function isInterruptionDeliveryEntry(value: unknown): value is InterruptionDeliveryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.at === "string" && typeof entry.source === "string" && !Number.isNaN(new Date(entry.at).getTime());
}

export async function readInterruptionLedger(file: string): Promise<readonly InterruptionDeliveryEntry[]> {
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
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { deliveries?: unknown }).deliveries)) {
    return [];
  }
  return (parsed as { deliveries: unknown[] }).deliveries.flatMap((entry): readonly InterruptionDeliveryEntry[] =>
    isInterruptionDeliveryEntry(entry) ? [entry] : []
  );
}

async function writeInterruptionLedger(file: string, entries: readonly InterruptionDeliveryEntry[]): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify({ deliveries: entries }, null, 2)}\n`);
}

/**
 * Append one delivered-notice record, pruning entries older than 48h relative
 * to `entry.at` first. The in-process queue and cross-process lock cover the
 * whole read-modify-write, so independently started daemons cannot lose a
 * delivery record and accidentally exceed the configured interruption budget.
 */
export async function appendInterruptionDelivery(
  file: string,
  entry: { readonly at: Date; readonly source: string }
): Promise<void> {
  await withFileMutationQueue(file, async () => {
    await withFileLock(file, async () => {
      const existing = await readInterruptionLedger(file);
      const cutoffMs = entry.at.getTime() - PRUNE_WINDOW_MS;
      const pruned = existing.filter((e) => new Date(e.at).getTime() > cutoffMs);
      await writeInterruptionLedger(file, [...pruned, { at: entry.at.toISOString(), source: entry.source }]);
    });
  });
}

function countWithin(entries: readonly InterruptionDeliveryEntry[], nowMs: number, windowMs: number): number {
  const since = nowMs - windowMs;
  let count = 0;
  for (const entry of entries) {
    const atMs = new Date(entry.at).getTime();
    if (atMs > since && atMs <= nowMs) count += 1;
  }
  return count;
}

/**
 * True when both the trailing-60-minute and trailing-24-hour delivery counts
 * are strictly under their respective caps. A non-positive or non-finite cap
 * disables ITS window's check (unlimited), matching the product decision that
 * `cap <= 0` turns the budget off rather than blocking everything.
 */
export function withinInterruptionBudget(
  entries: readonly InterruptionDeliveryEntry[],
  now: Date,
  caps: InterruptionBudgetCaps
): boolean {
  const nowMs = now.getTime();
  const hourlyEnabled = Number.isFinite(caps.hourlyCap) && caps.hourlyCap > 0;
  const dailyEnabled = Number.isFinite(caps.dailyCap) && caps.dailyCap > 0;
  const hourlyOk = !hourlyEnabled || countWithin(entries, nowMs, HOUR_MS) < caps.hourlyCap;
  const dailyOk = !dailyEnabled || countWithin(entries, nowMs, DAY_MS) < caps.dailyCap;
  return hourlyOk && dailyOk;
}
