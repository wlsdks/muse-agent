import {
  assessExperienceLearningDegradation,
  EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE,
  type ExperienceLearningDegradationAssessment,
  type ExperienceLearningOutcomeEvidence
} from "./experience-learning-degradation.js";
import type { ExperienceLearningPromotionHandle } from "./experience-learning-promotion-handle.js";
import { continuityOutcomeId } from "./outcome-id.js";
import type { AttunementState, ContinuityDelivery } from "./types.js";

/**
 * Selects canonical comparable windows from an already validated Attunement
 * state. It reads only exact organic delivery/outcome pairs and performs no
 * state write, approval, or rollback.
 */
export function projectExperienceLearningDegradationFromState(
  state: AttunementState,
  handleId: string
): ExperienceLearningDegradationAssessment | undefined {
  const handles = (state.experienceLearningPromotionHandles ?? [])
    .filter((handle) => handle.handleId === handleId);
  if (handles.length !== 1) return undefined;
  const handle = handles[0]!;
  const eligible = state.deliveries
    .map((delivery) => projectDelivery(delivery, handle))
    .filter((entry): entry is ExperienceLearningOutcomeEvidence =>
      entry !== undefined)
    .sort(compareEvidence);
  const appliedAt = Date.parse(handle.appliedAt);
  const baseline = eligible
    .filter((entry) =>
      entry.behaviorDigest === handle.activeBehaviorDigestBefore
      && Date.parse(entry.recordedAt) < appliedAt)
    .slice(-EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE);
  const promoted = eligible
    .filter((entry) =>
      entry.behaviorDigest === handle.activeBehaviorDigestAfter
      && Date.parse(entry.recordedAt) >= appliedAt)
    .slice(0, EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE);
  return assessExperienceLearningDegradation({
    baseline,
    handle,
    promoted
  });
}

function projectDelivery(
  delivery: ContinuityDelivery,
  handle: ExperienceLearningPromotionHandle
): ExperienceLearningOutcomeEvidence | undefined {
  const outcome = delivery.outcome;
  if (!outcome
    || delivery.threadId !== handle.threadId
    || delivery.evidenceClass !== "organic"
    || outcome.evidenceClass !== "organic"
    || outcome.authority !== "owner-explicit"
    || typeof outcome.id !== "string"
    || typeof delivery.policyDigest !== "string"
    || outcome.policyVersion <= delivery.policyVersion
    || outcome.id !== continuityOutcomeId({
      deliveryId: delivery.id,
      evidenceClass: outcome.evidenceClass,
      outcome: outcome.outcome,
      ...(outcome.ownerNote ? { ownerNote: outcome.ownerNote } : {}),
      recordedAt: outcome.recordedAt,
      ...(delivery.runId ? { runId: delivery.runId } : {})
    })) {
    return undefined;
  }
  const baseline = delivery.policyVersion === handle.policyBefore.version
    && delivery.policyDigest === handle.activeBehaviorDigestBefore;
  const promoted = delivery.policyVersion === handle.policyAfter.version
    && delivery.policyDigest === handle.activeBehaviorDigestAfter;
  if (!baseline && !promoted) return undefined;
  return Object.freeze({
    authority: "owner-explicit",
    behaviorDigest: delivery.policyDigest,
    deliveryId: delivery.id,
    evidenceClass: "organic-production",
    outcome: outcome.outcome,
    outcomeId: outcome.id,
    recordedAt: outcome.recordedAt,
    threadId: delivery.threadId
  });
}

function compareEvidence(
  left: ExperienceLearningOutcomeEvidence,
  right: ExperienceLearningOutcomeEvidence
): number {
  return left.recordedAt.localeCompare(right.recordedAt)
    || left.outcomeId.localeCompare(right.outcomeId)
    || left.deliveryId.localeCompare(right.deliveryId);
}
