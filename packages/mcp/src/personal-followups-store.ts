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
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { followups?: unknown }).followups)) {
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
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, file);
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

function isPersistedFollowup(value: unknown): value is PersistedFollowup {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedFollowup;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.scheduledFor !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.summary !== "string"
  ) {
    return false;
  }
  return candidate.status === "scheduled"
    || candidate.status === "fired"
    || candidate.status === "cancelled";
}
