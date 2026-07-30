import { createHash } from "node:crypto";

import {
  createExperienceLearningPromotionHandle,
  fingerprintContinuityPolicy,
  type AttunementState,
  type ContinuityPolicy,
  type ExperienceLearningPolicyAudit,
  type ExperienceLearningPromotionHandle
} from "@muse/attunement";
import { describe, expect, it } from "vitest";

import {
  EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION,
  ExperienceLearningLineageProjectionError,
  projectExperienceLearningLineage
} from "./continuity-projection.js";

const THREAD_ID = "thread-loop";
const SOURCE_ID = "attunement-state";
const POLICY_BEFORE = Object.freeze({
  detail: "standard",
  nextStep: "contextual",
  suppression: "none",
  version: 1
} as const);
const POLICY_PROMOTED = Object.freeze({
  detail: "compact",
  nextStep: "direct",
  suppression: "acknowledge-previous",
  version: 2
} as const);
const POLICY_ROLLED_BACK = Object.freeze({
  ...POLICY_BEFORE,
  version: 3
} as const);

function audit(
  input: Omit<ExperienceLearningPolicyAudit, "id">
): ExperienceLearningPolicyAudit {
  const core = {
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
    id: `learning_policy_audit_${createHash("sha256")
      .update(JSON.stringify(core))
      .digest("hex")}`
  });
}

function promotionLineage(options: {
  readonly appliedAt?: string;
  readonly candidateId?: string;
  readonly threadId?: string;
} = {}): {
  readonly audit: ExperienceLearningPolicyAudit;
  readonly handle: ExperienceLearningPromotionHandle;
} {
  const appliedAt = options.appliedAt ?? "2026-07-30T00:00:01.000Z";
  const candidateId = options.candidateId ?? "candidate-loop-1";
  const threadId = options.threadId ?? THREAD_ID;
  const promotionAudit = audit({
    activeBehaviorDigestAfter: fingerprintContinuityPolicy(POLICY_PROMOTED),
    activeBehaviorDigestBefore: fingerprintContinuityPolicy(POLICY_BEFORE),
    authority: "owner-explicit",
    candidateId,
    kind: "promotion",
    occurredAt: appliedAt,
    policyAfter: POLICY_PROMOTED,
    policyBefore: POLICY_BEFORE,
    sourceId: candidateId,
    threadId
  });
  const handle = createExperienceLearningPromotionHandle({
    activeBehaviorDigestAfter: promotionAudit.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: promotionAudit.activeBehaviorDigestBefore,
    appliedAt,
    authority: "owner-explicit",
    candidateId,
    policyAfter: POLICY_PROMOTED,
    policyBefore: POLICY_BEFORE,
    promotionAuditId: promotionAudit.id,
    promotionId: `learning_promotion_${"b".repeat(64)}`,
    threadId
  });
  if (!handle) throw new Error("test promotion handle was invalid");
  return { audit: promotionAudit, handle };
}

function thread(policy: ContinuityPolicy, id = THREAD_ID) {
  return {
    createdAt: "2026-07-29T00:00:00.000Z",
    id,
    kind: "work" as const,
    links: [],
    policy,
    title: "Loop engineering"
  };
}

function legacyState(): AttunementState {
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 12,
    threads: [thread({
      detail: "standard",
      nextStep: "direct",
      suppression: "none",
      version: 0
    })],
    undoResetReceipts: []
  };
}

function promotionState(options: {
  readonly appliedAt?: string;
  readonly candidateId?: string;
} = {}): AttunementState {
  const lineage = promotionLineage(options);
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [lineage.audit],
    experienceLearningPromotionHandles: [lineage.handle],
    interactionReceipts: [],
    nextPolicyVersion: 3,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [thread(POLICY_PROMOTED)],
    undoResetReceipts: []
  };
}

function rollbackState(): AttunementState {
  const promotion = promotionLineage();
  const rollbackAudit = audit({
    activeBehaviorDigestAfter:
      fingerprintContinuityPolicy(POLICY_ROLLED_BACK),
    activeBehaviorDigestBefore:
      fingerprintContinuityPolicy(POLICY_PROMOTED),
    authority: "owner-explicit",
    candidateId: promotion.audit.candidateId,
    kind: "rollback",
    occurredAt: "2026-07-30T00:05:00.000Z",
    policyAfter: POLICY_ROLLED_BACK,
    policyBefore: POLICY_PROMOTED,
    sourceId: promotion.audit.id,
    threadId: THREAD_ID
  });
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [promotion.audit, rollbackAudit],
    experienceLearningPromotionHandles: [promotion.handle],
    interactionReceipts: [],
    nextPolicyVersion: 4,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [thread(POLICY_ROLLED_BACK)],
    undoResetReceipts: []
  };
}

