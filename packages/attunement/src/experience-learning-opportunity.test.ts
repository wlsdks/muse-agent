import { describe, expect, it } from "vitest";

import { continuityOutcomeId } from "./outcome-id.js";
import {
  buildExperienceLearningReviewOpportunity
} from "./experience-learning-opportunity.js";
import type { ContinuityDelivery, ContinuityOutcome } from "./types.js";

function delivery(
  outcome: ContinuityOutcome = "ignored",
  evidenceClass: "controlled" | "organic" | "unclassified" = "organic"
): ContinuityDelivery {
  const base = {
    evidenceClass,
    evidenceRefs: [],
    id: "delivery-opportunity-1",
    openedAt: "2026-07-30T11:00:00.000Z",
    policyDigest: "a".repeat(64),
    policyVersion: 4,
    runId: "run-opportunity-1",
    threadId: "thread-opportunity-1"
  } satisfies ContinuityDelivery;
  const recordedAt = "2026-07-30T11:05:00.000Z";
  return {
    ...base,
    outcome: {
      authority: "owner-explicit",
      evidenceClass,
      id: continuityOutcomeId({
        deliveryId: base.id,
        evidenceClass,
        outcome,
        recordedAt,
        runId: base.runId
      }),
      outcome,
      policyVersion: 5,
      recordedAt
    }
  };
}

describe("buildExperienceLearningReviewOpportunity", () => {
  it.each(["adjusted", "ignored", "rejected"] as const)(
    "creates one stable activation-none review handoff for %s",
    (outcome) => {
      const input = delivery(outcome);
      const before = JSON.stringify(input);
      const first = buildExperienceLearningReviewOpportunity(input);
      const replay = buildExperienceLearningReviewOpportunity(input);

      expect(first).toEqual(replay);
      expect(JSON.stringify(input)).toBe(before);
      expect(first).toMatchObject({
        opportunity: {
          activation: "none",
          boundary: {
            actionScope: "not-expanded",
            permission: "unchanged",
            recipient: "unchanged",
            retention: "unchanged",
            source: "unchanged"
          },
          deliveryId: input.id,
          opportunityId: expect.stringMatching(/^learning_opportunity_[a-f0-9]{64}$/u),
          outcome: { outcome },
          requiredReview: {
            boundedDraft: true,
            explicitApproval: true,
            frozenReplayEvidence: true
          },
          scope: { threadId: input.threadId },
          sourceRun: {
            behaviorDigest: input.policyDigest,
            evidenceClass: "organic-production",
            runId: input.runId
          },
          status: "review-required"
        },
        status: "review-required"
      });
      expect(JSON.stringify(first)).not.toContain("proposedChange");
    }
  );

  it.each([
    ["successful outcome", delivery("used"), "non-negative-outcome"],
    ["unclassified evidence", delivery("ignored", "unclassified"), "unclassified-evidence"],
    ["missing run provenance", { ...delivery(), runId: undefined }, "missing-run-id"],
    ["tampered outcome", {
      ...delivery(),
      outcome: {
        ...delivery().outcome!,
        id: `continuity_outcome_${"f".repeat(64)}`
      }
    }, "missing-explicit-outcome"]
  ] as const)("holds %s", (_label, input, reason) => {
    expect(buildExperienceLearningReviewOpportunity(input as ContinuityDelivery))
      .toEqual({ reason, status: "held" });
  });
});
