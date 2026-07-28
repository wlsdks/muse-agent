import { AttunementStoreError, isContinuityOwnerNote } from "./attunement-store.js";
import { CONTINUITY_KILL_CRITERION_FIRST_PACKS, orderContinuityDeliveries } from "./evaluation.js";

import type {
  ArtifactLink,
  ArtifactReference,
  AttunementState,
  ContinuityOutcome,
  ExactArtifactResolver,
  PersonalThread,
  ResolvedArtifact
} from "./types.js";

type NegativeContinuityOutcome = Exclude<ContinuityOutcome, "used">;
const NEGATIVE_CONTINUITY_OUTCOMES: readonly NegativeContinuityOutcome[] = [
  "adjusted",
  "ignored",
  "rejected"
];

export interface ContinuityReviewEvidence {
  readonly artifact?: ResolvedArtifact;
  readonly reference: ArtifactReference;
  readonly status: "available" | "unavailable";
}

export interface ContinuityReviewItem {
  readonly deliveryId: string;
  readonly evidence: readonly ContinuityReviewEvidence[];
  readonly ineligibleReason?: string;
  readonly openedAt: string;
  readonly thread: Pick<PersonalThread, "id" | "kind" | "title">;
}

export interface ContinuityReview {
  readonly next?: ContinuityReviewItem;
  readonly progress: {
    readonly eligibleDeliveries: number;
    readonly remainingFeedback: number;
    readonly remainingPacks: number;
    readonly reviewedDeliveries: number;
    readonly target: number;
  };
}

export interface ContinuityOwnerReason {
  readonly source: "owner-authored";
  readonly text: string;
}

export interface ContinuityOutcomeReasonItem {
  readonly deliveryId: string;
  readonly outcome: NegativeContinuityOutcome;
  readonly reason: ContinuityOwnerReason;
  readonly recordedAt: string;
  readonly thread: Pick<PersonalThread, "id" | "kind" | "title">;
}

export interface ContinuityOutcomeReasonExclusion {
  readonly deliveryId: string;
  readonly reason: string;
}

/** Read-only negative-outcome evidence. No inferred reason has an input field. */
export interface ContinuityOutcomeReasonProjection {
  readonly excluded: readonly ContinuityOutcomeReasonExclusion[];
  readonly ownerAuthoredReasons: readonly ContinuityOutcomeReasonItem[];
  readonly schemaVersion: 1;
}

function sameArtifact(left: ArtifactLink, right: ArtifactReference): boolean {
  return left.artifactId === right.artifactId
    && left.artifactType === right.artifactType
    && left.providerId === right.providerId
    && left.role === right.role;
}

/**
 * Projects only exact owner-authored reasons for organic negative outcomes.
 * Factual receipts, model explanations, sentiment, and missing notes cannot
 * enter the eligible set.
 */
export function buildContinuityOutcomeReasonProjection(
  state: AttunementState
): ContinuityOutcomeReasonProjection {
  const ownerAuthoredReasons: ContinuityOutcomeReasonItem[] = [];
  const excluded: ContinuityOutcomeReasonExclusion[] = [];
  for (const delivery of orderContinuityDeliveries(state.deliveries)) {
    const thread = state.threads.find((candidate) => candidate.id === delivery.threadId);
    if (!thread) throw new AttunementStoreError(`delivery '${delivery.id}' references a missing thread`);
    const outcome = delivery.outcome;
    const outcomeValue: unknown = outcome?.outcome;
    const ownerNote: unknown = outcome?.ownerNote;
    const exclude = (reason: string): void => {
      excluded.push({ deliveryId: delivery.id, reason });
    };
    if (delivery.evidenceClass !== "organic") {
      exclude(`delivery evidence is ${delivery.evidenceClass}, not organic`);
      continue;
    }
    if (!outcome) {
      exclude("delivery has no explicit outcome");
      continue;
    }
    if (outcome.evidenceClass !== "organic") {
      exclude(`outcome evidence is ${outcome.evidenceClass}, not organic`);
      continue;
    }
    if (outcomeValue === "used") {
      exclude("used is not a negative outcome");
      continue;
    }
    if (!isNegativeContinuityOutcome(outcomeValue)) {
      exclude("outcome value is invalid");
      continue;
    }
    if (ownerNote === undefined) {
      exclude("negative outcome has no owner-authored reason");
      continue;
    }
    if (!isContinuityOwnerNote(ownerNote)) {
      exclude("owner-authored reason is invalid");
      continue;
    }
    ownerAuthoredReasons.push({
      deliveryId: delivery.id,
      outcome: outcomeValue,
      reason: { source: "owner-authored", text: ownerNote },
      recordedAt: outcome.recordedAt,
      thread: { id: thread.id, kind: thread.kind, title: thread.title }
    });
  }
  return { excluded, ownerAuthoredReasons, schemaVersion: 1 };
}

function isNegativeContinuityOutcome(value: unknown): value is NegativeContinuityOutcome {
  return NEGATIVE_CONTINUITY_OUTCOMES.includes(value as NegativeContinuityOutcome);
}

/** Read-only first-20 review preparation from persisted deliveries and current exact links. */
export async function prepareContinuityReview(
  state: AttunementState,
  resolveExactArtifact: ExactArtifactResolver
): Promise<ContinuityReview> {
  const eligible = orderContinuityDeliveries(state.deliveries)
    .filter((delivery) => delivery.evidenceClass === "organic")
    .slice(0, CONTINUITY_KILL_CRITERION_FIRST_PACKS);
  const reviewedDeliveries = eligible.filter((delivery) => delivery.outcome?.evidenceClass === "organic").length;
  const progress = {
    eligibleDeliveries: eligible.length,
    remainingFeedback: eligible.length - reviewedDeliveries,
    remainingPacks: CONTINUITY_KILL_CRITERION_FIRST_PACKS - eligible.length,
    reviewedDeliveries,
    target: CONTINUITY_KILL_CRITERION_FIRST_PACKS
  };
  const pending = eligible.find((delivery) => delivery.outcome?.evidenceClass !== "organic");
  if (!pending) return { progress };

  const thread = state.threads.find((candidate) => candidate.id === pending.threadId);
  if (!thread) throw new AttunementStoreError(`delivery '${pending.id}' references a missing thread`);
  const evidence: ContinuityReviewEvidence[] = [];
  for (const reference of pending.evidenceRefs) {
    const link = thread.links.find((candidate) => sameArtifact(candidate, reference));
    const artifact = link ? await resolveExactArtifact(link) : undefined;
    evidence.push({
      ...(artifact ? { artifact, status: "available" as const } : { status: "unavailable" as const }),
      reference
    });
  }
  return {
    next: {
      deliveryId: pending.id,
      evidence,
      ...(pending.outcome
        ? { ineligibleReason: `existing ${pending.outcome.evidenceClass} feedback is technical-only and immutable; this delivery cannot receive organic feedback` }
        : {}),
      openedAt: pending.openedAt,
      thread: { id: thread.id, kind: thread.kind, title: thread.title }
    },
    progress
  };
}
