/**
 * Pure data layer for self-followup promises (`~/.muse/followups.json`).
 *
 * Step 2 of `docs/design/agent-self-followup.md`. The detector
 * (step 1, `extractFollowupPromises` in @muse/agent-core) returns
 * typed promises from an assistant turn; this module persists
 * them so the firing daemon (step 4) can wake them at
 * `scheduledFor`.
 *
 * Storage shape mirrors personal-tasks-store and
 * personal-proactive-history-store:
 *   - atomic write via tmp+rename (no half-flushed JSON on crash)
 *   - tolerant read (missing file / bad JSON / wrong shape → [])
 *   - one append-only file, status flipped in place
 *
 * NOT covered here: scheduling, firing, LLM extraction fallback.
 * Those live in later steps.
 */

import { promises as fs } from "node:fs";
import { dirname, basename } from "node:path";

import type { JsonObject } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export type FollowupStatus = "scheduled" | "fired" | "cancelled";
export type FollowupStatusFilter = FollowupStatus | "all";

export interface PersistedFollowup {
  readonly id: string;
  /** User the followup belongs to (resolves to ~/.muse subscriber bucket). */
  readonly userId: string;
  /** ISO timestamp the promise resolves to (resolved by the detector). */
  readonly scheduledFor: string;
  /** ISO timestamp the promise was captured. */
  readonly createdAt: string;
  /** Short human summary of what the agent committed to. */
  readonly summary: string;
  /**
   * Run id whose assistant turn produced this promise. Lets the
   * firing daemon include the originating context as seed when it
   * re-enters the runtime.
   */
  readonly originRunId?: string;
  /**
   * Sha256 hex prefix of the assistant message that issued the
   * promise. Used by the firing daemon to dedupe — the same model
   * repeating the same phrase across multiple turns should not
   * queue twice if the user already cancelled the prior one.
   */
  readonly originTurnHash?: string;
  /**
   * Detector classification (relative-minutes / tomorrow-slot /
   * korean-relative-hours / etc.). Diagnostic field — not consumed
   * by the firing path.
   */
  readonly kind?: string;
  /** Lifecycle state. */
  readonly status: FollowupStatus;
  /** ISO timestamp the followup actually fired (set when status flips). */
  readonly firedAt?: string;
  /** Cancellation reason ("user-cancelled" / "snooze-replaced" / …). */
  readonly cancelReason?: string;
}


export async function readFollowups(file: string): Promise<readonly PersistedFollowup[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { followups?: unknown }).followups)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { followups: unknown[] }).followups.flatMap((entry): readonly PersistedFollowup[] =>
    isPersistedFollowup(entry) ? [entry] : []
  );
}

export async function writeFollowups(file: string, followups: readonly PersistedFollowup[]): Promise<void> {
  // Atomic, fsync'd, owner-only write via the shared primitive. The randomUUID
  // tmp (vs the old pid+Date.now) removes the same-ms rename-collision crash;
  // `cleanupFollowupTempFiles` still matches its `${base}.tmp-` prefix.
  await atomicWriteFile(file, `${JSON.stringify({ followups }, null, 2)}\n`);
}

/**
 * Clean up orphan `.tmp-*` siblings of `file` left over
 * from a previous crash mid-write. Called by `readFollowups`
 * (idempotent + cheap on a normal install where no orphans exist).
 * Best-effort — a stale temp file is annoying disk-space but not
 * a correctness issue, so any directory-walk error swallows
 * silently.
 */
export async function cleanupFollowupTempFiles(file: string): Promise<readonly string[]> {
  const dir = dirname(file);
  const base = basename(file);
  let entries: readonly { readonly name: string }[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
  const cleaned: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(`${base}.tmp-`)) continue;
    try {
      await fs.unlink(`${dir}/${entry.name}`);
      cleaned.push(entry.name);
    } catch {
      // Best-effort.
    }
  }
  return cleaned;
}

