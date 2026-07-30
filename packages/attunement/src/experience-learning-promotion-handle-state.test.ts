import { describe, expect, it } from "vitest";

import { buildExperienceLearningPolicyAudit } from "./experience-learning-policy-audit.js";
import {
  createExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import {
  AttunementStateValidationError,
  parseAttunementState
} from "./state-validation.js";

const policyBefore = {
  detail: "standard",
  nextStep: "contextual",
  suppression: "none",
  version: 1
} as const;
const policyAfter = {
  detail: "compact",
  nextStep: "direct",
  suppression: "acknowledge-previous",
  version: 2
} as const;
const appliedAt = "2026-07-30T00:00:01.000Z";
const candidateId = "experience_candidate_1";
const threadId = "thread-1";
const promotionAudit = buildExperienceLearningPolicyAudit({
  activeBehaviorDigestAfter: fingerprintContinuityPolicy(policyAfter),
  activeBehaviorDigestBefore: fingerprintContinuityPolicy(policyBefore),
  authority: "owner-explicit",
  candidateId,
  kind: "promotion",
  occurredAt: appliedAt,
  policyAfter,
  policyBefore,
  sourceId: candidateId,
  threadId
});

function handle(overrides: Record<string, unknown> = {}) {
  return createExperienceLearningPromotionHandle({
    activeBehaviorDigestAfter: promotionAudit.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: promotionAudit.activeBehaviorDigestBefore,
    appliedAt,
    authority: "owner-explicit",
    candidateId,
    policyAfter,
    policyBefore,
    promotionAuditId: promotionAudit.id,
    promotionId: `learning_promotion_${"b".repeat(64)}`,
    threadId,
    ...overrides
  })!;
}

function state13(overrides: Record<string, unknown> = {}) {
  return {
    deliveries: [],
    experienceLearningPolicyAudits: [promotionAudit],
    experienceLearningPromotionHandles: [handle()],
    interactionReceipts: [],
    nextPolicyVersion: 3,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: threadId,
      kind: "work",
      links: [],
      policy: policyAfter,
      title: "Loop engineering"
    }],
    undoResetReceipts: [],
    ...overrides
  };
}

describe("persisted experience-learning promotion handles", () => {
  it("normalizes legacy schema v12 with an empty handle collection", () => {
    const parsed = parseAttunementState({
      deliveries: [],
      experienceLearningPolicyAudits: [],
      interactionReceipts: [],
      nextPolicyVersion: 1,
      resetReceipts: [],
      schemaVersion: 12,
      threads: [],
      undoResetReceipts: []
    });

    expect(parsed).toMatchObject({
      experienceLearningPromotionHandles: [],
      schemaVersion: 13
    });
  });

  it("accepts a content-bound handle with an exact promotion audit binding", () => {
    const parsed = parseAttunementState(state13());

    expect(parsed.experienceLearningPromotionHandles).toEqual([handle()]);
    expect(Object.isFrozen(
      parsed.experienceLearningPromotionHandles?.[0]?.policyAfter
    )).toBe(true);
  });

  it("requires the handle collection and rejects duplicate lineage", () => {
    const missing = { ...state13() };
    delete (missing as Record<string, unknown>)
      .experienceLearningPromotionHandles;

    expect(() => parseAttunementState(missing))
      .toThrow(AttunementStateValidationError);
    expect(() => parseAttunementState(state13({
      experienceLearningPromotionHandles: [handle(), handle()]
    }))).toThrow(/duplicate experience learning promotion handle ids/u);
  });

  it("rejects a valid handle that does not bind the persisted audit", () => {
    const unbound = handle({
      candidateId: "experience_candidate_2"
    });

    expect(() => parseAttunementState(state13({
      experienceLearningPromotionHandles: [unbound]
    }))).toThrow(/invalid promotion audit binding/u);
  });

  it("rejects a tampered content-bound handle", () => {
    const tampered = {
      ...handle(),
      appliedAt: "2026-07-30T00:00:02.000Z"
    };

    expect(() => parseAttunementState(state13({
      experienceLearningPromotionHandles: [tampered]
    }))).toThrow(AttunementStateValidationError);
  });
});
