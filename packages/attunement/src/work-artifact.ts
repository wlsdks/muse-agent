import { isCanonicalWorkId, type PersistedWork } from "@muse/stores";
import { stripUntrustedTerminalChars } from "@muse/shared";

import { AttunementStoreError, type ArtifactLinkValidator } from "./attunement-store.js";
import type { ExactArtifactResolver } from "./types.js";

export type ExactWorkReader = (artifactId: string) => Promise<PersistedWork | undefined>;

export interface WorkArtifactOptions {
  readonly readExactWork: ExactWorkReader;
}

function displayText(value: string, limit: number): string {
  return stripUntrustedTerminalChars(value).replace(/\s+/gu, " ").trim().slice(0, limit);
}

export function projectWorkContinuity(work: PersistedWork, artifactId: string) {
  if (work.id !== artifactId || !isCanonicalWorkId(work.id)) return undefined;
  const title = displayText(work.name, 240);
  const summary = displayText(work.goal, 1_000);
  if (!title || !summary) throw new AttunementStoreError("Work continuity requires a non-empty safe name and goal");
  return {
    summary,
    title,
    workBoardTaskCount: work.boardTaskIds.length,
    workFlowCount: work.flowIds.length,
    workOutcomeCount: work.outcomes.length,
    workStatus: work.status,
    workUpdatedAt: work.updatedAtIso
  };
}

export function createWorkArtifactValidator(options: WorkArtifactOptions): ArtifactLinkValidator {
  return async ({ artifactId, artifactType, providerId, threadId }) => {
    if (artifactType !== "work" || providerId !== "local") throw new AttunementStoreError("Work validation requires the local Work source");
    if (!isCanonicalWorkId(artifactId)) throw new AttunementStoreError("Work validation requires a canonical full Work id");
    const work = await options.readExactWork(artifactId);
    if (!work || work.id !== artifactId) throw new AttunementStoreError(`no local Work with exact id '${artifactId}'`);
    if (typeof threadId !== "string" || threadId.length === 0) throw new AttunementStoreError("Work validation requires the target PersonalThread id");
    if (work.threadId !== undefined && work.threadId !== threadId) {
      throw new AttunementStoreError(`Work '${artifactId}' belongs to another PersonalThread`);
    }
    projectWorkContinuity(work, artifactId);
    return { artifactId, artifactType, providerId };
  };
}

export function createWorkExactArtifactResolver(options: WorkArtifactOptions): ExactArtifactResolver {
  return async (link) => {
    if (link.artifactType !== "work" || link.providerId !== "local" || link.role !== "context") return undefined;
    const work = await options.readExactWork(link.artifactId);
    if (!work) return undefined;
    const projected = projectWorkContinuity(work, link.artifactId);
    return projected ? {
      artifactId: link.artifactId,
      artifactType: "work",
      providerId: "local",
      role: "context",
      ...projected
    } : undefined;
  };
}
