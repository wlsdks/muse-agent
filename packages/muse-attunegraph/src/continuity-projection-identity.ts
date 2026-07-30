import { createHash } from "node:crypto";

import type {
  ArtifactLink,
  ArtifactReference,
  ContinuityPolicy,
  ExperienceLearningPolicyAudit,
  ExperienceLearningPromotionHandle
} from "@muse/attunement";

import type { GraphEvidenceRef, GraphRef } from "@attunegraph/core";

export const CONTINUITY_SOURCE_NAMESPACES = Object.freeze({
  artifactLink: "muse.attunement.artifact-link",
  delivery: "muse.attunement.delivery",
  deliveryEvidence: "muse.attunement.delivery-evidence",
  interaction: "muse.attunement.interaction",
  learningPolicyAudit: "muse.attunement.learning-policy-audit",
  learningPromotionHandle: "muse.attunement.learning-promotion-handle",
  outcome: "muse.attunement.outcome",
  policyReset: "muse.attunement.policy-reset",
  policyUndo: "muse.attunement.policy-undo",
  thread: "muse.attunement.thread",
  threadPolicy: "muse.attunement.thread-policy"
} as const);

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError("canonical identity data contains a non-finite number");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  throw new TypeError("canonical identity data contains an unsupported value");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function opaqueId(kind: string, material: unknown): string {
  return `muse-continuity-${kind}:${digest(material).slice("sha256:".length)}`;
}

function graphRef(kind: GraphRef["kind"], material: unknown): GraphRef {
  return Object.freeze({ id: opaqueId(kind, material), kind });
}

function sourceRef(
  namespace: string,
  sourceId: string,
  identity: unknown,
  versionView: unknown
): GraphEvidenceRef {
  return Object.freeze({
    id: opaqueId("source", { identity, namespace, sourceId }),
    namespace,
    version: digest(versionView)
  });
}

function artifactIdentity(reference: ArtifactReference): object {
  return {
    artifactId: reference.artifactId,
    artifactType: reference.artifactType,
    providerId: reference.providerId
  };
}

function artifactReferenceView(reference: ArtifactReference): object {
  return {
    ...artifactIdentity(reference),
    role: reference.role
  };
}

function policyView(policy: ContinuityPolicy): object {
  return {
    detail: policy.detail,
    nextStep: policy.nextStep,
    suppression: policy.suppression,
    version: policy.version
  };
}

export function experienceLearningPolicyAuditView(
  audit: ExperienceLearningPolicyAudit
): object {
  return {
    activeBehaviorDigestAfter: audit.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: audit.activeBehaviorDigestBefore,
    authority: audit.authority,
    candidateId: audit.candidateId,
    id: audit.id,
    kind: audit.kind,
    occurredAt: audit.occurredAt,
    policyAfter: policyView(audit.policyAfter),
    policyBefore: policyView(audit.policyBefore),
    sourceId: audit.sourceId,
    threadId: audit.threadId
  };
}

export function experienceLearningPromotionHandleView(
  handle: ExperienceLearningPromotionHandle
): object {
  return {
    activeBehaviorDigestAfter: handle.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: handle.activeBehaviorDigestBefore,
    appliedAt: handle.appliedAt,
    authority: handle.authority,
    candidateId: handle.candidateId,
    handleId: handle.handleId,
    policyAfter: policyView(handle.policyAfter),
    policyBefore: policyView(handle.policyBefore),
    promotionAuditId: handle.promotionAuditId,
    promotionId: handle.promotionId,
    schemaVersion: handle.schemaVersion,
    threadId: handle.threadId
  };
}

export function deriveContinuityThreadGraphRef(
  sourceId: string,
  threadId: string
): GraphRef {
  return graphRef("thread", { sourceId, threadId });
}

export function deriveContinuityArtifactGraphRef(
  sourceId: string,
  reference: ArtifactReference
): GraphRef {
  return graphRef("artifact", { sourceId, ...artifactIdentity(reference) });
}

export function deriveContinuityPolicyGraphRef(
  sourceId: string,
  threadId: string,
  version: number
): GraphRef {
  return graphRef("policy", { sourceId, threadId, version });
}

export function deriveExperienceLearningAuditEvidenceGraphRef(
  sourceId: string,
  auditId: string
): GraphRef {
  return graphRef("evidence", {
    auditId,
    sourceId,
    type: "experience-learning-policy-audit"
  });
}

export function deriveExperienceLearningPromotionEvidenceGraphRef(
  sourceId: string,
  handleId: string
): GraphRef {
  return graphRef("evidence", {
    handleId,
    sourceId,
    type: "experience-learning-promotion-handle"
  });
}

export function deriveContinuityArtifactLinkSourceRef(
  sourceId: string,
  scopeThreadId: string,
  link: ArtifactLink,
  canonicalLinkedAt: string
): GraphEvidenceRef {
  return sourceRef(
    CONTINUITY_SOURCE_NAMESPACES.artifactLink,
    sourceId,
    { ...artifactIdentity(link), threadId: scopeThreadId },
    {
      ...artifactReferenceView(link),
      linkedAt: canonicalLinkedAt,
      linkedBy: link.linkedBy,
      threadId: link.threadId
    }
  );
}

export function deriveContinuityPolicySourceRef(
  sourceId: string,
  threadId: string,
  policy: ContinuityPolicy
): GraphEvidenceRef {
  return sourceRef(
    CONTINUITY_SOURCE_NAMESPACES.threadPolicy,
    sourceId,
    { threadId },
    policyView(policy)
  );
}

export function deriveExperienceLearningPolicyAuditSourceRef(
  sourceId: string,
  audit: ExperienceLearningPolicyAudit
): GraphEvidenceRef {
  return sourceRef(
    CONTINUITY_SOURCE_NAMESPACES.learningPolicyAudit,
    sourceId,
    { auditId: audit.id },
    experienceLearningPolicyAuditView(audit)
  );
}

export function deriveExperienceLearningPromotionHandleSourceRef(
  sourceId: string,
  handle: ExperienceLearningPromotionHandle
): GraphEvidenceRef {
  return sourceRef(
    CONTINUITY_SOURCE_NAMESPACES.learningPromotionHandle,
    sourceId,
    { handleId: handle.handleId },
    experienceLearningPromotionHandleView(handle)
  );
}
