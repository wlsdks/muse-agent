/**
 * Append-only history of proactive surfacing fires. Mirror of
 * `personal-reminder-history-store` for the proactive daemon —
 * records every delivery attempt (success or failure) by
 * `runDueProactiveNotices` so the user / agent can audit
 * "did Muse actually push the 3pm meeting notice?" weeks later.
 *
 * Lives alongside the dedupe sidecar (`proactive-fired.json`) but
 * the two files have different jobs: the sidecar is a key-set the
 * daemon checks before firing; the history is an append-only audit
 * log with the delivered text + error context for failure triage.
 *
 * Shape: `{ version: 1, entries: HistoryEntry[] }`. Atomic
 * tmp+rename writes, capped at `capacity` newest entries (default
 * 500). The cap is enforced on append — `readHistory` doesn't trim.
 * Missing / malformed file → empty array (idempotent first-read).
 */

import { promises as fs } from "node:fs";

import { redactSecretsInText } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";

import type { ProactiveFiredKind } from "./proactive-notice-store.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface ProactiveHistoryEntry {
  /** "calendar" | "task" — same union the dedupe sidecar uses. */
  readonly kind: ProactiveFiredKind;
  /** Provider-reported event id, or task id. */
  readonly itemId: string;
  /** Event startsAt / task dueAt (ISO). */
  readonly startIso: string;
  /** Item title at the time of firing (event title or task title). */
  readonly title: string;
  /** Resolved messaging provider for this fire. */
  readonly providerId: string;
  /** Resolved messaging destination for this fire. */
  readonly destination: string;
  /** Text actually delivered (flat or agent-synthesized — Phase D). */
  readonly text: string;
  /** When the delivery was attempted. */
  readonly firedAtIso: string;
  readonly status: "delivered" | "failed";
  readonly error?: string;
}

interface PersistedShape {
  readonly version: 1;
  readonly entries: readonly ProactiveHistoryEntry[];
}

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 5_000;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 500;
const MAX_ARCHIVE_FILES = 100;

export async function readProactiveHistory(file: string, limit?: number): Promise<readonly ProactiveHistoryEntry[]> {
  const cap = clampReadLimit(limit);
  const all = await readRaw(file);
  // Stored newest-last; surface newest-first like inbox-store + reminder-history do.
  return [...all].reverse().slice(0, cap);
}

export interface AppendProactiveHistoryOptions {
  readonly capacity?: number;
  /**
   * When set ≥ 1, an append that would push the live
   * file past `capacity` first rotates the current file to
   * `${file}.1` (shifting `.1` → `.2`, …, capped at
   * `archiveMaxFiles` archives — older archives are unlinked).
   * The new entry then lands in a fresh file. When the option
   * is unset / 0, the pre-079 behavior is preserved: the
   * oldest entries are silently sliced off.
   */
  readonly archiveMaxFiles?: number;
}

export async function appendProactiveHistory(
  file: string,
  entry: ProactiveHistoryEntry,
  options: AppendProactiveHistoryOptions = {}
): Promise<void> {
  const capacity = clampCapacity(options.capacity);
  const archiveMaxFiles = clampArchiveMaxFiles(options.archiveMaxFiles);
  // Serialise the read → (rotate) → append → write so concurrent appends can't
  // each read the same snapshot and clobber one another (a lost proactive-history
  // entry corrupts the trust-ledger precision) — nor collide on the same
  // `tmp-${pid}-${Date.now()}` path within one millisecond (which threw ENOENT on
  // rename). Same per-file queue the playbook / consent / objective stores use.
  await withFileLock(file, async () => {
    let existing = await readRaw(file);

    // `>= capacity` (not `>`): one more append would exceed, so
    // rotate now to keep the archive boundary at exactly capacity.
    if (archiveMaxFiles > 0 && existing.length >= capacity) {
      await rotateProactiveHistoryFiles(file, archiveMaxFiles);
      existing = [];
    }

    // Scrub at the persist chokepoint so every caller inherits it.
    // title flows raw from the task/event source and error may
    // quote request bodies — neither is scrubbed upstream.
    const scrubbed: ProactiveHistoryEntry = {
      ...entry,
      title: redactSecretsInText(entry.title),
      text: redactSecretsInText(entry.text),
      ...(entry.error ? { error: redactSecretsInText(entry.error) } : {})
    };
    const next = [...existing, scrubbed];
    const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
    const payload: PersistedShape = { entries: trimmed, version: 1 };
    await atomicWriteFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  });
}

/**
 * Rotation step: rename `${file}.<archiveMaxFiles-1>` →
 * `${file}.<archiveMaxFiles>`, …, `${file}` → `${file}.1`. Any
 * existing `.${archiveMaxFiles+1}` (older than the operator's
 * retention budget) is unlinked. Exported for direct test
 * coverage so the rotation contract is locked in without
 * driving it through `appendProactiveHistory`.
 *
 * Best-effort: a missing source file at any step is silently
 * skipped (the archive ladder may have gaps after manual
 * cleanup; we want to fail-open, not crash an append).
 */
export async function rotateProactiveHistoryFiles(file: string, archiveMaxFiles: number): Promise<void> {
  const max = Math.max(1, clampArchiveMaxFiles(archiveMaxFiles));
  // Drop anything past the retention budget.
  for (let i = max + 1; i <= max + 5; i += 1) {
    await fs.unlink(`${file}.${i.toString()}`).catch(() => undefined);
  }
  // Shift archives upward starting from the top so we don't
  // clobber a target that still holds the previous slot's data.
  for (let i = max - 1; i >= 1; i -= 1) {
    const src = `${file}.${i.toString()}`;
    const dst = `${file}.${(i + 1).toString()}`;
    try {
      await fs.rename(src, dst);
    } catch {
      // Source missing — fine, that slot's empty.
    }
  }
  // Rename the live file to `.1`.
  try {
    await fs.rename(file, `${file}.1`);
  } catch {
    // Live file may not exist yet (first-rotation edge case).
  }
}

async function readRaw(file: string): Promise<readonly ProactiveHistoryEntry[]> {
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
  return (parsed as { entries: unknown[] }).entries.flatMap((entry): readonly ProactiveHistoryEntry[] =>
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

function clampArchiveMaxFiles(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_ARCHIVE_FILES, Math.trunc(raw)));
}

function isHistoryEntry(value: unknown): value is ProactiveHistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as ProactiveHistoryEntry;
  return (candidate.kind === "calendar" || candidate.kind === "task")
    && typeof candidate.itemId === "string"
    && typeof candidate.startIso === "string"
    && typeof candidate.title === "string"
    && typeof candidate.providerId === "string"
    && typeof candidate.destination === "string"
    && typeof candidate.text === "string"
    && typeof candidate.firedAtIso === "string"
    && (candidate.status === "delivered" || candidate.status === "failed")
    && (candidate.error === undefined || typeof candidate.error === "string");
}
