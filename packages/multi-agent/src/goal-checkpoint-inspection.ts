import { Buffer } from "node:buffer";

import {
  assessGoalCheckpointResume,
  createGoalCheckpointBinding,
  type GoalCheckpointBinding,
  type GoalCheckpointBindingInput
} from "./goal-checkpoint-binding.js";

const MAX_CHECKPOINT_TEXT_BYTES = 64 * 1024;

export type GoalCheckpointInspection =
  | {
      readonly decision: "refused";
      readonly reason: "corrupt-checkpoint";
      readonly recovery: "preserve-and-recreate";
    }
  | {
      readonly decision: "refused";
      readonly detail: "plan-mismatch" | "pending-effect-mismatch";
      readonly reason: "stale-checkpoint";
      readonly recovery: "review-plan-and-pending-effects";
    }
  | {
      readonly decision: "resume-ready";
      readonly pendingEffectIds: readonly string[];
      readonly planDigest: string;
    };

const CORRUPT_CHECKPOINT = Object.freeze({
  decision: "refused",
  reason: "corrupt-checkpoint",
  recovery: "preserve-and-recreate"
} as const);

/**
 * Inspect persisted checkpoint JSON without repairing, quarantining, or
 * rewriting it. Corrupt and stale checkpoints remain owner-recoverable.
 */
export function inspectGoalCheckpointResume(
  checkpointText: string,
  current: GoalCheckpointBindingInput
): GoalCheckpointInspection {
  // Validate current state before any checkpoint-text early return: a malformed
  // caller expectation is a programming error, never checkpoint corruption.
  const canonicalCurrent = createGoalCheckpointBinding(current);
  if (
    typeof checkpointText !== "string"
    || checkpointText.length === 0
    || Buffer.byteLength(checkpointText, "utf8") > MAX_CHECKPOINT_TEXT_BYTES
  ) {
    return CORRUPT_CHECKPOINT;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(checkpointText) as unknown;
  } catch {
    return CORRUPT_CHECKPOINT;
  }

  let decision;
  try {
    decision = assessGoalCheckpointResume(
      parsed as GoalCheckpointBinding,
      {
        pendingEffectIds: canonicalCurrent.pendingEffectIds,
        planDigest: canonicalCurrent.planDigest
      }
    );
  } catch {
    return CORRUPT_CHECKPOINT;
  }
  if (decision.decision === "refused") {
    return Object.freeze({
      decision: "refused",
      detail: decision.reason,
      reason: "stale-checkpoint",
      recovery: "review-plan-and-pending-effects"
    });
  }
  return decision;
}
