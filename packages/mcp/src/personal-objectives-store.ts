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
import { dirname } from "node:path";

import type { JsonObject } from "@muse/shared";

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

// Move a present-but-corrupt store aside so the next write starts
// fresh WITHOUT destroying the user's prior objectives. Best-effort;
// the bytes survive at `<file>.corrupt-<ts>` for manual recovery.
async function quarantineCorruptStore(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.corrupt-${Date.now().toString()}`);
  } catch {
    // ignore — read still degrades to empty either way
  }
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
  const payload = `${JSON.stringify({ objectives }, null, 2)}\n`;
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  // fsync before rename: a crash can otherwise commit the rename
  // pointing at a zero-length / partial file (metadata and data
  // journal separately).
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
 * Register a standing objective. Reads the existing list, appends,
 * writes atomically. Idempotent on `id`: an entry whose `id`
 * already exists is REPLACED (re-registering the same objective
 * updates its spec/status without duplicating).
 */
export async function addObjective(file: string, objective: StandingObjective): Promise<void> {
  const existing = await readObjectives(file);
  const filtered = existing.filter((entry) => entry.id !== objective.id);
  await writeObjectives(file, [...filtered, objective]);
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
