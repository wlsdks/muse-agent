import { resolve } from "node:path";

import { readWorkStoreSnapshot, withFileLock, withFileMutationQueue } from "@muse/stores";

import { readAttunementState, writeAttunementState } from "./attunement-store.js";
import {
  ObserveStoreError,
  canonicalObserveTarget,
  readObserveState,
  resumeObserveSessionTransition,
  startObserveSessionTransition,
  writeObserveStateUnlocked,
  type ObserveSession,
  type ObserveStoreOptions
} from "./observe-store.js";
import type { AttunementState, PersonalThread } from "./types.js";

export interface ObserveContinuityFiles {
  readonly attunementFile: string;
  readonly observeFile?: string;
}

export interface PersonalContinuityFiles extends ObserveContinuityFiles {
  readonly worksFile: string;
}

export function resolveObserveStateFile(attunementFile: string): string {
  return `${attunementFile}.observe.json`;
}

export async function startObserveSessionSafe(
  files: ObserveContinuityFiles,
  input: { readonly acceptVersion: number; readonly threadId: string },
  options: ObserveStoreOptions = {}
): Promise<ObserveSession> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    requireThread(attunement, input.threadId);
    const transition = startObserveSessionTransition(observe, input, options);
    await writeObserveStateUnlocked(observeFile, transition.state);
    return transition.result;
  });
}

export async function resumeObserveSessionSafe(
  files: ObserveContinuityFiles,
  sessionId: string,
  options: ObserveStoreOptions = {}
): Promise<ObserveSession> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    const transition = resumeObserveSessionTransition(observe, sessionId, options);
    requireThread(attunement, transition.result.threadId);
    if (transition.changed) await writeObserveStateUnlocked(observeFile, transition.state);
    return transition.result;
  });
}

/**
 * Production thread deletion gate. A thread cannot disappear while Work or
 * Observe still has an exact reference to it.
 */
export async function deletePersonalThreadContinuitySafe(
  files: PersonalContinuityFiles,
  threadId: string,
  options: { readonly env?: NodeJS.ProcessEnv } = {}
): Promise<{ readonly deletedDeliveries: number; readonly deletedResetReceipts: number; readonly thread: PersonalThread }> {
  const attunementFile = await canonicalObserveTarget(files.attunementFile);
  const observeFile = await canonicalObserveTarget(files.observeFile ?? resolveObserveStateFile(files.attunementFile));
  const worksFile = await canonicalObserveTarget(files.worksFile);
  return withOrderedFiles([attunementFile, observeFile, worksFile], async () => {
    const [attunement, observe, workSnapshot] = await Promise.all([
      readAttunementState(attunementFile),
      readObserveState(observeFile),
      readWorkStoreSnapshot(worksFile, options.env)
    ]);
    const thread = requireThread(attunement, threadId);
    const bound = workSnapshot.works.find((work) => work.threadId === thread.id);
    if (bound) throw new ObserveStoreError("conflict", `PersonalThread '${thread.id}' is assigned to Work '${bound.id}'; clear it first`);
    if (observe.sessions.some((session) => session.threadId === thread.id)) {
      throw new ObserveStoreError("conflict", `PersonalThread '${thread.id}' still has Observe history; forget it first`);
    }
    const resetIds = new Set(attunement.resetReceipts.filter((receipt) => receipt.threadId === thread.id).map((receipt) => receipt.id));
    const deletedDeliveries = attunement.deliveries.filter((delivery) => delivery.threadId === thread.id).length;
    await writeAttunementState(attunementFile, {
      ...attunement,
      deliveries: attunement.deliveries.filter((delivery) => delivery.threadId !== thread.id),
      interactionReceipts: attunement.interactionReceipts.filter((receipt) => receipt.threadId !== thread.id),
      resetReceipts: attunement.resetReceipts.filter((receipt) => receipt.threadId !== thread.id),
      threads: attunement.threads.filter((candidate) => candidate.id !== thread.id),
      undoResetReceipts: attunement.undoResetReceipts.filter((receipt) => receipt.threadId !== thread.id && !resetIds.has(receipt.resetId))
    });
    return { deletedDeliveries, deletedResetReceipts: resetIds.size, thread };
  });
}

async function withAttunementAndObserve<T>(
  files: ObserveContinuityFiles,
  operation: (snapshots: { readonly attunement: AttunementState; readonly observe: Awaited<ReturnType<typeof readObserveState>>; readonly observeFile: string }) => Promise<T>
): Promise<T> {
  const attunementFile = await canonicalObserveTarget(files.attunementFile);
  const observeFile = await canonicalObserveTarget(files.observeFile ?? resolveObserveStateFile(files.attunementFile));
  return withOrderedFiles([attunementFile, observeFile], async () => operation({
    attunement: await readAttunementState(attunementFile),
    observe: await readObserveState(observeFile),
    observeFile
  }));
}

async function withOrderedFiles<T>(input: readonly string[], operation: () => Promise<T>): Promise<T> {
  const files = [...new Set(input.map((file) => resolve(file)))].sort((left, right) => left.localeCompare(right));
  if (files.length !== input.length) throw new ObserveStoreError("invalid", "continuity stores must be different files");
  const enter = (index: number): Promise<T> => index === files.length
    ? operation()
    : withFileMutationQueue(files[index]!, () => withFileLock(files[index]!, () => enter(index + 1))) as Promise<T>;
  return enter(0);
}

function requireThread(state: AttunementState, threadId: string): PersonalThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new ObserveStoreError("not-found", `PersonalThread '${threadId}' does not exist`);
  return thread;
}
