import type {
  ArtifactLink,
  AttunementState,
  ContinuityEvidence,
  ContinuityPack,
  ExactArtifactResolver,
  PersonalThread,
  ResolvedArtifact
} from "./types.js";
import { fingerprintContinuityTaskState } from "./interaction-evidence.js";

function requireThread(state: AttunementState, threadId: string): PersonalThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error(`no personal thread with id '${threadId}'`);
  }
  return thread;
}

function latestOutcome(state: AttunementState, threadId: string) {
  const deliveries = state.deliveries
    .filter((delivery) => delivery.threadId === threadId && delivery.outcome)
    .sort((left, right) => right.outcome!.recordedAt.localeCompare(left.outcome!.recordedAt));
  return deliveries[0]?.outcome?.outcome;
}

function deriveTemporalState(artifact: ResolvedArtifact, nowMs: number): ResolvedArtifact {
  const dueAt = artifact.artifactType === "task"
    ? artifact.taskDueAt
    : artifact.artifactType === "reminder"
      ? artifact.reminderDueAt
      : undefined;
  if (dueAt === undefined) return artifact;
  const dueMs = Date.parse(dueAt);
  if (!Number.isFinite(dueMs)) {
    if (artifact.artifactType === "task") {
      const { taskDueAt: _invalidDueAt, taskDueState: _invalidDueState, ...withoutInvalidDue } = artifact;
      return withoutInvalidDue;
    }
    const { reminderDueAt: _invalidDueAt, reminderDueState: _invalidDueState, ...withoutInvalidDue } = artifact;
    return withoutInvalidDue;
  }
  if (artifact.artifactType === "reminder") {
    return {
      ...artifact,
      ...(artifact.reminderStatus === "pending"
        ? { reminderDueState: dueMs < nowMs ? "overdue" as const : "due" as const }
        : {})
    };
  }
  return {
    ...artifact,
    taskDueState: artifact.taskStatus === "open" && dueMs < nowMs ? "overdue" : "due"
  };
}

function requireExactResolvedArtifact(link: ArtifactLink, artifact: ResolvedArtifact): ResolvedArtifact {
  if (artifact.artifactId !== link.artifactId) {
    throw new Error(`exact artifact resolver returned mismatched artifactId for '${link.artifactId}'`);
  }
  if (artifact.artifactType !== link.artifactType) {
    throw new Error(`exact artifact resolver returned mismatched artifactType for '${link.artifactId}'`);
  }
  if (artifact.providerId !== link.providerId) {
    throw new Error(`exact artifact resolver returned mismatched providerId for '${link.artifactId}'`);
  }
  if (artifact.role !== link.role) {
    throw new Error(`exact artifact resolver returned mismatched role for '${link.artifactId}'`);
  }
  return artifact;
}

/**
 * Build only from the selected thread's persisted links. Calling code cannot
 * smuggle a pre-resolved task/note list into this function, which is the core
 * source-isolation invariant for Personal Continuity.
 */
export async function buildContinuityPack(
  state: AttunementState,
  threadId: string,
  resolveExactArtifact: ExactArtifactResolver,
  nowMs: number
): Promise<ContinuityPack> {
  const thread = requireThread(state, threadId);
  const evidence: ContinuityEvidence[] = [];
  const nextCandidates: { readonly artifact: ResolvedArtifact; readonly link: ArtifactLink }[] = [];

  for (const link of thread.links) {
    const resolved = await resolveExactArtifact(link);
    const artifact = resolved ? deriveTemporalState(requireExactResolvedArtifact(link, resolved), nowMs) : undefined;
    evidence.push({
      reference: {
        artifactId: link.artifactId,
        artifactType: link.artifactType,
        providerId: link.providerId,
        role: link.role
      },
      ...(artifact ? { artifact, status: "available" as const } : { status: "unavailable" as const })
    });
    if (artifact && link.role === "next-step" && artifact.artifactType === "task" && artifact.taskStatus === "open") {
      nextCandidates.push({ artifact, link });
    }
  }

  // Linking enforces one next-step. Retain this guard at consumption time so a
  // corrupt/manual store edit cannot turn into an arbitrary task choice.
  if (nextCandidates.length > 1) {
    throw new Error(`thread '${threadId}' has more than one open next-step artifact`);
  }

  return {
    deliveryPolicyVersion: thread.policy.version,
    evidence,
    evidenceRefs: evidence.map((entry) => entry.reference),
    ...(nextCandidates.length === 0 ? {} : {
      interactionAnchor: {
        artifactId: nextCandidates[0]!.artifact.artifactId,
        linkedAt: nextCandidates[0]!.link.linkedAt,
        observedStatus: "open" as const,
        openStateFingerprint: fingerprintContinuityTaskState({
          artifactId: nextCandidates[0]!.artifact.artifactId,
          status: "open",
          updatedAt: nextCandidates[0]!.artifact.updatedAt ?? ""
        }),
        providerId: "local" as const,
        role: "next-step" as const
      }
    }),
    ...(thread.policy.nextStep === "hidden" || nextCandidates.length === 0 ? {} : { nextStep: nextCandidates[0]!.artifact }),
    policy: thread.policy,
    ...(thread.policy.suppression === "acknowledge-previous" && latestOutcome(state, threadId)
      ? { previousOutcome: latestOutcome(state, threadId) }
      : {}),
    thread: { id: thread.id, kind: thread.kind, title: thread.title }
  };
}

export interface ContinuityPreparationOptions {
  readonly now?: () => number;
}

/** Read the preparation clock exactly once, then build from exact linked sources. */
export async function prepareContinuityPack(
  state: AttunementState,
  threadId: string,
  resolveExactArtifact: ExactArtifactResolver,
  options: ContinuityPreparationOptions = {}
): Promise<ContinuityPack> {
  const nowMs = (options.now ?? Date.now)();
  return buildContinuityPack(state, threadId, resolveExactArtifact, nowMs);
}