function project(state: unknown) {
  return projectExperienceLearningLineage({
    scope: { sourceId: SOURCE_ID, threadId: THREAD_ID },
    state
  });
}

describe("experience-learning lineage projection", () => {
  it("returns a deterministic frozen empty projection for legacy state", () => {
    const first = project(legacyState());
    const second = project(legacyState());

    expect(first).toEqual(second);
    expect(first.assertions).toEqual([]);
    expect(first.ruleVersion)
      .toBe(EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION);
    expect(first.sourceVersion).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.assertions)).toBe(true);
  });

  it("projects exact promotion revision, support, and correlation evidence", () => {
    const projection = project(promotionState());

    expect(projection.assertions.map((assertion) => assertion.predicate).sort())
      .toEqual(["CORRELATES_WITH", "REVISION_OF", "SUPPORTED_BY"]);
    expect(projection.assertions.flatMap((assertion) =>
      assertion.sourceRefs.map((source) => source.namespace)))
      .toEqual(expect.arrayContaining([
        "muse.attunement.learning-policy-audit",
        "muse.attunement.learning-promotion-handle"
      ]));
    expect(projection.assertions.every((assertion) =>
      assertion.epistemicClass === "source-observed"
      && assertion.derivation.kind === "projection"
      && assertion.derivation.version
        === EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION
      && assertion.recordedAt === "2026-07-30T00:00:01.000Z"
      && assertion.validFrom === assertion.recordedAt)).toBe(true);
    expect(projection.assertions.every(Object.isFrozen)).toBe(true);
    expect(projection.assertions.every((assertion) =>
      Object.isFrozen(assertion.sourceRefs))).toBe(true);
  });

  it("correlates rollback evidence to the original promotion lineage", () => {
    const projection = project(rollbackState());
    const rollbacks = projection.assertions.filter((assertion) =>
      assertion.recordedAt === "2026-07-30T00:05:00.000Z");

    expect(projection.assertions).toHaveLength(6);
    expect(rollbacks.map((assertion) => assertion.predicate).sort())
      .toEqual(["CORRELATES_WITH", "REVISION_OF", "SUPPORTED_BY"]);
    expect(rollbacks.every((assertion) =>
      assertion.sourceRefs.length === 3)).toBe(true);
    const correlation = rollbacks.find((assertion) =>
      assertion.predicate === "CORRELATES_WITH");
    expect(correlation).toMatchObject({
      object: { kind: "evidence" },
      subject: { kind: "evidence" }
    });
  });

  it("never turns lineage into authority, execution, or a new proposal", () => {
    const forbidden = new Set([
      "AUTHORIZED_BY",
      "PERFORMED",
      "PROPOSES_POLICY"
    ]);

    expect(project(rollbackState()).assertions.some((assertion) =>
      forbidden.has(assertion.predicate))).toBe(false);
  });

  it("changes source identity when exact valid lineage content changes", () => {
    const first = project(promotionState());
    const second = project(promotionState({
      appliedAt: "2026-07-30T00:00:02.000Z",
      candidateId: "candidate-loop-2"
    }));

    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    expect(second.assertions.map((assertion) => assertion.id))
      .not.toEqual(first.assertions.map((assertion) => assertion.id));
  });

  it("fails closed on tampered, duplicate, or cross-thread lineage", () => {
    const valid = promotionState();
    const persisted = valid.experienceLearningPromotionHandles?.[0];
    expect(persisted).toBeDefined();
    const tampered = {
      ...valid,
      experienceLearningPromotionHandles: [{
        ...persisted,
        promotionId: `learning_promotion_${"c".repeat(64)}`
      }]
    };
    expect(() => project(tampered)).toThrow(
      ExperienceLearningLineageProjectionError
    );

    expect(() => project({
      ...valid,
      experienceLearningPromotionHandles: [persisted, persisted]
    })).toThrow(ExperienceLearningLineageProjectionError);

    const other = promotionLineage({ threadId: "thread-other" });
    expect(() => project({
      ...valid,
      experienceLearningPromotionHandles: [other.handle],
      threads: [...valid.threads, thread(POLICY_PROMOTED, "thread-other")]
    })).toThrow(ExperienceLearningLineageProjectionError);
  });
});