export function serializeFollowup(followup: PersistedFollowup): JsonObject {
  return {
    createdAt: followup.createdAt,
    id: followup.id,
    scheduledFor: followup.scheduledFor,
    status: followup.status,
    summary: followup.summary,
    userId: followup.userId,
    ...(followup.originRunId ? { originRunId: followup.originRunId } : {}),
    ...(followup.originTurnHash ? { originTurnHash: followup.originTurnHash } : {}),
    ...(followup.kind ? { kind: followup.kind } : {}),
    ...(followup.firedAt ? { firedAt: followup.firedAt } : {}),
    ...(followup.cancelReason ? { cancelReason: followup.cancelReason } : {})
  };
}

export function readFollowupStatusFilter(value: string | undefined): FollowupStatusFilter {
  if (value === "fired" || value === "cancelled" || value === "all") {
    return value;
  }
  return "scheduled";
}

/**
 * Soonest-first followup ordering, parallel to
 * `compareRemindersByDueAt` / `compareTasksByDueDate`. Compare
 * parsed instants, not raw strings: `scheduledFor` is a free-form
 * string (hand-edited followups.json / imports need not be
 * canonical) and lexicographic ISO order is wrong across mixed
 * precision ("…00.500Z" sorts before "…00Z") and timezone
 * offsets — it would surface the wrong followup as most imminent.
 * Equal instants break to newest-created-first; unparseable
 * values keep the prior deterministic string order.
 */
export function compareFollowupsByScheduledFor(
  left: PersistedFollowup,
  right: PersistedFollowup
): number {
  const leftMs = Date.parse(left.scheduledFor);
  const rightMs = Date.parse(right.scheduledFor);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    if (leftMs !== rightMs) {
      return leftMs - rightMs;
    }
  } else if (left.scheduledFor !== right.scheduledFor) {
    return left.scheduledFor.localeCompare(right.scheduledFor);
  }
  return right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Append a single followup to the on-disk store. Reads the
 * existing list, appends, writes atomically. Idempotent on `id`:
 * an entry whose `id` already exists is REPLACED (so a re-detect
 * pass updates `summary` / `scheduledFor` without duplicating).
 */
export async function upsertFollowup(file: string, followup: PersistedFollowup): Promise<void> {
  // Serialise the read-modify-write so two concurrent detect/schedule passes
  // don't each read the same snapshot and clobber one another — a lost followup
  // is a proactive nudge the user never receives.
  await withFileLock(file, async () => {
    const existing = await readFollowups(file);
    const filtered = existing.filter((entry) => entry.id !== followup.id);
    await writeFollowups(file, [...filtered, followup]);
  });
}

/**
 * Mark a scheduled followup as fired. Returns the patched entry
 * or `undefined` when the id is not found (or already non-scheduled).
 */
export async function markFollowupFired(
  file: string,
  id: string,
  firedAt: string
): Promise<PersistedFollowup | undefined> {
  return withFileLock(file, async () => {
    const existing = await readFollowups(file);
    const target = existing.find((entry) => entry.id === id);
    if (!target || target.status !== "scheduled") {
      return undefined;
    }
    const patched: PersistedFollowup = { ...target, firedAt, status: "fired" };
    const next = existing.map((entry) => (entry.id === id ? patched : entry));
    await writeFollowups(file, next);
    return patched;
  });
}

/**
 * Cancel a scheduled followup. No-op when the id is missing or
 * the entry is not currently scheduled.
 */
export async function cancelFollowup(
  file: string,
  id: string,
  reason: string
): Promise<PersistedFollowup | undefined> {
  return withFileLock(file, async () => {
    const existing = await readFollowups(file);
    const target = existing.find((entry) => entry.id === id);
    if (!target || target.status !== "scheduled") {
      return undefined;
    }
    const patched: PersistedFollowup = { ...target, cancelReason: reason, status: "cancelled" };
    const next = existing.map((entry) => (entry.id === id ? patched : entry));
    await writeFollowups(file, next);
    return patched;
  });
}

