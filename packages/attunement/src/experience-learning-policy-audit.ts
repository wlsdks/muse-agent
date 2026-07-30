import { sha256Hex } from "@muse/shared";

import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { ExperienceLearningPolicyAudit } from "./types.js";

export type ExperienceLearningPolicyAuditInput = Omit<ExperienceLearningPolicyAudit, "id">;

export function buildExperienceLearningPolicyAudit(
  input: ExperienceLearningPolicyAuditInput
): ExperienceLearningPolicyAudit {
  const core: ExperienceLearningPolicyAuditInput = {
    activeBehaviorDigestAfter: input.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: input.activeBehaviorDigestBefore,
    authority: input.authority,
    candidateId: input.candidateId,
    kind: input.kind,
    occurredAt: input.occurredAt,
    policyAfter: input.policyAfter,
    policyBefore: input.policyBefore,
    sourceId: input.sourceId,
    threadId: input.threadId
  };
  return Object.freeze({
    ...core,
    id: `learning_policy_audit_${sha256Hex(JSON.stringify(core))}`
  });
}

export function isValidExperienceLearningPolicyAudit(
  value: ExperienceLearningPolicyAudit
): boolean {
  return value.authority === "owner-explicit"
    && value.policyAfter.version > value.policyBefore.version
    && fingerprintContinuityPolicy(value.policyBefore) === value.activeBehaviorDigestBefore
    && fingerprintContinuityPolicy(value.policyAfter) === value.activeBehaviorDigestAfter
    && buildExperienceLearningPolicyAudit(value).id === value.id;
}
