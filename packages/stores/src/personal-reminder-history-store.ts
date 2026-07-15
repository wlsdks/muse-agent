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

import { isRecord, redactSecretsInText } from "@muse/shared";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface ReminderHistoryEntry {
  readonly reminderId: string;
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

export async function readReminderHistory(file: string, limit?: number): Promise<readonly ReminderHistoryEntry[]> {
  const cap = clampReadLimit(limit);
  const all = await readRaw(file);
  // Stored newest-last; surface newest-first like inbox-store does.
  return [...all].reverse().slice(0, cap);
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
  await withFileMutationQueue(file, async () => {
    const existing = await readRaw(file);
    const next = [...existing, scrubbed];
    const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
    const payload: PersistedShape = { entries: trimmed, version: 1 };
    await atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  });
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
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  const entries = readRecordArrayField(parsed, "entries");
  if (entries === undefined) {
    await quarantineCorruptStore(file);
    return [];
  }
  return entries.flatMap((entry): readonly ReminderHistoryEntry[] =>
    isHistoryEntry(entry) ? [entry] : []
  );
}

function readRecordArrayField(value: unknown, key: string): unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value[key];
  return Array.isArray(candidate) ? candidate : undefined;
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
    && typeof candidate.text === "string"
    && typeof candidate.providerId === "string"
    && typeof candidate.destination === "string"
    && typeof candidate.firedAtIso === "string"
    && (candidate.status === "delivered" || candidate.status === "failed");
}
