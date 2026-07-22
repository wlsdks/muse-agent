import { readLocalRunEvidenceStrict } from "@muse/runtime-state";

import { AttunementStoreError } from "./attunement-store.js";

import type { ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver, ResolvedArtifact } from "./types.js";

export interface RunArtifactOptions {
  readonly allowedWorkspaceRealpath: string;
}

async function readExactRun(options: RunArtifactOptions, reference: string) {
  const result = await readLocalRunEvidenceStrict({
    allowedWorkspaceRealpath: options.allowedWorkspaceRealpath,
    reference
  });
  if (result.kind === "available") return result.evidence;
  if (result.kind === "absent") return undefined;
  throw new AttunementStoreError(result.reason);
}

function projectRun(
  evidence: Awaited<ReturnType<typeof readExactRun>>,
  artifactId: string,
  role: "context" | "next-step"
): ResolvedArtifact | undefined {
  if (!evidence || role !== "context") return undefined;
  return {
    artifactId,
    artifactType: "run",
    providerId: "local",
    role,
    runOutcome: evidence.outcome,
    runRecordedAt: evidence.recordedAt,
    runSuccess: evidence.success,
    runToolNames: evidence.toolNames,
    summary: evidence.answerSummary,
    title: evidence.query
  };
}

export function createRunArtifactValidator(options: RunArtifactOptions): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId }) => {
    if (artifactType !== "run" || providerId !== "local") {
      throw new AttunementStoreError("run validation requires local exact run evidence");
    }
    const evidence = await readExactRun(options, artifactId);
    if (!projectRun(evidence, artifactId, "context")) {
      throw new AttunementStoreError("no local run with that exact Continuity reference");
    }
    return { artifactId, artifactType, providerId };
  };
}

export function createRunExactArtifactResolver(options: RunArtifactOptions): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType !== "run" || link.providerId !== "local" || link.role !== "context") return undefined;
    return projectRun(await readExactRun(options, link.artifactId), link.artifactId, link.role);
  };
}
