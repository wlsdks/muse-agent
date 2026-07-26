/**
 * Append-only history of reminder firings. Each entry records one
 * delivery attempt (success or failure) by `runDueReminders` so the
 * user / agent can audit "did the daemon actually deliver my 9am
 * reminder?" weeks later.
 *
 * Shape: `{ version: 1, entries: HistoryEntry[] }`. Atomic
 * tmp+rename writes, capped at `capacity` newest entries (default
 * 500). The cap is enforced on append — `readHistory` doesn't trim.
 * Missing / malformed file → empty array (idempotent first-read).
 */

import { promises as fs } from "node:fs";

import { redactSecretsInText } from "@muse/shared";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "./atomic-file-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface ReminderHistoryEntry {
  readonly reminderId: string;
  /** Durable occurrence identity. Optional only for backward-compatible legacy entries. */
  readonly effectId?: string;
  readonly text: string;
  readonly providerId: string;
  readonly destination: string;
  readonly firedAtIso: string;
  readonly status: "delivered" | "failed";
  readonly error?: string;
}

interface PersistedShape {
  readonly version: 1;
  readonly entries: readonly ReminderHistoryEntry[];
}

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 5_000;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const MAX_EFFECT_ID_LENGTH = 512;

export async function readReminderHistory(file: string, limit?: number): Promise<readonly ReminderHistoryEntry[]> {
  const cap = clampReadLimit(limit);
  const all = await readRaw(file);
  // Stored newest-last; surface newest-first like inbox-store does.
  return [...all].reverse().slice(0, cap);
}

/**
 * Fail-closed reader for delivery repair. Unlike the review-oriented tolerant
 * reader, corrupt or unsupported bytes are never quarantined-to-empty because
 * an empty result could make a caller duplicate a historical delivery record.
 */
export async function readReminderHistoryStrict(
  file: string,
  limit?: number
): Promise<readonly ReminderHistoryEntry[]> {
  const cap = clampReadLimit(limit);
  const entries = await readRawStrict(file);
  return [...entries].reverse().slice(0, cap);
}

async function readRawStrict(file: string): Promise<readonly ReminderHistoryEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("reminder history is corrupt");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !hasExactKeys(parsed, ["entries", "version"])
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { entries?: unknown }).entries)
    || !(parsed as { entries: unknown[] }).entries.every(isStrictHistoryEntry)
  ) {
    throw new Error("reminder history has an unsupported schema");
  }
  return (parsed as { entries: ReminderHistoryEntry[] }).entries;
}

export interface AppendReminderHistoryOptions {
  readonly capacity?: number;
}

export async function appendReminderHistory(
  file: string,
  entry: ReminderHistoryEntry,
  options: AppendReminderHistoryOptions = {}
): Promise<void> {
  const capacity = clampCapacity(options.capacity);
  // Serialise the read→append→write: concurrent reminder fires otherwise read the
  // same snapshot and the last write clobbers the rest (a lost fire record can let
  // a one-shot reminder re-fire), and two writes in the same millisecond collided
  // on the tmp-${pid}-${Date.now()} path and threw ENOENT on rename.
  // Scrub at the persist chokepoint so every caller inherits it — `text` is the
  // reminder body and `error` can quote an upstream response, neither scrubbed
  // upstream (the delivery path scrubs only the copy it SENDS, not this archive).
  // Exact parity with the sibling proactive-history store.
  const scrubbed: ReminderHistoryEntry = {
    ...entry,
    text: redactSecretsInText(entry.text),
    ...(entry.error ? { error: redactSecretsInText(entry.error) } : {})
  };
  assertHistoryEntry(scrubbed);
  await withFileMutationQueue(file, () => withFileLock(file, async () => {
    const existing = await readRaw(file);
    const next = [...existing, scrubbed];
    const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
    const payload: PersistedShape = { entries: trimmed, version: 1 };
    await atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  }));
}

/**
 * Strict, idempotent append used by restart repair. The strict read and write
 * share one file lock, so corruption or a conflicting record that appears
 * after preflight cannot be quarantined/overwritten as an empty history.
 */
export async function appendReminderHistoryStrictOnce(
  file: string,
  entry: ReminderHistoryEntry,
  options: AppendReminderHistoryOptions = {}
): Promise<"appended" | "existing"> {
  const capacity = clampCapacity(options.capacity);
  const scrubbed: ReminderHistoryEntry = {
    ...entry,
    text: redactSecretsInText(entry.text),
    ...(entry.error ? { error: redactSecretsInText(entry.error) } : {})
  };
  assertHistoryEntry(scrubbed);
  if (scrubbed.effectId === undefined) {
    throw new Error("strict reminder history append requires an effectId");
  }
  let outcome: "appended" | "existing" = "appended";
  await withFileMutationQueue(file, () => withFileLock(file, async () => {
    const existing = await readRawStrict(file);
    const sameDelivery = existing.find((candidate) => candidate.effectId === scrubbed.effectId);
    if (sameDelivery) {
      if (!sameHistoryEntry(sameDelivery, scrubbed)) {
        throw new Error(`reminder history effectId is bound to different content: ${scrubbed.effectId}`);
      }
      outcome = "existing";
      return;
    }
    const next = [...existing, scrubbed];
    const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
    await atomicWriteFile(file, `${JSON.stringify({ entries: trimmed, version: 1 } satisfies PersistedShape, null, 2)}\n`);
  }));
  return outcome;
}

async function readRaw(file: string): Promise<readonly ReminderHistoryEntry[]> {
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
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly ReminderHistoryEntry[] =>
    isHistoryEntry(entry) ? [entry] : []
  );
}

function clampReadLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(raw)));
}

function clampCapacity(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_CAPACITY;
  }
  return Math.max(1, Math.min(MAX_CAPACITY, Math.trunc(raw)));
}

function isHistoryEntry(value: unknown): value is ReminderHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as ReminderHistoryEntry;
  return typeof candidate.reminderId === "string"
    && (
      candidate.effectId === undefined
      || (
        typeof candidate.effectId === "string"
        && candidate.effectId.trim().length > 0
        && candidate.effectId === candidate.effectId.trim()
        && candidate.effectId.length <= MAX_EFFECT_ID_LENGTH
      )
    )
    && typeof candidate.text === "string"
    && typeof candidate.providerId === "string"
    && typeof candidate.destination === "string"
    && typeof candidate.firedAtIso === "string"
    && (candidate.status === "delivered" || candidate.status === "failed")
    && (candidate.error === undefined || typeof candidate.error === "string");
}

function isStrictHistoryEntry(value: unknown): value is ReminderHistoryEntry {
  if (!isHistoryEntry(value)) return false;
  const keys = ["destination", "firedAtIso", "providerId", "reminderId", "status", "text"];
  if (value.effectId !== undefined) keys.push("effectId");
  if (value.error !== undefined) keys.push("error");
  return hasExactKeys(value, keys);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertHistoryEntry(value: ReminderHistoryEntry): void {
  if (!isHistoryEntry(value)) {
    throw new Error("reminder history entry is invalid or unsupported");
  }
}

function sameHistoryEntry(left: ReminderHistoryEntry, right: ReminderHistoryEntry): boolean {
  return left.destination === right.destination
    && left.effectId === right.effectId
    && left.error === right.error
    && left.firedAtIso === right.firedAtIso
    && left.providerId === right.providerId
    && left.reminderId === right.reminderId
    && left.status === right.status
    && left.text === right.text;
}
