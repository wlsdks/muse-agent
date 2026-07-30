import { describe, expect, it, vi } from "vitest";

import {
  createContinuityLearningOpportunityTool
} from "../src/continuity-learning-opportunity-tool.js";

describe("continuity learning opportunity tool", () => {
  it("returns the canonical queue through a read-only empty-input surface", async () => {
    const readQueue = vi.fn(async () => ({
      items: [{
        activation: "none" as const,
        boundary: {
          actionScope: "not-expanded" as const,
          permission: "unchanged" as const,
          recipient: "unchanged" as const,
          retention: "unchanged" as const,
          source: "unchanged" as const
        },
        deliveryId: "delivery-1",
        opportunityId: `learning_opportunity_${"a".repeat(64)}`,
        outcome: {
          outcome: "ignored" as const,
          outcomeId: "outcome-1",
          recordedAt: "2026-07-30T11:05:00.000Z"
        },
        requiredReview: {
          boundedDraft: true as const,
          explicitApproval: true as const,
          frozenReplayEvidence: true as const
        },
        schemaVersion: 1 as const,
        scope: { threadId: "thread-1" },
        sourceRun: {
          behaviorDigest: "b".repeat(64),
          completedAt: "2026-07-30T11:00:00.000Z",
          evidenceClass: "organic-production" as const,
          runId: "run-1"
        },
        status: "review-required" as const
      }],
      limit: 20 as const,
      status: "review-required" as const,
      total: 1,
      truncated: false
    }));
    const tool = createContinuityLearningOpportunityTool({ readQueue });

    expect(tool.definition).toMatchObject({
      name: "muse.continuity.learning.opportunities",
      risk: "read"
    });
    await expect(tool.execute({}, { runId: "read" })).resolves.toMatchObject({
      items: [{
        activation: "none",
        opportunityId: `learning_opportunity_${"a".repeat(64)}`,
        status: "review-required"
      }],
      total: 1,
      truncated: false
    });
    expect(readQueue).toHaveBeenCalledTimes(1);
  });

  it("rejects extra, accessor, and exotic input before reading", async () => {
    const readQueue = vi.fn();
    const tool = createContinuityLearningOpportunityTool({ readQueue });
    for (const input of [{ extra: true }, [], new Date()]) {
      await expect(tool.execute(input as never, { runId: "blocked" })).rejects.toThrow();
    }
    const accessor = Object.defineProperty({}, "hidden", {
      enumerable: false,
      get: () => true
    });
    await expect(tool.execute(accessor, { runId: "blocked" })).rejects.toThrow();
    expect(readQueue).not.toHaveBeenCalled();
  });
});
