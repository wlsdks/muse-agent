import { describe, expect, it, vi } from "vitest";

import {
  AttunementStoreError,
  baselinePolicy,
  prepareContinuityReview,
  type ArtifactLink,
  type AttunementState
} from "./index.js";

const link: ArtifactLink = {
  artifactId: "task_resume",
  artifactType: "task",
  linkedAt: "2026-07-17T08:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_work"
};

function state(): AttunementState {
  return {
    deliveries: [
      {
        evidenceClass: "organic",
        evidenceRefs: [link],
        id: "delivery_reviewed",
        openedAt: "2026-07-17T08:00:00.000Z",
        outcome: { evidenceClass: "organic", outcome: "used", policyVersion: 0, recordedAt: "2026-07-17T08:05:00.000Z" },
        policyVersion: 0,
        threadId: "thread_work"
      },
      {
        evidenceClass: "organic",
        evidenceRefs: [link],
        id: "delivery_pending",
        openedAt: "2026-07-17T09:00:00.000Z",
        policyVersion: 0,
        threadId: "thread_work"
      }
    ],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 4,
    threads: [{
      createdAt: "2026-07-17T07:00:00.000Z",
      id: "thread_work",
      kind: "work",
      links: [link],
      policy: baselinePolicy(),
      title: "Resume Muse"
    }],
    undoResetReceipts: []
  };
}

describe("prepareContinuityReview", () => {
  it("ignores non-organic deliveries and marks mixed feedback as technical-only rather than actionable", async () => {
    const current = state();
    const pending = current.deliveries[1]!;
    const mixed = {
      ...pending,
      id: "delivery_mixed",
      outcome: {
        evidenceClass: "controlled" as const,
        outcome: "used" as const,
        policyVersion: 2,
        recordedAt: "2026-07-17T09:05:00.000Z"
      }
    };
    const controlled = { ...pending, evidenceClass: "controlled" as const, id: "delivery_controlled" };

    const review = await prepareContinuityReview({
      ...current,
      deliveries: [controlled, current.deliveries[0]!, mixed]
    }, async (currentLink) => ({ ...currentLink, title: "Exact task" }));

    expect(review.progress).toMatchObject({ eligibleDeliveries: 2, reviewedDeliveries: 1, remainingFeedback: 1 });
    expect(review.next).toMatchObject({
      deliveryId: "delivery_mixed",
      ineligibleReason: "existing controlled feedback is technical-only and immutable; this delivery cannot receive organic feedback"
    });
  });

  it("selects the oldest pending first-20 delivery and resolves its exact current link", async () => {
    const resolver = vi.fn(async (current: ArtifactLink) => ({
      ...current,
      taskStatus: "open" as const,
      title: "Verify the shared review"
    }));

    const review = await prepareContinuityReview(state(), resolver);

    expect(review).toEqual({
      next: {
        deliveryId: "delivery_pending",
        evidence: [{
          artifact: {
            ...link,
            taskStatus: "open",
            title: "Verify the shared review"
          },
          reference: link,
          status: "available"
        }],
        openedAt: "2026-07-17T09:00:00.000Z",
        thread: { id: "thread_work", kind: "work", title: "Resume Muse" }
      },
      progress: {
        eligibleDeliveries: 2,
        remainingFeedback: 1,
        remainingPacks: 18,
        reviewedDeliveries: 1,
        target: 20
      }
    });
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(link);
  });

  it("fails closed with the corrupt delivery id when its thread is missing", async () => {
    const corrupt = state();

    await expect(prepareContinuityReview({ ...corrupt, threads: [] }, async () => undefined))
      .rejects.toEqual(new AttunementStoreError("delivery 'delivery_pending' references a missing thread"));
  });

  it("marks historical evidence unavailable when its user-authored link was removed", async () => {
    const current = state();
    const resolver = vi.fn(async () => ({ ...link, title: "must not resolve" }));

    const review = await prepareContinuityReview({
      ...current,
      threads: current.threads.map((thread) => ({ ...thread, links: [] }))
    }, resolver);

    expect(review.next?.evidence).toEqual([{ reference: link, status: "unavailable" }]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("uses id as the deterministic tie-break regardless of insertion order", async () => {
    const current = state();
    const pending = current.deliveries[1]!;
    const review = await prepareContinuityReview({
      ...current,
      deliveries: [
        { ...pending, id: "delivery_b", openedAt: "2026-07-17T09:00:00.000Z" },
        { ...pending, id: "delivery_a", openedAt: "2026-07-17T09:00:00.000Z" }
      ]
    }, async () => undefined);

    expect(review.next?.deliveryId).toBe("delivery_a");
  });

  it("never reviews beyond the first 20 after deterministic ordering", async () => {
    const current = state();
    const deliveries = Array.from({ length: 21 }, (_, index) => ({
      evidenceClass: "organic" as const,
      evidenceRefs: [link],
      id: `delivery_${index.toString().padStart(2, "0")}`,
      openedAt: "2026-07-17T09:00:00.000Z",
      ...(index < 20 ? { outcome: { evidenceClass: "organic" as const, outcome: "used" as const, policyVersion: index, recordedAt: `2026-07-17T10:${index.toString().padStart(2, "0")}:00.000Z` } } : {}),
      policyVersion: index,
      threadId: "thread_work"
    })).reverse();

    const review = await prepareContinuityReview({ ...current, deliveries }, async () => undefined);

    expect(review.next).toBeUndefined();
    expect(review.progress).toEqual({
      eligibleDeliveries: 20,
      remainingFeedback: 0,
      remainingPacks: 0,
      reviewedDeliveries: 20,
      target: 20
    });
  });

  it.each(["life", "work"] as const)("preserves an explicitly chosen %s thread kind", async (kind) => {
    const current = state();
    const review = await prepareContinuityReview({
      ...current,
      threads: current.threads.map((thread) => ({ ...thread, kind }))
    }, async (currentLink) => ({ ...currentLink, title: "Exact task" }));

    expect(review.next?.thread.kind).toBe(kind);
  });

  it("returns zeroed progress for an empty continuity space", async () => {
    const current = state();

    await expect(prepareContinuityReview({ ...current, deliveries: [], threads: [] }, async () => undefined)).resolves.toEqual({
      progress: {
        eligibleDeliveries: 0,
        remainingFeedback: 0,
        remainingPacks: 20,
        reviewedDeliveries: 0,
        target: 20
      }
    });
  });
});
