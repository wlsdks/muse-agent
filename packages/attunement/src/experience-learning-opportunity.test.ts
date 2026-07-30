import { describe, expect, it } from "vitest";

import { continuityOutcomeId } from "./outcome-id.js";
import {
  EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT,
  buildExperienceLearningReviewOpportunity,
  buildExperienceLearningReviewQueue
} from "./experience-learning-opportunity.js";
import type {
  AttunementState,
  ContinuityDelivery,
  ContinuityOutcome
} from "./types.js";

function delivery(
  outcome: ContinuityOutcome = "ignored",
  evidenceClass: "controlled" | "organic" | "unclassified" = "organic",
  options: Readonly<{
    id?: string;
    openedAt?: string;
    recordedAt?: string;
    runId?: string;
    threadId?: string;
  }> = {}
): ContinuityDelivery {
  const base = {
    evidenceClass,
    evidenceRefs: [],
    id: options.id ?? "delivery-opportunity-1",
    openedAt: options.openedAt ?? "2026-07-30T11:00:00.000Z",
    policyDigest: "a".repeat(64),
    policyVersion: 4,
    runId: options.runId ?? "run-opportunity-1",
    threadId: options.threadId ?? "thread-opportunity-1"
  } satisfies ContinuityDelivery;
  const recordedAt = options.recordedAt ?? "2026-07-30T11:05:00.000Z";
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

describe("buildExperienceLearningReviewQueue", () => {
  it("returns only organic eligible outcomes after the conservative thread audit boundary", () => {
    const old = delivery("ignored", "organic", {
      id: "delivery-old",
      recordedAt: "2026-07-30T11:05:00.000Z",
      runId: "run-old",
      threadId: "thread-a"
    });
    const fresh = delivery("rejected", "organic", {
      id: "delivery-fresh",
      openedAt: "2026-07-30T12:00:00.000Z",
      recordedAt: "2026-07-30T12:05:00.000Z",
      runId: "run-fresh",
      threadId: "thread-a"
    });
    const other = delivery("adjusted", "organic", {
      id: "delivery-other",
      openedAt: "2026-07-30T11:30:00.000Z",
      recordedAt: "2026-07-30T11:35:00.000Z",
      runId: "run-other",
      threadId: "thread-b"
    });
    const state = {
      deliveries: [
        fresh,
        delivery("ignored", "controlled", {
          id: "delivery-controlled",
          runId: "run-controlled",
          threadId: "thread-c"
        }),
        delivery("used", "organic", {
          id: "delivery-used",
          runId: "run-used",
          threadId: "thread-d"
        }),
        old,
        other
      ],
      experienceLearningPolicyAudits: [{
        activeBehaviorDigestAfter: "b".repeat(64),
        activeBehaviorDigestBefore: "a".repeat(64),
        authority: "owner-explicit",
        candidateId: "candidate-old",
        id: "audit-old",
        kind: "promotion",
        occurredAt: "2026-07-30T11:05:00.000Z",
        policyAfter: { detail: "compact", nextStep: "contextual", suppression: "none", version: 5 },
        policyBefore: { detail: "standard", nextStep: "direct", suppression: "none", version: 4 },
        sourceId: "candidate-old",
        threadId: "thread-a"
      }],
      interactionReceipts: [],
      nextPolicyVersion: 6,
      resetReceipts: [],
      schemaVersion: 12,
      threads: [],
      undoResetReceipts: []
    } satisfies AttunementState;
    const before = JSON.stringify(state);

    const queue = buildExperienceLearningReviewQueue(state);

    expect(queue).toMatchObject({
      limit: EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT,
      status: "review-required",
      total: 2,
      truncated: false
    });
    expect(queue.items.map((item) => item.deliveryId))
      .toEqual(["delivery-other", "delivery-fresh"]);
    expect(JSON.stringify(state)).toBe(before);
    expect(Object.isFrozen(queue)).toBe(true);
    expect(Object.isFrozen(queue.items)).toBe(true);
  });

  it("caps the oldest-first projection at twenty while preserving the total", () => {
    const deliveries = Array.from({ length: 22 }, (_, index) => delivery(
      "ignored",
      "organic",
      {
        id: `delivery-${index.toString().padStart(2, "0")}`,
        openedAt: `2026-07-30T10:${index.toString().padStart(2, "0")}:00.000Z`,
        recordedAt: `2026-07-30T10:${index.toString().padStart(2, "0")}:30.000Z`,
        runId: `run-${index.toString()}`,
        threadId: `thread-${index.toString()}`
      }
    ));
    const queue = buildExperienceLearningReviewQueue({
      deliveries,
      experienceLearningPolicyAudits: [],
      interactionReceipts: [],
      nextPolicyVersion: 1,
      resetReceipts: [],
      schemaVersion: 12,
      threads: [],
      undoResetReceipts: []
    });

    expect(queue).toMatchObject({ total: 22, truncated: true });
    expect(queue.items).toHaveLength(20);
    expect(queue.items[0]?.deliveryId).toBe("delivery-00");
    expect(queue.items[19]?.deliveryId).toBe("delivery-19");
  });
});
