import type { ExperienceLearningChange } from "./experience-learning-candidate.js";
import type { ContinuityPolicy } from "./types.js";

/**
 * Applies only the reviewed Continuity presentation fields. Timing belongs to
 * the separate timing store and therefore cannot be reduced here.
 */
export function reduceExperienceLearningContinuityPolicy(
  current: ContinuityPolicy,
  change: ExperienceLearningChange,
  nextVersion: number
): ContinuityPolicy | undefined {
  if (!Number.isSafeInteger(nextVersion)
    || nextVersion <= current.version
    || change.kind === "thread-timing") {
    return undefined;
  }
  if (change.kind === "thread-display") {
    return Object.freeze({
      ...current,
      detail: change.detail,
      nextStep: change.nextStep,
      version: nextVersion
    });
  }
  return Object.freeze({
    ...current,
    suppression: change.suppression,
    version: nextVersion
  });
}
