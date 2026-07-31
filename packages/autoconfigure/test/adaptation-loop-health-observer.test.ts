import {
  type ExperienceLearningRollbackProposal
} from "@muse/attunement";
import { sha256Hex } from "@muse/shared";
import { describe, expect, it } from "vitest";

import { createLatestAdaptationLoopHealthObserver } from "../src/adaptation-loop-health-observer.js";
import {
  experienceLearningPromotionHandle,
  experienceLearningPromotionReceipt
} from "./helpers/experience-learning-promotion-receipt.js";

describe("latest adaptation loop health observer", () => {
  it("accepts only verified receipts and keeps the newest immutable projection", () => {
    const observer = createLatestAdaptationLoopHealthObserver();
    const older = experienceLearningPromotionReceipt("2026-07-30T00:02:00Z", "older");
    const newer = experienceLearningPromotionReceipt("2026-07-30T00:02:00.500Z", "newer");

    expect(observer.snapshot()).toBeUndefined();
    observer.observe({ ...newer, promotionId: "forged" });
    expect(observer.snapshot()).toBeUndefined();

    observer.observe(newer);
    observer.observe(older);

    expect(observer.snapshot()).toEqual({
      evidenceId: newer.promotionId,
      evidenceVerified: true,
      status: "promoted"
    });
    expect(Object.isFrozen(observer.snapshot())).toBe(true);
  });

  it("settles equal timestamps independently of callback arrival order", () => {
    const firstReceipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "a");
    const secondReceipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "b");
    const first = createLatestAdaptationLoopHealthObserver();
    const second = createLatestAdaptationLoopHealthObserver();

    first.observe(firstReceipt);
    first.observe(secondReceipt);
    second.observe(secondReceipt);
    second.observe(firstReceipt);

    expect(first.snapshot()).toEqual(second.snapshot());
  });

  it("binds a verified rollback proposal to the exact latest promotion handle", () => {
    const observer = createLatestAdaptationLoopHealthObserver();
    const receipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "bound");
    const handle = experienceLearningPromotionHandle(receipt);
    const proposal = rollbackProposal(handle.handleId, "bound");

    observer.observe(receipt, handle);
    observer.observeRollbackProposal(proposal);

    expect(observer.snapshot()).toEqual({
      evidenceId: proposal.proposalId,
      evidenceVerified: true,
      status: "rollback-proposed"
    });
  });

  it("fails closed for mismatched handles and forged or unrelated proposals", () => {
    const observer = createLatestAdaptationLoopHealthObserver();
    const receipt = experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "expected");
    const handle = experienceLearningPromotionHandle(receipt);
    const unrelated = experienceLearningPromotionHandle(
      experienceLearningPromotionReceipt("2026-07-30T00:02:00.000Z", "unrelated")
    );

    observer.observe(receipt, unrelated);
    expect(observer.snapshot()).toBeUndefined();

    observer.observe(receipt, handle);
    observer.observeRollbackProposal(rollbackProposal(unrelated.handleId, "unrelated"));
    observer.observeRollbackProposal({
      ...rollbackProposal(handle.handleId, "forged"),
      proposalId: "learning_rollback_proposal_" + "0".repeat(64)
    });

    expect(observer.snapshot()).toEqual({
      evidenceId: receipt.promotionId,
      evidenceVerified: true,
      status: "promoted"
    });
  });

  it("preserves a proposal against duplicate or older callbacks and replaces it with a newer promotion", () => {
    const observer = createLatestAdaptationLoopHealthObserver();
    const olderReceipt = experienceLearningPromotionReceipt(
      "2026-07-30T00:02:00.000Z",
      "older-bound"
    );
    const olderHandle = experienceLearningPromotionHandle(olderReceipt);
    const proposal = rollbackProposal(olderHandle.handleId, "ordered");
    const newerReceipt = experienceLearningPromotionReceipt(
      "2026-07-30T00:02:01.000Z",
      "newer-bound"
    );
    const newerHandle = experienceLearningPromotionHandle(newerReceipt);

    observer.observe(olderReceipt, olderHandle);
    observer.observeRollbackProposal(proposal);
    observer.observe(olderReceipt);
    observer.observe(olderReceipt, olderHandle);

    expect(observer.snapshot()?.status).toBe("rollback-proposed");

    observer.observe(newerReceipt, newerHandle);

    expect(observer.snapshot()).toEqual({
      evidenceId: newerReceipt.promotionId,
      evidenceVerified: true,
      status: "promoted"
    });
  });
});

function rollbackProposal(
  handleId: string,
  suffix: string
): ExperienceLearningRollbackProposal {
  const baselineOutcomeIds = Array.from(
    { length: 5 },
    (_, index) => `continuity_outcome_${sha256Hex(`baseline:${suffix}:${index}`)}`
  );
  const promotedOutcomeIds = Array.from(
    { length: 5 },
    (_, index) => `continuity_outcome_${sha256Hex(`promoted:${suffix}:${index}`)}`
  );
  const core = {
    authority: "none" as const,
    baselineOutcomeIds,
    criteriaVersion: 1 as const,
    effectPerformed: false as const,
    handleId,
    ownerApprovalRequired: true as const,
    promotedOutcomeIds,
    reason: "post-promotion-regression" as const,
    schemaVersion: 1 as const,
    status: "proposed" as const
  };
  return Object.freeze({
    ...core,
    baselineOutcomeIds: Object.freeze(baselineOutcomeIds),
    promotedOutcomeIds: Object.freeze(promotedOutcomeIds),
    proposalId: `learning_rollback_proposal_${sha256Hex(JSON.stringify(core))}`
  });
}
