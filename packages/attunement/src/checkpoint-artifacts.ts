import { readLocalCheckpointEvidenceStrict } from "@muse/runtime-state";

import { AttunementStoreError } from "./attunement-store.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver, ResolvedArtifact } from "./types.js";

export interface CheckpointArtifactOptions {
  readonly allowedWorkspaceRealpath: string;
  readonly checkpointsDir: string;
}

async function readExactCheckpoint(options: CheckpointArtifactOptions, reference: string) {
  const result = await readLocalCheckpointEvidenceStrict({
    allowedWorkspaceRealpath: options.allowedWorkspaceRealpath,
    checkpointsDir: options.checkpointsDir,
    reference
  });
  if (result.kind === "available") return result.evidence;
  if (result.kind === "absent") return undefined;
  throw new AttunementStoreError(result.reason);
}

function projectCheckpoint(
  evidence: Awaited<ReturnType<typeof readExactCheckpoint>>,
  artifactId: string,
  role: "context" | "next-step"
): ResolvedArtifact | undefined {
  if (!evidence || role !== "context") return undefined;
  return {
    artifactId,
    artifactType: "checkpoint",
    checkpointPhase: evidence.phase,
    checkpointRecordedAt: evidence.recordedAt,
    checkpointStep: evidence.step,
    providerId: "local",
    role,
    summary: `Execution checkpoint ${evidence.step.toString()}:${evidence.phase}`,
    title: evidence.query
  };
}

export function createCheckpointArtifactValidator(options: CheckpointArtifactOptions): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType !== "checkpoint" || providerId !== "local") {
      throw new AttunementStoreError("checkpoint validation requires local exact checkpoint evidence");
    }
    const evidence = await readExactCheckpoint(options, artifactId);
    if (!projectCheckpoint(evidence, artifactId, "context")) {
      throw new AttunementStoreError("no local checkpoint with that exact Continuity reference");
    }
    return { artifactId, artifactType, providerId };
  };
}

export function createCheckpointExactArtifactResolver(options: CheckpointArtifactOptions): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType !== "checkpoint" || link.providerId !== "local" || link.role !== "context") return undefined;
    return projectCheckpoint(await readExactCheckpoint(options, link.artifactId), link.artifactId, link.role);
  };
}
