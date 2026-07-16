/**
 * Pattern-detection cooldown sidecar — step 4 of
 * `docs/design/pattern-detection.md`. Mirrors the
 * proactive-fired pattern but keys off the detector's stable
 * `patternId` (the sha256-12 prefix from
 * `detectTimeOfDayPatterns` / `detectWeeklyTaskPatterns`).
 *
 *   - `~/.muse/patterns-fired.json` is the on-disk sidecar.
 *   - `recordPatternFired(file, patternId, firedAtMs)` appends a
 *     fired record (FIFO-trimmed to MAX entries, atomic write).
 *   - `isPatternOnCooldown(records, patternId, nowMs, cooldownMs)`
 *     is a pure helper the orchestrator uses to filter detected
 *     patterns before firing.
 *
 * Tolerant reads: missing / bad-JSON / wrong-shape → empty array.
 * One corrupt row does not sink the file.
 */

import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";

export interface PatternFiredRecord {
  readonly patternId: string;
  readonly firedAtMs: number;
  /**
   * When true, this is a DISMISSAL — the user told Muse to stop suggesting
   * this pattern. Dismissed patterns never fire again (learned avoidance),
   * distinct from the time-bounded cooldown a normal fire records.
   */
  readonly dismissed?: boolean;
}

const MAX_FIRED_ENTRIES = 2_000;

export async function readPatternsFired(file: string): Promise<readonly PatternFiredRecord[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { fired?: unknown }).fired)) {
    return [];
  }
  return (parsed as { fired: unknown[] }).fired.flatMap((entry): readonly PatternFiredRecord[] =>
    isPatternFiredRecord(entry) ? [entry] : []
  );
}

async function writePatternsFiredUnlocked(file: string, records: readonly PatternFiredRecord[]): Promise<void> {
  // FIFO trim — keep the most recent N. Two thousand entries covers
  // years of daily firing per pattern; the trim guards pathological
  // clock drift or bulk-replay scenarios. Dismissals are NEVER trimmed:
  // a dismissal is learned avoidance (the user vetoed this pattern), so
  // partition them out and FIFO-trim only the plain fires — otherwise a
  // burst of newer fires would evict an old dismissal and Muse would
  // resume suggesting a pattern the user explicitly silenced.
  let trimmed: readonly PatternFiredRecord[];
  if (records.length > MAX_FIRED_ENTRIES) {
    const dismissals = records.filter((r) => r.dismissed === true);
    const fires = records.filter((r) => r.dismissed !== true);
    const trimmedFires = fires.length > MAX_FIRED_ENTRIES
      ? fires.slice(fires.length - MAX_FIRED_ENTRIES)
      : fires;
    trimmed = [...dismissals, ...trimmedFires];
  } else {
    trimmed = records;
  }
  const payload = `${JSON.stringify({ fired: trimmed }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

export async function writePatternsFired(file: string, records: readonly PatternFiredRecord[]): Promise<void> {
  await withFileLock(file, () => writePatternsFiredUnlocked(file, records));
}

async function appendPatternRecord(file: string, record: PatternFiredRecord): Promise<void> {
  await withFileMutationQueue(file, () => withFileLock(file, async () => {
    const existing = await readPatternsFired(file);
    await writePatternsFiredUnlocked(file, [...existing, record]);
  }));
}

export async function recordPatternFired(file: string, patternId: string, firedAtMs: number): Promise<void> {
  await appendPatternRecord(file, { firedAtMs, patternId });
}

/**
 * Record a DISMISSAL — the user asked Muse to stop suggesting this pattern.
 * Appended like a fired record but flagged `dismissed`, so it suppresses the
 * pattern permanently (learned avoidance), surviving a cooldown `reset`.
 */
export async function dismissPattern(file: string, patternId: string, atMs: number): Promise<void> {
  await appendPatternRecord(file, { dismissed: true, firedAtMs: atMs, patternId });
}

/** True when any record for this pattern is a dismissal. */
export function isPatternDismissed(records: readonly PatternFiredRecord[], patternId: string): boolean {
  return records.some((record) => record.patternId === patternId && record.dismissed === true);
}

/**
 * Pure cooldown check. A pattern is "on cooldown" when its most
 * recent fired record is more recent than `nowMs - cooldownMs`.
 * No record at all → not on cooldown (first fire). Multiple
 * records for the same id → the newest wins.
 */
export function isPatternOnCooldown(
  records: readonly PatternFiredRecord[],
  patternId: string,
  nowMs: number,
  cooldownMs: number
): boolean {
  if (cooldownMs <= 0) return false;
  let mostRecent: number | undefined;
  for (const record of records) {
    if (record.patternId !== patternId) continue;
    if (mostRecent === undefined || record.firedAtMs > mostRecent) {
      mostRecent = record.firedAtMs;
    }
  }
  if (mostRecent === undefined) return false;
  return nowMs - mostRecent < cooldownMs;
}

function isPatternFiredRecord(value: unknown): value is PatternFiredRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PatternFiredRecord>;
  return typeof candidate.patternId === "string"
    && typeof candidate.firedAtMs === "number"
    && Number.isFinite(candidate.firedAtMs)
    && (candidate.dismissed === undefined || typeof candidate.dismissed === "boolean");
}
