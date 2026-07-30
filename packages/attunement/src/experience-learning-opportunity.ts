import { sha256Hex } from "@muse/shared";

import {
  projectExperienceLearningSource,
  type ExperienceLearningSourceHeldReason
} from "./experience-learning-source.js";
import type { ContinuityDelivery } from "./types.js";

export interface ExperienceLearningReviewOpportunity {
  readonly activation: "none";
  readonly boundary: {
    readonly actionScope: "not-expanded";
    readonly permission: "unchanged";
    readonly recipient: "unchanged";
    readonly retention: "unchanged";
    readonly source: "unchanged";
  };
  readonly deliveryId: string;
  readonly opportunityId: string;
  readonly outcome: {
    readonly outcome: "adjusted" | "ignored" | "rejected";
    readonly outcomeId: string;
    readonly recordedAt: string;
  };
  readonly requiredReview: {
    readonly boundedDraft: true;
    readonly explicitApproval: true;
    readonly frozenReplayEvidence: true;
  };
  readonly schemaVersion: 1;
  readonly scope: {
    readonly threadId: string;
  };
  readonly sourceRun: {
    readonly behaviorDigest: string;
    readonly completedAt: string;
    readonly evidenceClass: "controlled" | "organic-production";
    readonly runId: string;
  };
  readonly status: "review-required";
}

export type ExperienceLearningReviewOpportunityResult =
  | Readonly<{
      opportunity: ExperienceLearningReviewOpportunity;
      status: "review-required";
    }>
  | Readonly<{
      reason: ExperienceLearningSourceHeldReason;
      status: "held";
    }>;

/**
 * Turns one exact eligible outcome into a content-bound review handoff. This
 * deliberately does not infer a change, create replay evidence, write state,
 * or expose promotion authority.
 */
export function buildExperienceLearningReviewOpportunity(
  delivery: ContinuityDelivery
): ExperienceLearningReviewOpportunityResult {
  const source = projectExperienceLearningSource(delivery);
  if (source.status === "held") {
    return Object.freeze({ reason: source.reason, status: "held" as const });
  }
  const core = {
    activation: "none" as const,
    boundary: Object.freeze({
      actionScope: "not-expanded" as const,
      permission: "unchanged" as const,
      recipient: "unchanged" as const,
      retention: "unchanged" as const,
      source: "unchanged" as const
    }),
    deliveryId: delivery.id,
    outcome: Object.freeze({
      outcome: source.outcome.outcome as "adjusted" | "ignored" | "rejected",
      outcomeId: source.outcome.outcomeId,
      recordedAt: source.outcome.recordedAt
    }),
    requiredReview: Object.freeze({
      boundedDraft: true as const,
      explicitApproval: true as const,
      frozenReplayEvidence: true as const
    }),
    schemaVersion: 1 as const,
    scope: Object.freeze({ threadId: delivery.threadId }),
    sourceRun: Object.freeze({ ...source.sourceRun }),
    status: "review-required" as const
  };
  const opportunity = Object.freeze({
    ...core,
    opportunityId: `learning_opportunity_${sha256Hex(JSON.stringify(core))}`
  });
  return Object.freeze({ opportunity, status: "review-required" as const });
}
