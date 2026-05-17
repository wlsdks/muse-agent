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
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

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

// Move a present-but-corrupt store aside so the next write
// starts fresh WITHOUT permanently destroying the user's prior
// followups. Best-effort; the original bytes survive at
// `<file>.corrupt-<ts>` for manual recovery.
async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
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
  const payload = `${JSON.stringify({ followups }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  // fsync before rename: filesystems journal metadata and data
  // separately, so a crash can otherwise commit the rename
  // pointing at a zero-length / partial file.
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/**
 * Goal 038: clean up orphan `.tmp-*` siblings of `file` left over
 * from a previous crash mid-write. Called by `readFollowups`
 * (idempotent + cheap on a normal install where no orphans exist).
 * Best-effort — a stale temp file is annoying disk-space but not
 * a correctness issue, so any directory-walk error swallows
 * silently.
 */
export async function cleanupFollowupTempFiles(file: string): Promise<readonly string[]> {
  const dir = dirname(file);
  const base = file.split("/").pop() ?? file;
  let entries: readonly { readonly name: string }[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as readonly { readonly name: string }[];
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
  return right.createdAt.localeCompare(left.createdAt);
}

/**
 * Append a single followup to the on-disk store. Reads the
 * existing list, appends, writes atomically. Idempotent on `id`:
 * an entry whose `id` already exists is REPLACED (so a re-detect
 * pass updates `summary` / `scheduledFor` without duplicating).
 */
export async function upsertFollowup(file: string, followup: PersistedFollowup): Promise<void> {
  const existing = await readFollowups(file);
  const filtered = existing.filter((entry) => entry.id !== followup.id);
  await writeFollowups(file, [...filtered, followup]);
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
  const existing = await readFollowups(file);
  const target = existing.find((entry) => entry.id === id);
  if (!target || target.status !== "scheduled") {
    return undefined;
  }
  const patched: PersistedFollowup = { ...target, firedAt, status: "fired" };
  const next = existing.map((entry) => (entry.id === id ? patched : entry));
  await writeFollowups(file, next);
  return patched;
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
  const existing = await readFollowups(file);
  const target = existing.find((entry) => entry.id === id);
  if (!target || target.status !== "scheduled") {
    return undefined;
  }
  const patched: PersistedFollowup = { ...target, cancelReason: reason, status: "cancelled" };
  const next = existing.map((entry) => (entry.id === id ? patched : entry));
  await writeFollowups(file, next);
  return patched;
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
  const existing = await readFollowups(file);
  const target = existing.find((entry) => entry.id === id);
  if (!target || target.status !== "scheduled") {
    return undefined;
  }
  const patched: PersistedFollowup = { ...target, scheduledFor: newScheduledForIso };
  const next = existing.map((entry) => (entry.id === id ? patched : entry));
  await writeFollowups(file, next);
  return patched;
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
  return candidate.status === "scheduled"
    || candidate.status === "fired"
    || candidate.status === "cancelled";
}
