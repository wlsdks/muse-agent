import { describe, expect, it } from "vitest";

import {
  assessExperienceLearningDegradation
} from "./experience-learning-degradation.js";
import {
  createExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { ContinuityOutcome } from "./types.js";

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

function handle(threadId = "thread-life") {
  return createExperienceLearningPromotionHandle({
    activeBehaviorDigestAfter: fingerprintContinuityPolicy(policyAfter),
    activeBehaviorDigestBefore: fingerprintContinuityPolicy(policyBefore),
    appliedAt,
    authority: "owner-explicit",
    candidateId: "candidate-1",
    policyAfter,
    policyBefore,
    promotionAuditId: `learning_policy_audit_${"a".repeat(64)}`,
    promotionId: `learning_promotion_${"b".repeat(64)}`,
    threadId
  })!;
}

function window(
  target: ReturnType<typeof handle>,
  kind: "baseline" | "promoted",
  outcomes: readonly ContinuityOutcome[]
) {
  return outcomes.map((outcome, index) => ({
    authority: "owner-explicit" as const,
    behaviorDigest: kind === "baseline"
      ? target.activeBehaviorDigestBefore
      : target.activeBehaviorDigestAfter,
    deliveryId: `${kind}-delivery-${index}`,
    evidenceClass: "organic-production" as const,
    outcome,
    outcomeId: `${kind}-outcome-${index}`,
    recordedAt: kind === "baseline"
      ? `2026-07-30T${(index + 6).toString().padStart(2, "0")}:00:00.000Z`
      : `2026-07-30T${(index + 13).toString()}:00:00.000Z`,
    threadId: target.threadId
  }));
}

describe("assessExperienceLearningDegradation", () => {
  it("holds until both exact organic windows contain five outcomes", () => {
    const promotion = handle();
    const result = assessExperienceLearningDegradation({
      baseline: window(promotion, "baseline", ["used", "used", "adjusted", "ignored"]),
      handle: promotion,
      promoted: window(promotion, "promoted", [
        "rejected",
        "ignored",
        "adjusted",
        "used",
        "rejected"
      ])
    });

    expect(result).toMatchObject({
      baseline: { total: 4 },
      promoted: { total: 5 },
      reason: "insufficient-window",
      requiredOutcomesPerWindow: 5,
      status: "hold"
    });
    expect(result).not.toHaveProperty("proposal");
  });

  it.each(["thread-life", "thread-work"])(
    "creates the same inert exact-handle proposal for %s",
    (threadId) => {
      const promotion = handle(threadId);
      const input = {
        baseline: window(promotion, "baseline", [
          "used",
          "used",
          "used",
          "adjusted",
          "ignored"
        ]),
        handle: promotion,
        promoted: window(promotion, "promoted", [
          "used",
          "adjusted",
          "ignored",
          "rejected",
          "rejected"
        ])
      };

      const first = assessExperienceLearningDegradation(input);
      const second = assessExperienceLearningDegradation(input);

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        baseline: { rejected: 0, total: 5, used: 3 },
        handleId: promotion.handleId,
        promoted: { rejected: 2, total: 5, used: 1 },
        proposal: {
          authority: "none",
          criteriaVersion: 1,
          effectPerformed: false,
          handleId: promotion.handleId,
          ownerApprovalRequired: true,
          proposalId: expect.stringMatching(
            /^learning_rollback_proposal_[a-f0-9]{64}$/u
          ),
          status: "proposed"
        },
        reason: "post-promotion-regression",
        status: "propose-rollback"
      });
    }
  );

  it("holds unless both conservative regression thresholds are crossed", () => {
    const promotion = handle();
    const baseline = window(promotion, "baseline", [
      "used",
      "used",
      "used",
      "adjusted",
      "rejected"
    ]);

    for (const promoted of [
      ["used", "used", "adjusted", "ignored", "rejected"],
      ["used", "adjusted", "ignored", "ignored", "rejected"]
    ] as const) {
      expect(assessExperienceLearningDegradation({
        baseline,
        handle: promotion,
        promoted: window(promotion, "promoted", promoted)
      })).toMatchObject({
        reason: "no-regression",
        status: "hold"
      });
    }
  });

  it("fails closed on unrelated, non-organic, duplicate, malformed, and hostile evidence", () => {
    const promotion = handle();
    const baseline = window(promotion, "baseline", [
      "used",
      "used",
      "used",
      "adjusted",
      "ignored"
    ]);
    const promoted = window(promotion, "promoted", [
      "used",
      "adjusted",
      "ignored",
      "rejected",
      "rejected"
    ]);
    const inputs = [
      { baseline, handle: promotion, promoted: promoted.map((entry, index) =>
        index === 0 ? { ...entry, threadId: "thread-other" } : entry) },
      { baseline, handle: promotion, promoted: promoted.map((entry, index) =>
        index === 0 ? { ...entry, evidenceClass: "controlled" } : entry) },
      { baseline, handle: promotion, promoted: promoted.map((entry, index) =>
        index === 0 ? { ...entry, outcomeId: baseline[0]!.outcomeId } : entry) },
      { baseline, extra: true, handle: promotion, promoted },
      {
        baseline,
        handle: promotion,
        promoted: [...promoted].reverse()
      }
    ];
    for (const input of inputs) {
      expect(assessExperienceLearningDegradation(input)).toBeUndefined();
    }
    expect(assessExperienceLearningDegradation(new Proxy({
      baseline,
      handle: promotion,
      promoted
    }, {}))).toBeUndefined();
  });
});
