import { sha256Hex } from "@muse/shared";

import {
  projectExperienceLearningSource,
  type ExperienceLearningSourceHeldReason
} from "./experience-learning-source.js";
import type { AttunementState, ContinuityDelivery } from "./types.js";

export const EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT = 20;

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

export interface ExperienceLearningReviewQueue {
  readonly items: readonly ExperienceLearningReviewOpportunity[];
  readonly limit: typeof EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT;
  readonly status: "empty" | "review-required";
  readonly total: number;
  readonly truncated: boolean;
}

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

/**
 * Rebuilds the owner review queue from existing durable facts. A policy audit
 * is a conservative per-thread review boundary because the legacy audit shape
 * does not retain the source outcome id. This may under-report an older signal,
 * but it cannot requeue an outcome already covered by later governed work.
 */
export function buildExperienceLearningReviewQueue(
  state: AttunementState
): ExperienceLearningReviewQueue {
  const reviewedThrough = new Map<string, string>();
  for (const audit of state.experienceLearningPolicyAudits ?? []) {
    const current = reviewedThrough.get(audit.threadId);
    if (!current || audit.occurredAt > current) {
      reviewedThrough.set(audit.threadId, audit.occurredAt);
    }
  }
  const eligible = state.deliveries.flatMap((delivery) => {
    const result = buildExperienceLearningReviewOpportunity(delivery);
    if (result.status !== "review-required"
      || result.opportunity.sourceRun.evidenceClass !== "organic-production") {
      return [];
    }
    const boundary = reviewedThrough.get(delivery.threadId);
    return boundary && result.opportunity.outcome.recordedAt <= boundary
      ? []
      : [result.opportunity];
  }).sort((left, right) =>
    left.outcome.recordedAt.localeCompare(right.outcome.recordedAt)
      || left.opportunityId.localeCompare(right.opportunityId)
  );
  const items = Object.freeze(eligible.slice(0, EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT));
  return Object.freeze({
    items,
    limit: EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT,
    status: eligible.length === 0 ? "empty" as const : "review-required" as const,
    total: eligible.length,
    truncated: eligible.length > EXPERIENCE_LEARNING_REVIEW_QUEUE_LIMIT
  });
}
