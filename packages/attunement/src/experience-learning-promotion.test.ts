import { describe, expect, it } from "vitest";

import {
  ActiveAttunementPolicyWriteBlockedError,
  compareExperienceLearningReplay,
  ExperienceLearningPromotionError,
  fingerprintContinuityPolicy,
  promoteExperienceLearningCandidate,
  proposeExperienceLearningCandidate,
  rollbackExperienceLearningPromotion,
  type ActiveAttunementPolicyWriteGate,
  type ExperienceLearningCandidate,
  type ExperienceLearningPromotionInput,
  type ExperienceReplayCase,
  type ContinuityPolicy
} from "./index.js";

const digest = (character: string) => character.repeat(64);
const gate: ActiveAttunementPolicyWriteGate = {
  run: async (operation) => operation()
};

const CURRENT_POLICY: ContinuityPolicy = {
  detail: "standard",
  nextStep: "direct",
  suppression: "none",
  version: 4
};

function candidate(): ExperienceLearningCandidate {
  return proposeExperienceLearningCandidate({
    activeBehaviorDigest: fingerprintContinuityPolicy(CURRENT_POLICY),
    expectedBenefit: "Reduce interruptions.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-1",
    outcome: {
      authority: "owner-explicit",
      outcome: "rejected",
      outcomeId: "outcome-1",
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-1"
    },
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Offer only during an explicit review window.",
    proposedChange: {
      detail: "compact",
      kind: "thread-display",
      nextStep: "contextual"
    },
    scope: { kind: "thread-display", threadId: "thread-1" },
    sourceRun: {
      behaviorDigest: digest("b"),
      completedAt: "2026-07-29T03:00:00.000Z",
      evidenceClass: "controlled",
      runId: "run-1"
    }
  })!;
}

function cases(total = 10): ExperienceReplayCase[] {
  return Array.from({ length: total }, (_, index) => ({
    baseline: { evidenceHash: digest("c"), passed: index !== 0 },
    caseId: `case-${index}`,
    challenger: { evidenceHash: digest("d"), passed: true }
  }));
}

function promotionInput(total = 10): ExperienceLearningPromotionInput {
  const learningCandidate = candidate();
  const replayCases = cases(total);
  const replay = compareExperienceLearningReplay(learningCandidate, replayCases)!;
  return {
    approval: {
      approvedAt: "2026-07-29T03:07:00.000Z",
      authority: "owner-explicit",
      candidateId: learningCandidate.candidateId,
      replayInputHash: replay.inputHash
    },
    appliedAt: "2026-07-29T03:08:00.000Z",
    candidate: learningCandidate,
    currentPolicy: CURRENT_POLICY,
    nextPolicyVersion: 5,
    replay,
    replayCases
  };
}

function inMemoryCas(initial: ContinuityPolicy) {
  let current = initial;
  return {
    current: () => current,
    swap: async ({ expectedDigest, nextDigest, policyAfter, policyBefore }: {
      readonly expectedDigest: string;
      readonly nextDigest: string;
      readonly policyAfter: ContinuityPolicy;
      readonly policyBefore: ContinuityPolicy;
    }) => {
      if (fingerprintContinuityPolicy(current) !== expectedDigest
        || fingerprintContinuityPolicy(policyBefore) !== expectedDigest
        || fingerprintContinuityPolicy(policyAfter) !== nextDigest) return false;
      current = policyAfter;
      return true;
    }
  };
}

