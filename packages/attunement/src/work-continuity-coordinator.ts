import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  isCanonicalWorkId,
  readWorkStoreSnapshot,
  resolveWorkId,
  withFileLock,
  withFileMutationQueue,
  writeWorkStoreStateUnlocked,
  type PersistedWork,
  type WorkStoreSnapshot
} from "@muse/stores";

import {
  AttunementStoreError,
  readAttunementState,
  writeAttunementState
} from "./attunement-store.js";
import type { ArtifactLink, AttunementState, PersonalThread } from "./types.js";
import { projectWorkContinuity } from "./work-artifact.js";

export interface WorkContinuityFiles {
  readonly attunementFile: string;
  readonly worksFile: string;
}

export interface WorkContinuityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

interface LockedPair {
  readonly attunement: AttunementState;
  readonly attunementFile: string;
  readonly workSnapshot: WorkStoreSnapshot;
  readonly worksFile: string;
}

async function canonicalTarget(file: string): Promise<string> {
  const absolute = resolve(file);
  try {
    return await fs.realpath(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const unresolved = await fs.lstat(absolute).catch(() => undefined);
  if (unresolved?.isSymbolicLink()) throw new AttunementStoreError(`store path '${absolute}' is a dangling symlink`);
  const parent = await fs.realpath(dirname(absolute)).catch(() => resolve(dirname(absolute)));
  return join(parent, basename(absolute));
}

async function withOrderedPair<T>(files: WorkContinuityFiles, env: NodeJS.ProcessEnv | undefined, operation: (pair: LockedPair) => Promise<T>): Promise<T> {
  const attunementFile = await canonicalTarget(files.attunementFile);
  const worksFile = await canonicalTarget(files.worksFile);
  if (attunementFile === worksFile) throw new AttunementStoreError("Work and Attunement stores must be different files");
  const ordered = [attunementFile, worksFile].sort((left, right) => left.localeCompare(right));
  return withFileMutationQueue(ordered[0]!, () => withFileMutationQueue(ordered[1]!, () =>
    withFileLock(ordered[0]!, () => withFileLock(ordered[1]!, async () => operation({
      attunement: await readAttunementState(attunementFile),
      attunementFile,
      workSnapshot: await readWorkStoreSnapshot(worksFile, env),
      worksFile
    }))))) as Promise<T>;
}

function requireThread(state: AttunementState, threadId: string): PersonalThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new AttunementStoreError(`no continuity thread with id '${threadId}'`);
  return thread;
}

function replaceThread(state: AttunementState, thread: PersonalThread): AttunementState {
  return { ...state, threads: state.threads.map((candidate) => candidate.id === thread.id ? thread : candidate) };
}

function requireWork(works: readonly PersistedWork[], idOrPrefix: string): PersistedWork {
  const id = resolveWorkId(works, idOrPrefix);
  const work = id ? works.find((candidate) => candidate.id === id) : undefined;
  if (!work) throw new AttunementStoreError(`no work with id '${idOrPrefix}'`);
  return work;
}

function workLinks(state: AttunementState, workId: string): readonly ArtifactLink[] {
  return state.threads.flatMap((thread) => thread.links.filter((link) => link.artifactType === "work" && link.artifactId === workId));
}

export async function linkWorkContinuity(
  files: WorkContinuityFiles,
  input: { readonly threadId: string; readonly workId: string },
  options: WorkContinuityOptions = {}
): Promise<{ readonly created: boolean; readonly link: ArtifactLink }> {
  if (!isCanonicalWorkId(input.workId)) throw new AttunementStoreError("Work continuity requires a canonical full Work id");
  return withOrderedPair(files, options.env, async ({ attunement, attunementFile, workSnapshot }) => {
    const thread = requireThread(attunement, input.threadId);
    const work = workSnapshot.works.find((candidate) => candidate.id === input.workId);
    if (!work) throw new AttunementStoreError(`no local Work with exact id '${input.workId}'`);
    projectWorkContinuity(work, input.workId);
    if (work.threadId !== undefined && work.threadId !== thread.id) throw new AttunementStoreError(`Work '${work.id}' belongs to another PersonalThread`);
    const links = workLinks(attunement, work.id);
    const existing = links.find((link) => link.threadId === thread.id);
    if (existing) return { created: false, link: existing };
    if (links.length > 0) throw new AttunementStoreError(`Work '${work.id}' is already linked to another PersonalThread`);
    const link: ArtifactLink = {
      artifactId: work.id,
      artifactType: "work",
      linkedAt: (options.now ?? (() => new Date()))().toISOString(),
      linkedBy: "user",
      providerId: "local",
      role: "context",
      threadId: thread.id
    };
    await writeAttunementState(attunementFile, replaceThread(attunement, { ...thread, links: [...thread.links, link] }));
    return { created: true, link };
  });
}

export async function unlinkWorkContinuity(
  files: WorkContinuityFiles,
  input: { readonly threadId: string; readonly workId: string },
  options: WorkContinuityOptions = {}
): Promise<boolean> {
  return withOrderedPair(files, options.env, async ({ attunement, attunementFile }) => {
    const thread = requireThread(attunement, input.threadId);
    const links = thread.links.filter((link) => !(link.artifactType === "work" && link.artifactId === input.workId));
    if (links.length === thread.links.length) return false;
    await writeAttunementState(attunementFile, replaceThread(attunement, { ...thread, links }));
    return true;
  });
}

export async function setWorkContinuityThread(
  files: WorkContinuityFiles,
  input: { readonly threadId?: string; readonly workId: string },
  options: WorkContinuityOptions = {}
): Promise<PersistedWork> {
  return withOrderedPair(files, options.env, async ({ attunement, workSnapshot, worksFile }) => {
    const work = requireWork(workSnapshot.works, input.workId);
    if (input.threadId !== undefined) requireThread(attunement, input.threadId);
    const links = workLinks(attunement, work.id);
    if (links.some((link) => link.threadId !== input.threadId)) {
      throw new AttunementStoreError(`Work '${work.id}' has a conflicting PersonalThread evidence link; unlink it first`);
    }
    if (work.threadId === input.threadId) return work;
    const { threadId: _oldThreadId, ...withoutThread } = work;
    const updated: PersistedWork = {
      ...withoutThread,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      updatedAtIso: (options.now ?? (() => new Date()))().toISOString()
    };
    const next = workSnapshot.works.map((candidate) => candidate.id === work.id ? updated : candidate);
    await writeWorkStoreStateUnlocked(worksFile, next, workSnapshot.encrypted, options.env);
    return updated;
  });
}

export async function deleteWorkContinuitySafe(
  files: WorkContinuityFiles,
  workId: string,
  options: WorkContinuityOptions = {}
): Promise<boolean> {
  return withOrderedPair(files, options.env, async ({ attunement, workSnapshot, worksFile }) => {
    const resolved = resolveWorkId(workSnapshot.works, workId);
    if (!resolved) return false;
    if (workLinks(attunement, resolved).length > 0) throw new AttunementStoreError(`Work '${resolved}' is linked to Personal Continuity; unlink it first`);
    await writeWorkStoreStateUnlocked(worksFile, workSnapshot.works.filter((work) => work.id !== resolved), workSnapshot.encrypted, options.env);
    return true;
  });
}

export async function deletePersonalThreadWorkSafe(
  files: WorkContinuityFiles,
  threadId: string,
  options: WorkContinuityOptions = {}
): Promise<{ readonly deletedDeliveries: number; readonly deletedResetReceipts: number; readonly thread: PersonalThread }> {
  return withOrderedPair(files, options.env, async ({ attunement, attunementFile, workSnapshot }) => {
    const thread = requireThread(attunement, threadId);
    const bound = workSnapshot.works.find((work) => work.threadId === thread.id);
    if (bound) throw new AttunementStoreError(`PersonalThread '${thread.id}' is assigned to Work '${bound.id}'; clear it first`);
    const resetIds = new Set(attunement.resetReceipts.filter((receipt) => receipt.threadId === thread.id).map((receipt) => receipt.id));
    const deletedDeliveries = attunement.deliveries.filter((delivery) => delivery.threadId === thread.id).length;
    const deletedResetReceipts = resetIds.size;
    await writeAttunementState(attunementFile, {
      ...attunement,
      deliveries: attunement.deliveries.filter((delivery) => delivery.threadId !== thread.id),
      interactionReceipts: attunement.interactionReceipts.filter((receipt) => receipt.threadId !== thread.id),
      resetReceipts: attunement.resetReceipts.filter((receipt) => receipt.threadId !== thread.id),
      threads: attunement.threads.filter((candidate) => candidate.id !== thread.id),
      undoResetReceipts: attunement.undoResetReceipts.filter((receipt) => receipt.threadId !== thread.id && !resetIds.has(receipt.resetId))
    });
    return { deletedDeliveries, deletedResetReceipts, thread };
  });
}
