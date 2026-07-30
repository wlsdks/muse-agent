import { describe, expect, it } from "vitest";

import {
  buildExperienceLearningProposalPreview
} from "./experience-learning-preview.js";
import {
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate
} from "./experience-learning-candidate.js";

function candidate(): ExperienceLearningCandidate {
  return proposeExperienceLearningCandidate({
    activeBehaviorDigest: "a".repeat(64),
    expectedBenefit: "Interrupt less often.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-1",
    outcome: {
      authority: "owner-explicit",
      outcome: "rejected",
      outcomeId: `continuity_outcome_${"b".repeat(64)}`,
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-1"
    },
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Wait longer before offering this thread.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: {
      kind: "thread-timing",
      threadId: "thread-1"
    },
    sourceRun: {
      behaviorDigest: "a".repeat(64),
      completedAt: "2026-07-29T03:00:00.000Z",
      evidenceClass: "organic-production",
      runId: "run-1"
    }
  })!;
}

describe("buildExperienceLearningProposalPreview", () => {
  it("builds an immutable, content-bound owner review receipt with no authority expansion", () => {
    const result = buildExperienceLearningProposalPreview(candidate());

    expect(result).toMatchObject({
      boundary: {
        actionScope: "not-expanded",
        activation: "none",
        permission: "unchanged",
        recipient: "unchanged",
        source: "unchanged"
      },
      candidateId: candidate().candidateId,
      evidence: {
        outcome: {
          authority: "owner-explicit",
          outcome: "rejected",
          runId: "run-1"
        },
        sourceRun: {
          behaviorDigest: "a".repeat(64),
          evidenceClass: "organic-production",
          runId: "run-1"
        }
      },
      proposedAt: "2026-07-29T03:06:00.000Z",
      proposedChange: {
        adjustment: "increase-cooldown",
        kind: "thread-timing"
      },
      schemaVersion: 1
    });
    expect(result?.previewId).toMatch(/^learning_preview_[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.boundary)).toBe(true);
    expect(Object.isFrozen(result?.evidence)).toBe(true);
    expect(Object.isFrozen(result?.evidence.outcome)).toBe(true);
    expect(Object.isFrozen(result?.evidence.sourceRun)).toBe(true);
    expect(Object.isFrozen(result?.proposedChange)).toBe(true);
    expect(Object.isFrozen(result?.scope)).toBe(true);
  });

  it("is deterministic and rejects semantic or authority-field tampering", () => {
    const original = candidate();
    expect(buildExperienceLearningProposalPreview(candidate())?.previewId)
      .toBe(buildExperienceLearningProposalPreview(candidate())?.previewId);
    expect(buildExperienceLearningProposalPreview({
      ...original,
      expectedBenefit: "Tampered benefit"
    })).toBeUndefined();
    expect(buildExperienceLearningProposalPreview({
      ...original,
      permission: "allow-send"
    } as ExperienceLearningCandidate)).toBeUndefined();
    const hiddenAuthority = Object.defineProperty(
      { ...original },
      "permission",
      { enumerable: false, value: "allow-send" }
    );
    expect(buildExperienceLearningProposalPreview(
      hiddenAuthority as ExperienceLearningCandidate
    )).toBeUndefined();
    expect(buildExperienceLearningProposalPreview({
      ...original,
      toJSON: () => original
    } as unknown as ExperienceLearningCandidate)).toBeUndefined();
  });
});
