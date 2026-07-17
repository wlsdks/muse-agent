import { AttunementStoreError } from "./attunement-store.js";
import { CONTINUITY_KILL_CRITERION_FIRST_PACKS, orderContinuityDeliveries } from "./evaluation.js";

import type {
  ArtifactLink,
  ArtifactReference,
  AttunementState,
  ExactArtifactResolver,
  PersonalThread,
  ResolvedArtifact
} from "./types.js";

export interface ContinuityReviewEvidence {
  readonly artifact?: ResolvedArtifact;
  readonly reference: ArtifactReference;
  readonly status: "available" | "unavailable";
}

export interface ContinuityReviewItem {
  readonly deliveryId: string;
  readonly evidence: readonly ContinuityReviewEvidence[];
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

function sameArtifact(left: ArtifactLink, right: ArtifactReference): boolean {
  return left.artifactId === right.artifactId
    && left.artifactType === right.artifactType
    && left.providerId === right.providerId
    && left.role === right.role;
}

/** Read-only first-20 review preparation from persisted deliveries and current exact links. */
export async function prepareContinuityReview(
  state: AttunementState,
  resolveExactArtifact: ExactArtifactResolver
): Promise<ContinuityReview> {
  const eligible = orderContinuityDeliveries(state.deliveries)
    .slice(0, CONTINUITY_KILL_CRITERION_FIRST_PACKS);
  const reviewedDeliveries = eligible.filter((delivery) => delivery.outcome !== undefined).length;
  const progress = {
    eligibleDeliveries: eligible.length,
    remainingFeedback: eligible.length - reviewedDeliveries,
    remainingPacks: CONTINUITY_KILL_CRITERION_FIRST_PACKS - eligible.length,
    reviewedDeliveries,
    target: CONTINUITY_KILL_CRITERION_FIRST_PACKS
  };
  const pending = eligible.find((delivery) => delivery.outcome === undefined);
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
      openedAt: pending.openedAt,
      thread: { id: thread.id, kind: thread.kind, title: thread.title }
    },
    progress
  };
}
