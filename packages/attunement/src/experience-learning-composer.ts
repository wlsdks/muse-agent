import {
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate,
  type ExperienceLearningChange,
  type ExperienceLearningScope
} from "./experience-learning-candidate.js";
import {
  projectExperienceLearningSource,
  type ExperienceLearningSourceHeldReason
} from "./experience-learning-source.js";
import type { ContinuityDelivery } from "./types.js";

export interface ExperienceLearningProposalDraft {
  readonly expectedBenefit: string;
  readonly expiresAt: string;
  readonly experienceId: string;
  readonly proposedAt: string;
  readonly proposedBehavior: string;
  readonly proposedChange: ExperienceLearningChange;
  readonly scope: {
    readonly kind: ExperienceLearningScope;
    readonly threadId: string;
  };
}

export type ExperienceLearningProposalResult =
  | Readonly<{
      candidate: ExperienceLearningCandidate;
      status: "proposed";
    }>
  | Readonly<{
      reason:
        | ExperienceLearningSourceHeldReason
        | "invalid-proposal"
        | "scope-mismatch";
      status: "held";
    }>;

/**
 * Production-safe composition seam: exact persisted evidence may create one
 * detached proposal, but this function has no write gate, registry, or effect
 * callback and therefore cannot activate behavior.
 */
export function proposeExperienceLearningFromDelivery(input: Readonly<{
  readonly activeBehaviorDigest?: string;
  readonly delivery: ContinuityDelivery;
  readonly draft: ExperienceLearningProposalDraft;
}>): ExperienceLearningProposalResult {
  try {
    return composeExperienceLearningProposal(input);
  } catch {
    return held("invalid-proposal");
  }
}

function composeExperienceLearningProposal(input: Readonly<{
  readonly activeBehaviorDigest?: string;
  readonly delivery: ContinuityDelivery;
  readonly draft: ExperienceLearningProposalDraft;
}>): ExperienceLearningProposalResult {
  const source = projectExperienceLearningSource(input.delivery);
  if (source.status === "held") return held(source.reason);
  if (input.draft.scope.threadId !== input.delivery.threadId) {
    return held("scope-mismatch");
  }
  const candidate = proposeExperienceLearningCandidate({
    activeBehaviorDigest: input.activeBehaviorDigest ?? source.sourceRun.behaviorDigest,
    expectedBenefit: input.draft.expectedBenefit,
    expiresAt: input.draft.expiresAt,
    experienceId: input.draft.experienceId,
    outcome: source.outcome,
    proposedAt: input.draft.proposedAt,
    proposedBehavior: input.draft.proposedBehavior,
    proposedChange: input.draft.proposedChange,
    scope: input.draft.scope,
    sourceRun: source.sourceRun
  });
  return candidate
    ? Object.freeze({ candidate, status: "proposed" as const })
    : held("invalid-proposal");
}

function held(
  reason: Extract<ExperienceLearningProposalResult, { status: "held" }>["reason"]
): ExperienceLearningProposalResult {
  return Object.freeze({ reason, status: "held" as const });
}
