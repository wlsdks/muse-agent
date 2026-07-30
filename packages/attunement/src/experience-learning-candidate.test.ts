import { describe, expect, it } from "vitest";

import {
  proposeExperienceLearningCandidate,
  type ProposeExperienceLearningCandidateInput
} from "./experience-learning-candidate.js";

const ACTIVE_DIGEST = "a".repeat(64);
const RUN_DIGEST = "b".repeat(64);

function input(): ProposeExperienceLearningCandidateInput {
  return {
    activeBehaviorDigest: ACTIVE_DIGEST,
    expectedBenefit: "Interrupt less often after a rejected timing offer",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-17",
    outcome: {
      authority: "owner-explicit",
      outcome: "rejected",
      outcomeId: "outcome-17",
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-17"
    },
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Offer this thread only during an explicit review window",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: {
      kind: "thread-timing",
      threadId: "thread-work"
    },
    sourceRun: {
      behaviorDigest: RUN_DIGEST,
      completedAt: "2026-07-29T03:00:00.000Z",
      evidenceClass: "controlled",
      runId: "run-17"
    }
  };
}

describe("experience learning candidate proposal", () => {
  it("requires both one exact source run and one explicit owner outcome", () => {
    expect(proposeExperienceLearningCandidate({ ...input(), sourceRun: undefined })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({ ...input(), outcome: undefined })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      outcome: { ...input().outcome!, runId: "another-run" }
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      outcome: { ...input().outcome!, authority: "model-self-critique" } as never
    })).toBeUndefined();
  });

  it("creates a detached proposal while keeping the active behavior digest unchanged", () => {
    const mutable = input();
    const candidate = proposeExperienceLearningCandidate(mutable);

    expect(candidate).toMatchObject({
      activation: "none",
      activeBehaviorDigestAfter: ACTIVE_DIGEST,
      activeBehaviorDigestBefore: ACTIVE_DIGEST,
      experienceId: "experience-17",
      outcome: {
        authority: "owner-explicit",
        outcome: "rejected",
        runId: "run-17"
      },
      pipeline: "collaboration-policy",
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing"
      },
      scope: {
        kind: "thread-timing",
        threadId: "thread-work"
      },
      sourceRun: {
        behaviorDigest: RUN_DIGEST,
        evidenceClass: "controlled",
        runId: "run-17"
      },
      status: "proposed"
    });
    expect(candidate?.candidateId).toMatch(/^learning_[0-9a-f]{64}$/u);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate?.sourceRun)).toBe(true);
    expect(Object.isFrozen(candidate?.outcome)).toBe(true);
    expect(Object.isFrozen(candidate?.scope)).toBe(true);
    expect(Object.isFrozen(candidate?.proposedChange)).toBe(true);

    (mutable.sourceRun as { runId: string }).runId = "mutated-run";
    (mutable.outcome as { outcome: string }).outcome = "used";
    (mutable.scope as { threadId: string }).threadId = "other-thread";
    (mutable.proposedChange as { adjustment: string }).adjustment = "increase-stable-focus";
    expect(candidate).toMatchObject({
      outcome: { outcome: "rejected", runId: "run-17" },
      proposedChange: { adjustment: "increase-cooldown" },
      scope: { threadId: "thread-work" },
      sourceRun: { runId: "run-17" }
    });
  });

  it("accepts only an exact typed change matching the declared scope", () => {
    expect(proposeExperienceLearningCandidate({
      ...input(),
      proposedChange: { kind: "thread-display", detail: "compact", nextStep: "direct" }
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing",
        permission: "allow-send"
      }
    } as never)).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      proposedChange: { adjustment: "decrease-cooldown", kind: "thread-timing" }
    } as never)).toBeUndefined();
  });

  it("rejects unclassified receipts, extra model fields, and invalid time authority", () => {
    expect(proposeExperienceLearningCandidate({
      ...input(),
      outcome: { ...input().outcome!, authority: "unclassified-receipt" } as never
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      sourceRun: { ...input().sourceRun!, evidenceClass: "unclassified" } as never
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      modelSelfCritique: "I should interrupt less"
    } as never)).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      proposedAt: "2026-07-29T03:04:00.000Z"
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      expiresAt: "2026-07-29T03:06:00.000Z"
    })).toBeUndefined();
    expect(proposeExperienceLearningCandidate({
      ...input(),
      expiresAt: "2027-07-29T03:06:00.000Z"
    })).toBeUndefined();
  });

  it("binds every source, purpose, base-behavior, and expiry field into the candidate id", () => {
    const baseline = proposeExperienceLearningCandidate(input())!;
    expect(proposeExperienceLearningCandidate(input())!.candidateId).toBe(baseline.candidateId);
    expect(proposeExperienceLearningCandidate({
      ...input(),
      expectedBenefit: "Reduce unnecessary interruptions"
    })!.candidateId).not.toBe(baseline.candidateId);
    expect(proposeExperienceLearningCandidate({
      ...input(),
      activeBehaviorDigest: "c".repeat(64)
    })!.candidateId).not.toBe(baseline.candidateId);
    expect(proposeExperienceLearningCandidate({
      ...input(),
      sourceRun: {
        ...input().sourceRun!,
        completedAt: "2026-07-29T02:59:00.000Z"
      }
    })!.candidateId).not.toBe(baseline.candidateId);
    expect(proposeExperienceLearningCandidate({
      ...input(),
      expiresAt: "2026-07-31T00:00:00.000Z"
    })!.candidateId).not.toBe(baseline.candidateId);
    expect(proposeExperienceLearningCandidate({
      ...input(),
      proposedChange: {
        adjustment: "increase-stable-focus",
        kind: "thread-timing"
      }
    })!.candidateId).not.toBe(baseline.candidateId);
  });
});