/**
 * Push a scheduled followup's `scheduledFor` to a new ISO timestamp.
 * Lifecycle-guarded — returns undefined when the id is missing or
 * the entry is already fired/cancelled (snoozing a stale entry
 * would either no-op silently or, worse, resurrect a cancelled
 * promise). Caller resolves the new ISO via the same date grammar
 * the rest of the CLI uses (e.g. `parseReminderDueAt`).
 */
export async function snoozeFollowup(
  file: string,
  id: string,
  newScheduledForIso: string
): Promise<PersistedFollowup | undefined> {
  return withFileLock(file, async () => {
    const existing = await readFollowups(file);
    const target = existing.find((entry) => entry.id === id);
    if (!target || target.status !== "scheduled") {
      return undefined;
    }
    const patched: PersistedFollowup = { ...target, scheduledFor: newScheduledForIso };
    const next = existing.map((entry) => (entry.id === id ? patched : entry));
    await writeFollowups(file, next);
    return patched;
  });
}

function isPersistedFollowup(value: unknown): value is PersistedFollowup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedFollowup;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.summary !== "string"
  ) {
    return false;
  }
  // scheduledFor must actually PARSE, not merely be a string: the
  // firing loop selects due entries with `Date.parse(scheduledFor)
  // <= now`, and an unparseable value yields NaN — `NaN <= now` is
  // false, so a hand-edited/imported followups.json with a bad
  // timestamp would never fire and sit "scheduled" forever with no
  // error. Drop it at load, the posture isPersistedEvent / CalDAV use.
  if (typeof candidate.scheduledFor !== "string"
    || !Number.isFinite(Date.parse(candidate.scheduledFor))) {
    return false;
  }
  return (
    (candidate.status === "scheduled" || candidate.status === "fired" || candidate.status === "cancelled") &&
    (candidate.originRunId === undefined || typeof candidate.originRunId === "string") &&
    (candidate.originTurnHash === undefined || typeof candidate.originTurnHash === "string") &&
    (candidate.kind === undefined || typeof candidate.kind === "string") &&
    (candidate.firedAt === undefined || typeof candidate.firedAt === "string") &&
    (candidate.cancelReason === undefined || typeof candidate.cancelReason === "string")
  );
}

export type FollowupRefResolution =
  | { readonly status: "resolved"; readonly followup: PersistedFollowup }
  | { readonly status: "ambiguous"; readonly candidates: readonly PersistedFollowup[] }
  | { readonly status: "not-found" };

/**
 * Resolve a cancel/snooze REFERENCE to a single followup — the followup's exact
 * `id`, OR a distinct word from its `summary` — so the model can act in ONE shot
 * without a prior `list` (parity with `resolveReminderRef`). Scheduled entries
 * win a tie (a fired/cancelled match with the same word is not the target); an
 * ambiguous word returns candidates instead of guessing (outbound-safety: never
 * cancel the wrong commitment on a coin-flip).
 */
export function resolveFollowupRef(
  followups: readonly PersistedFollowup[],
  ref: string | undefined
): FollowupRefResolution {
  const trimmed = ref?.trim() ?? "";
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const byId = followups.find((followup) => followup.id === trimmed);
  if (byId) {
    return { status: "resolved", followup: byId };
  }
  const needle = trimmed.toLowerCase();
  const matches = followups.filter((followup) => followup.summary.toLowerCase().includes(needle));
  const scheduled = matches.filter((followup) => followup.status === "scheduled");
  const pool = scheduled.length > 0 ? scheduled : matches;
  if (pool.length === 1) {
    return { status: "resolved", followup: pool[0]! };
  }
  if (pool.length > 1) {
    return { status: "ambiguous", candidates: pool };
  }
  return { status: "not-found" };
}
