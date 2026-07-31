import { describe, expect, it } from "vitest";

import {
  projectExperienceLearningDegradationFromState
} from "./experience-learning-degradation-state.js";
import {
  createExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";
import { continuityOutcomeId } from "./outcome-id.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type {
  AttunementState,
  ContinuityDelivery,
  ContinuityOutcome
} from "./types.js";

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
const appliedAt = "2026-07-30T12:00:00.000Z";
const handle = createExperienceLearningPromotionHandle({
  activeBehaviorDigestAfter: fingerprintContinuityPolicy(policyAfter),
  activeBehaviorDigestBefore: fingerprintContinuityPolicy(policyBefore),
  appliedAt,
  authority: "owner-explicit",
  candidateId: "candidate-1",
  policyAfter,
  policyBefore,
  promotionAuditId: `learning_policy_audit_${"a".repeat(64)}`,
  promotionId: `learning_promotion_${"b".repeat(64)}`,
  threadId: "thread-1"
})!;

function delivery(
  kind: "baseline" | "promoted",
  index: number,
  outcome: ContinuityOutcome,
  overrides: Partial<ContinuityDelivery> = {}
): ContinuityDelivery {
  const hour = kind === "baseline" ? index + 1 : index + 13;
  const policy = kind === "baseline" ? policyBefore : policyAfter;
  const deliveryId = `${kind}-delivery-${index}`;
  const recordedAt =
    `2026-07-30T${hour.toString().padStart(2, "0")}:30:00.000Z`;
  const evidenceClass = "organic" as const;
  const outcomeId = continuityOutcomeId({
    deliveryId,
    evidenceClass,
    outcome,
    recordedAt
  });
  return {
    evidenceClass,
    evidenceRefs: [],
    id: deliveryId,
    openedAt: `2026-07-30T${hour.toString().padStart(2, "0")}:00:00.000Z`,
    outcome: {
      authority: "owner-explicit",
      evidenceClass,
      id: outcomeId,
      outcome,
      policyVersion: policy.version + index + 10,
      recordedAt
    },
    policyDigest: fingerprintContinuityPolicy(policy),
    policyVersion: policy.version,
    threadId: handle.threadId,
    ...overrides
  };
}

function state(deliveries: readonly ContinuityDelivery[]): AttunementState {
  return {
    deliveries,
    experienceLearningPolicyAudits: [],
    experienceLearningPromotionHandles: [handle],
    interactionReceipts: [],
    nextPolicyVersion: 3,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [],
    undoResetReceipts: []
  };
}

describe("projectExperienceLearningDegradationFromState", () => {
  it("uses the latest five baseline and first five promoted organic outcomes", () => {
    const baseline = [
      "rejected",
      "used",
      "used",
      "used",
      "used",
      "adjusted"
    ].map((outcome, index) =>
      delivery("baseline", index, outcome as ContinuityOutcome));
    const promoted = [
      "used",
      "adjusted",
      "ignored",
      "ignored",
      "rejected",
      "used",
      "used"
    ].map((outcome, index) =>
      delivery("promoted", index, outcome as ContinuityOutcome));

    const result = projectExperienceLearningDegradationFromState(
      state([...promoted].reverse().concat([...baseline].reverse())),
      handle.handleId
    );

    expect(result).toMatchObject({
      baseline: { rejected: 0, total: 5, used: 4 },
      promoted: { rejected: 1, total: 5, used: 1 },
      reason: "post-promotion-regression",
      status: "propose-rollback"
    });
  });

  it("excludes controlled, unclassified, legacy, and mismatched policy evidence", () => {
    const baseline = [
      delivery("baseline", 1, "used"),
      delivery("baseline", 2, "used", { evidenceClass: "controlled" }),
      delivery("baseline", 3, "used", {
        outcome: {
          ...delivery("baseline", 3, "used").outcome!,
          evidenceClass: "unclassified"
        }
      }),
      delivery("baseline", 4, "used", { policyDigest: "0".repeat(64) }),
      delivery("baseline", 5, "used", {
        outcome: {
          ...delivery("baseline", 5, "used").outcome!,
          id: undefined
        }
      }),
      delivery("baseline", 6, "used", {
        outcome: {
          ...delivery("baseline", 6, "used").outcome!,
          policyVersion: policyBefore.version
        }
      })
    ];
    const result = projectExperienceLearningDegradationFromState(
      state(baseline),
      handle.handleId
    );

    expect(result).toMatchObject({
      baseline: { total: 1, used: 1 },
      promoted: { total: 0 },
      reason: "insufficient-window",
      status: "hold"
    });
  });

  it("returns no assessment for an absent or ambiguous handle", () => {
    const snapshot = state([]);
    expect(projectExperienceLearningDegradationFromState(
      snapshot,
      `learning_promotion_handle_${"f".repeat(64)}`
    )).toBeUndefined();
    expect(projectExperienceLearningDegradationFromState({
      ...snapshot,
      experienceLearningPromotionHandles: [handle, handle]
    }, handle.handleId)).toBeUndefined();
  });
});
