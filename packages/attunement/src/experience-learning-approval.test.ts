import { describe, expect, it } from "vitest";

import {
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  createExperienceLearningApprovalReceipt,
  createExperienceReplayEvidenceReceipt,
  proposeExperienceLearningCandidate,
  verifyExperienceLearningApprovalReceipt
} from "./index.js";

const digest = (character: string) => character.repeat(64);

function evidenceCase(index: number) {
  const common = {
    caseId: `case-${index}`,
    evaluator: { id: "continuity-terminal-grader", version: "1.0.0" },
    inputHash: digest("f"),
    observedAt: "2026-07-29T03:06:30.000Z"
  };
  return {
    baseline: createExperienceReplayEvidenceReceipt({
      ...common,
      passed: index !== 0,
      variant: "baseline"
    })!,
    caseId: common.caseId,
    challenger: createExperienceReplayEvidenceReceipt({
      ...common,
      passed: true,
      variant: "challenger"
    })!
  };
}

function previewAndReplay() {
  const candidate = proposeExperienceLearningCandidate({
    activeBehaviorDigest: digest("a"),
    expectedBenefit: "Use a compact review.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-approval-1",
    outcome: {
      authority: "owner-explicit",
      outcome: "adjusted",
      outcomeId: "outcome-approval-1",
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-approval-1"
    },
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Use compact contextual presentation.",
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
      runId: "run-approval-1"
    }
  })!;
  return {
    preview: buildExperienceLearningProposalPreview(candidate)!,
    replay: buildExperienceLearningReplayBundle(
      candidate,
      Array.from({ length: 10 }, (_, index) => evidenceCase(index))
    )!
  };
}

describe("experience learning approval receipt", () => {
  it("content-binds the exact preview, frozen replay, policy digest, and approval window", () => {
    const { preview, replay } = previewAndReplay();
    const receipt = createExperienceLearningApprovalReceipt(
      preview,
      replay,
      "2026-07-29T03:07:00.000Z"
    )!;

    expect(receipt).toMatchObject({
      activeBehaviorDigestBefore: preview.activeBehaviorDigestBefore,
      authority: "owner-explicit",
      candidateId: preview.candidateId,
      previewId: preview.previewId,
      replayBundleId: replay.bundleId,
      replayInputHash: replay.replay.inputHash
    });
    expect(receipt.approvalId).toMatch(/^learning_approval_[a-f0-9]{64}$/u);
    expect(verifyExperienceLearningApprovalReceipt(
      structuredClone(receipt),
      preview,
      replay,
      "2026-07-29T03:08:00.000Z"
    )).toEqual(receipt);
  });

  it("rejects tampering, unknown fields, accessors, and expired application", () => {
    const { preview, replay } = previewAndReplay();
    const receipt = createExperienceLearningApprovalReceipt(
      preview,
      replay,
      "2026-07-29T03:07:00.000Z"
    )!;

    expect(verifyExperienceLearningApprovalReceipt(
      { ...receipt, replayBundleId: "forged" },
      preview,
      replay,
      "2026-07-29T03:08:00.000Z"
    )).toBeUndefined();
    expect(verifyExperienceLearningApprovalReceipt(
      { ...receipt, extra: true },
      preview,
      replay,
      "2026-07-29T03:08:00.000Z"
    )).toBeUndefined();
    const accessor = { ...receipt };
    Object.defineProperty(accessor, "candidateId", {
      enumerable: true,
      get: () => preview.candidateId
    });
    expect(verifyExperienceLearningApprovalReceipt(
      accessor,
      preview,
      replay,
      "2026-07-29T03:08:00.000Z"
    )).toBeUndefined();
    expect(verifyExperienceLearningApprovalReceipt(
      receipt,
      preview,
      replay,
      preview.expiresAt
    )).toBeUndefined();
    expect(createExperienceLearningApprovalReceipt(
      { ...preview, proposedBehavior: "Tampered after preview." },
      replay,
      "2026-07-29T03:07:00.000Z"
    )).toBeUndefined();
    expect(createExperienceLearningApprovalReceipt(
      preview,
      { ...replay, cases: [] },
      "2026-07-29T03:07:00.000Z"
    )).toBeUndefined();
  });

  it("does not mint approval for a held or insufficient replay", () => {
    const { preview, replay } = previewAndReplay();
    expect(createExperienceLearningApprovalReceipt(
      preview,
      {
        ...replay,
        replay: {
          ...replay.replay,
          aggregate: { ...replay.replay.aggregate, total: 9 }
        }
      },
      "2026-07-29T03:07:00.000Z"
    )).toBeUndefined();
  });
});
