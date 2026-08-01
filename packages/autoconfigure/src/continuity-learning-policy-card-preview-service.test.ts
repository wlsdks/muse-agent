import {
  buildExperienceLearningReviewQueue,
  fingerprintContinuityPolicy,
  type AttunementState
} from "@muse/attunement";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningPolicyCardPreviewService
} from "./continuity-learning-policy-card-preview-service.js";

const RECORDED_AT = "2026-07-31T10:05:00.000Z";

function state(): AttunementState {
  const policy = {
    detail: "standard" as const,
    nextStep: "direct" as const,
    suppression: "none" as const,
    version: 1
  };
  const delivery = {
    evidenceClass: "organic" as const,
    evidenceRefs: [],
    id: "delivery-preview-1",
    openedAt: "2026-07-31T10:00:00.000Z",
    policyDigest: fingerprintContinuityPolicy(policy),
    policyVersion: 1,
    runId: "run-preview-1",
    threadId: "thread-preview-1"
  };
  const outcomeId = `continuity_outcome_${createHash("sha256")
    .update(JSON.stringify([
      "muse.continuity-outcome.v1",
      delivery.id,
      delivery.runId,
      "rejected",
      null,
      RECORDED_AT,
      "organic"
    ]))
    .digest("hex")}`;
  return {
    deliveries: [{
      ...delivery,
      outcome: {
        authority: "owner-explicit",
        evidenceClass: "organic",
        id: outcomeId,
        outcome: "rejected",
        policyVersion: 1,
        recordedAt: RECORDED_AT
      }
    }],
    experienceLearningPolicyAudits: [],
    interactionReceipts: [],
    nextPolicyVersion: 2,
    resetReceipts: [],
    schemaVersion: 13,
    threads: [{
      createdAt: "2026-07-31T09:00:00.000Z",
      id: delivery.threadId,
      kind: "work",
      links: [],
      policy,
      title: "Preview fixture"
    }],
    undoResetReceipts: []
  };
}

describe("ContinuityLearningPolicyCardPreviewService", () => {
  it("resolves one exact queue item and captures its provider head before compiling", async () => {
    const current = state();
    const opportunity = buildExperienceLearningReviewQueue(current).items[0]!;
    const captureHeadRevalidation = vi.fn(async () => ({ untrusted: true }));
    const service = createContinuityLearningPolicyCardPreviewService({
      captureHeadRevalidation,
      readState: async () => current,
      sourceId: "muse.attunement.local-state.v1"
    });
    const result = await service.preview({
      draft: {
        expectedBenefit: "Owner-selected display only.",
        expiresAt: "2026-08-01T10:06:00.000Z",
        experienceId: "owner-taught-preview",
        proposedAt: "2026-07-31T10:06:00.000Z",
        proposedBehavior: "Use compact detail for this thread.",
        proposedChange: {
          detail: "compact",
          kind: "thread-display",
          nextStep: "contextual"
        },
        scope: { kind: "thread-display", threadId: opportunity.scope.threadId }
      },
      evidenceCases: [],
      locale: "en",
      opportunityId: opportunity.opportunityId
    });

    expect(captureHeadRevalidation).toHaveBeenCalledWith({
      sourceId: "muse.attunement.local-state.v1",
      threadId: opportunity.scope.threadId
    }, { maxCaptureSpanMs: 1_000 });
    expect(result).toEqual({ reason: "untrusted-revalidation", status: "held" });
  });

  it("fails closed without capture when the exact opportunity is absent", async () => {
    const captureHeadRevalidation = vi.fn();
    const service = createContinuityLearningPolicyCardPreviewService({
      captureHeadRevalidation,
      readState: async () => state(),
      sourceId: "muse.attunement.local-state.v1"
    });
    const result = await service.preview({
      draft: {} as never,
      evidenceCases: [],
      locale: "ko",
      opportunityId: `learning_opportunity_${"f".repeat(64)}`
    });

    expect(result).toEqual({ reason: "opportunity-not-found", status: "held" });
    expect(captureHeadRevalidation).not.toHaveBeenCalled();
  });
});
