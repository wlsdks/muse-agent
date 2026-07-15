/**
 * Pure data layer for durable standing objectives
 * (`~/.muse/objectives.json`).
 *
 * A standing objective is the long-horizon counterpart to a
 * one-shot followup: "watch for X / keep trying Y until Z / tell
 * me when W". It must survive a process restart and the ~20-min
 * loop boundary, so it lives on disk with the same durability
 * posture as personal-followups-store / personal-tasks-store:
 *   - atomic write (tmp + fsync + rename — no half-flushed JSON)
 *   - tolerant read (missing file / bad JSON / wrong shape → [])
 *   - corrupt store quarantined aside, never silently destroyed
 *   - one file, status flipped in place
 *
 * NOT covered here: tick re-evaluation / backoff / escalation
 * (the next P5 slice) and scoped-credential acting (the slice
 * after). This module is register + durable persistence only.
 */

import { promises as fs } from "node:fs";

import type { JsonObject } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export type ObjectiveKind = "watch" | "until" | "notify";
export type ObjectiveStatus = "active" | "done" | "escalated" | "cancelled";

export interface StandingObjective {
  readonly id: string;
  /** User the objective belongs to (~/.muse subscriber bucket). */
  readonly userId: string;
  /** ISO timestamp the objective was registered. */
  readonly createdAt: string;
  /** The human objective text ("watch the build until it goes green"). */
  readonly spec: string;
  /** Coarse form, for the re-evaluation dispatcher (next slice). */
  readonly kind: ObjectiveKind;
  /** Lifecycle state. */
  readonly status: ObjectiveStatus;
  /** ISO timestamp of the last tick that re-evaluated it (next slice). */
  readonly lastEvaluatedAt?: string;
  /** Re-evaluation attempt count, drives backoff (next slice). */
  readonly attempts?: number;
  /** ISO timestamp the next re-evaluation is allowed (backoff; next slice). */
  readonly nextEvalAt?: string;
  /** Why it left `active` (set when status flips). */
  readonly resolution?: string;
}

export async function readObjectives(file: string): Promise<readonly StandingObjective[]> {
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
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { objectives?: unknown }).objectives)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return (parsed as { objectives: unknown[] }).objectives.flatMap((entry): readonly StandingObjective[] =>
    isStandingObjective(entry) ? [entry] : []
  );
}

export async function writeObjectives(file: string, objectives: readonly StandingObjective[]): Promise<void> {
  // Atomic, fsync'd, owner-only write via the shared primitive (randomUUID tmp →
  // no same-ms rename-collision crash).
  await atomicWriteFile(file, `${JSON.stringify({ objectives }, null, 2)}\n`);
}

/**
 * Register a standing objective. Reads the existing list, appends,
 * writes atomically. Idempotent on `id`: an entry whose `id`
 * already exists is REPLACED (re-registering the same objective
 * updates its spec/status without duplicating).
 */
export async function addObjective(file: string, objective: StandingObjective): Promise<void> {
  // Serialised read-modify-write under a CROSS-PROCESS file lock (mirrors
  // personal-tasks-store's mutateTasks): the in-process-only mutation queue
  // does not stop the daemon's re-evaluation tick and a manual CLI registration
  // (separate processes) from each reading the same snapshot and clobbering the
  // other (a lost objective = a standing intent the daemon never acts on).
  await withFileLock(file, async () => {
    const existing = await readObjectives(file);
    const filtered = existing.filter((entry) => entry.id !== objective.id);
    await writeObjectives(file, [...filtered, objective]);
  });
}

/**
 * Shallow-merge a patch into one objective and persist atomically.
 * Returns the patched entry, or `undefined` when the id is absent.
 * `id` is never overwritten. This is the durable status-flip the
 * re-evaluation loop uses (active → done | escalated, attempts /
 * nextEvalAt bumps) — parallel to followups' markFollowupFired.
 */
export async function patchObjective(
  file: string,
  id: string,
  patch: Partial<Omit<StandingObjective, "id">>
): Promise<StandingObjective | undefined> {
  return withFileLock(file, async () => {
    const existing = await readObjectives(file);
    const target = existing.find((entry) => entry.id === id);
    if (!target) {
      return undefined;
    }
    const patched: StandingObjective = { ...target, ...patch, id: target.id };
    await writeObjectives(file, existing.map((entry) => (entry.id === id ? patched : entry)));
    return patched;
  });
}

export function serializeObjective(objective: StandingObjective): JsonObject {
  return {
    createdAt: objective.createdAt,
    id: objective.id,
    kind: objective.kind,
    spec: objective.spec,
    status: objective.status,
    userId: objective.userId,
    ...(objective.lastEvaluatedAt ? { lastEvaluatedAt: objective.lastEvaluatedAt } : {}),
    ...(objective.attempts !== undefined ? { attempts: objective.attempts } : {}),
    ...(objective.nextEvalAt ? { nextEvalAt: objective.nextEvalAt } : {}),
    ...(objective.resolution ? { resolution: objective.resolution } : {})
  };
}

function isStandingObjective(value: unknown): value is StandingObjective {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as StandingObjective;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.userId !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.spec !== "string"
  ) {
    return false;
  }
  if (candidate.kind !== "watch" && candidate.kind !== "until" && candidate.kind !== "notify") {
    return false;
  }
  return (
    candidate.status === "active" ||
    candidate.status === "done" ||
    candidate.status === "escalated" ||
    candidate.status === "cancelled"
  );
}
