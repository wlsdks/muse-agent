import {
  createExperienceLearningPromotionHandle,
  fingerprintContinuityPolicy,
  type ExperienceLearningPromotionHandle,
  type ExperienceLearningPromotionReceipt
} from "@muse/attunement";
import { sha256Hex } from "@muse/shared";

export function experienceLearningPromotionReceipt(
  appliedAt: string,
  suffix = "fixture"
): ExperienceLearningPromotionReceipt {
  const approvedAt = "2026-07-30T00:00:00.000Z";
  const candidateId = `candidate-${suffix}`;
  const policyBefore = {
    detail: "standard" as const,
    nextStep: "direct" as const,
    suppression: "none" as const,
    version: 0
  };
  const policyAfter = {
    detail: "compact" as const,
    nextStep: "contextual" as const,
    suppression: "none" as const,
    version: 1
  };
  const proposedBehavior = `Use compact presentation ${suffix}`;
  const proposedChange = {
    detail: "compact" as const,
    kind: "thread-display" as const,
    nextStep: "contextual" as const
  };
  const replayInputHash = "b".repeat(64);
  const scope = {
    kind: "thread-display" as const,
    threadId: `thread-${suffix}`
  };
  const activeBehaviorDigestBefore = fingerprintContinuityPolicy(policyBefore);
  const activeBehaviorDigestAfter = fingerprintContinuityPolicy(policyAfter);
  const promotionId = `learning_promotion_${sha256Hex(JSON.stringify([
    candidateId,
    replayInputHash,
    activeBehaviorDigestBefore,
    activeBehaviorDigestAfter,
    scope.kind,
    scope.threadId,
    proposedBehavior,
    proposedChange,
    approvedAt,
    appliedAt
  ]))}`;

  return Object.freeze({
    activeBehaviorDigestAfter,
    activeBehaviorDigestBefore,
    appliedAt,
    approvedAt,
    authority: "owner-explicit",
    candidateId,
    policyAfter: Object.freeze(policyAfter),
    policyBefore: Object.freeze(policyBefore),
    promotionApplied: true,
    promotionId,
    proposedBehavior,
    proposedChange: Object.freeze(proposedChange),
    replayInputHash,
    schemaVersion: 2,
    scope: Object.freeze(scope)
  });
}

export function experienceLearningPromotionHandle(
  receipt: ExperienceLearningPromotionReceipt
): ExperienceLearningPromotionHandle {
  const auditCore = {
    activeBehaviorDigestAfter: receipt.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: receipt.activeBehaviorDigestBefore,
    authority: "owner-explicit" as const,
    candidateId: receipt.candidateId,
    kind: "promotion" as const,
    occurredAt: receipt.appliedAt,
    policyAfter: receipt.policyAfter,
    policyBefore: receipt.policyBefore,
    sourceId: receipt.candidateId,
    threadId: receipt.scope.threadId
  };
  const handle = createExperienceLearningPromotionHandle({
    activeBehaviorDigestAfter: receipt.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: receipt.activeBehaviorDigestBefore,
    appliedAt: receipt.appliedAt,
    authority: receipt.authority,
    candidateId: receipt.candidateId,
    policyAfter: receipt.policyAfter,
    policyBefore: receipt.policyBefore,
    promotionAuditId: `learning_policy_audit_${sha256Hex(JSON.stringify(auditCore))}`,
    promotionId: receipt.promotionId,
    threadId: receipt.scope.threadId
  });
  if (!handle) throw new Error("expected a valid promotion handle fixture");
  return handle;
}