describe("experience learning promotion", () => {
  it("applies one owner-approved 10-case improvement and emits an exact receipt", async () => {
    const input = promotionInput();
    const policy = inMemoryCas(CURRENT_POLICY);

    const receipt = await promoteExperienceLearningCandidate(input, gate, policy.swap);

    expect(receipt).toMatchObject({
      activeBehaviorDigestBefore: input.candidate.activeBehaviorDigestBefore,
      authority: "owner-explicit",
      candidateId: input.candidate.candidateId,
      promotionApplied: true,
      proposedChange: {
        detail: "compact",
        kind: "thread-display",
        nextStep: "contextual"
      },
      replayInputHash: input.replay.inputHash,
      schemaVersion: 2
    });
    expect(receipt.activeBehaviorDigestAfter).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.activeBehaviorDigestAfter).not.toBe(receipt.activeBehaviorDigestBefore);
    expect(receipt.activeBehaviorDigestAfter).toBe(fingerprintContinuityPolicy(receipt.policyAfter));
    expect(policy.current()).toEqual(receipt.policyAfter);
  });

  it("fails before mutation for insufficient, regressing, tampered, expired, or mismatched evidence", async () => {
    const tooSmall = promotionInput(9);
    const regressing = promotionInput();
    const regressionCases = [...regressing.replayCases];
    regressionCases[1] = {
      ...regressionCases[1]!,
      challenger: { evidenceHash: digest("e"), passed: false }
    };
    const expired = { ...promotionInput(), appliedAt: "2026-08-01T00:00:00.000Z" };
    const mismatched = promotionInput();
    const wrongApproval = {
      ...mismatched,
      approval: { ...mismatched.approval, replayInputHash: digest("f") }
    };
    let calls = 0;
    const never = async () => {
      calls += 1;
      return true;
    };

    await expect(promoteExperienceLearningCandidate(tooSmall, gate, never))
      .rejects.toMatchObject({ code: "insufficient-evidence" });
    await expect(promoteExperienceLearningCandidate(
      { ...regressing, replayCases: regressionCases },
      gate,
      never
    )).rejects.toMatchObject({ code: "ineligible-replay" });
    await expect(promoteExperienceLearningCandidate(
      { ...mismatched, replay: { ...mismatched.replay, aggregate: { ...mismatched.replay.aggregate, improvements: 9 } } },
      gate,
      never
    )).rejects.toMatchObject({ code: "ineligible-replay" });
    await expect(promoteExperienceLearningCandidate(expired, gate, never))
      .rejects.toMatchObject({ code: "candidate-expired" });
    await expect(promoteExperienceLearningCandidate(wrongApproval, gate, never))
      .rejects.toMatchObject({ code: "invalid-approval" });
    expect(calls).toBe(0);
  });

  it("requires the write gate and an atomic match of the active digest", async () => {
    const input = promotionInput();
    const policy = inMemoryCas({ ...CURRENT_POLICY, version: 3 });

    await expect(promoteExperienceLearningCandidate(input, undefined, policy.swap))
      .rejects.toBeInstanceOf(ActiveAttunementPolicyWriteBlockedError);
    await expect(promoteExperienceLearningCandidate(input, gate, policy.swap))
      .rejects.toMatchObject({ code: "stale-active-policy" });
    expect(policy.current()).toEqual({ ...CURRENT_POLICY, version: 3 });
  });

  it("rolls back only the exact promoted digest and rejects a forged receipt", async () => {
    const input = promotionInput();
    const policy = inMemoryCas(CURRENT_POLICY);
    const receipt = await promoteExperienceLearningCandidate(input, gate, policy.swap);

    const rollback = await rollbackExperienceLearningPromotion(
      receipt,
      "2026-07-29T03:09:00.000Z",
      6,
      gate,
      policy.swap
    );

    expect(rollback).toMatchObject({
      activeBehaviorDigestBefore: receipt.activeBehaviorDigestAfter,
      policyAfter: {
        detail: CURRENT_POLICY.detail,
        nextStep: CURRENT_POLICY.nextStep,
        suppression: CURRENT_POLICY.suppression,
        version: 6
      },
      promotionId: receipt.promotionId,
      rollbackApplied: true,
      schemaVersion: 2
    });
    expect(policy.current()).toEqual(rollback.policyAfter);
    expect(rollback.activeBehaviorDigestAfter).toBe(fingerprintContinuityPolicy(rollback.policyAfter));

    await expect(rollbackExperienceLearningPromotion(
      receipt,
      "2026-07-29T03:10:00.000Z",
      7,
      gate,
      policy.swap
    )).rejects.toBeInstanceOf(ExperienceLearningPromotionError);
    await expect(rollbackExperienceLearningPromotion(
      { ...receipt, promotionId: "forged" },
      "2026-07-29T03:10:00.000Z",
      7,
      gate,
      policy.swap
    )).rejects.toMatchObject({ code: "invalid-input" });
    await expect(rollbackExperienceLearningPromotion(
      { ...receipt, proposedBehavior: "Tampered behavior." },
      "2026-07-29T03:10:00.000Z",
      7,
      gate,
      policy.swap
    )).rejects.toMatchObject({ code: "invalid-input" });
    await expect(rollbackExperienceLearningPromotion(
      {
        ...receipt,
        proposedChange: {
          kind: "thread-suppression",
          suppression: "acknowledge-previous"
        }
      },
      "2026-07-29T03:10:00.000Z",
      7,
      gate,
      policy.swap
    )).rejects.toMatchObject({ code: "invalid-input" });
    await expect(rollbackExperienceLearningPromotion(
      { ...receipt, scope: { ...receipt.scope, kind: "thread-suppression" } },
      "2026-07-29T03:10:00.000Z",
      7,
      gate,
      policy.swap
    )).rejects.toMatchObject({ code: "invalid-input" });
  });
});
