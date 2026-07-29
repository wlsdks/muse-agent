import { resolve } from "node:path";
import { promises as fs } from "node:fs";

import { readWorkStoreSnapshot, withFileLock, withFileMutationQueue } from "@muse/stores";

import { readAttunementState, writeAttunementState } from "./attunement-store.js";
import {
  ObserveStoreError,
  canonicalObserveTarget,
  claimObserveLeaseTransition,
  readObserveState,
  reduceObserveSample,
  renewObserveLeaseTransition,
  resumeObserveSessionTransition,
  startObserveSessionTransition,
  writeObserveStateUnlocked,
  type ObserveSession,
  type ObserveAppCategory,
  type ObserveLeaseAuthority,
  type ObserveStoreOptions,
  type ResumeObserveSessionInput,
  type StartObserveSessionInput
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

export async function resolveCanonicalObserveStateFile(attunementFile: string): Promise<string> {
  return `${await canonicalObserveTarget(attunementFile)}.observe.json`;
}

export async function claimObserveLeaseSafe(
  files: ObserveContinuityFiles,
  input: { readonly collectorFingerprint: string; readonly intervalMs: number; readonly now: string; readonly sessionId: string; readonly threadId: string }
): Promise<ObserveLeaseAuthority> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    requireObserveAffiliation(attunement, observe, input.sessionId, input.threadId);
    const transition = claimObserveLeaseTransition(observe, input.sessionId, input.collectorFingerprint, input.intervalMs, input.now);
    if (transition.changed) await writeObserveStateUnlocked(observeFile, transition.state);
    return transition.result;
  });
}

export async function renewObserveLeaseSafe(
  files: ObserveContinuityFiles,
  input: { readonly authority: ObserveLeaseAuthority; readonly intervalMs: number; readonly now: string; readonly sessionId: string; readonly threadId: string }
): Promise<void> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    requireObserveAffiliation(attunement, observe, input.sessionId, input.threadId);
    const transition = renewObserveLeaseTransition(observe, input.sessionId, input.authority, input.intervalMs, input.now);
    if (transition.changed) await writeObserveStateUnlocked(observeFile, transition.state);
  });
}

export async function recordObserveSampleSafe(
  files: ObserveContinuityFiles,
  input: { readonly appCategory: ObserveAppCategory; readonly authority: ObserveLeaseAuthority; readonly observedAt: string; readonly sessionId: string; readonly threadId: string },
  options: ObserveStoreOptions = {}
): Promise<void> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    requireObserveAffiliation(attunement, observe, input.sessionId, input.threadId);
    const lease = observe.collectorLease;
    if (lease === null || lease.collectorFingerprint !== input.authority.collectorFingerprint || lease.fencingToken !== input.authority.fencingToken
      || lease.sessionId !== input.sessionId || lease.expiresAt <= input.observedAt) throw new ObserveStoreError("conflict", "Observe collector authority is no longer current");
    const transition = reduceObserveSample(observe, input.sessionId, input.appCategory, input.observedAt, options);
    if (transition.changed) await writeObserveStateUnlocked(observeFile, transition.state);
  });
}

export async function startObserveSessionSafe(
  files: ObserveContinuityFiles,
  input: StartObserveSessionInput,
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
  input: ResumeObserveSessionInput,
  options: ObserveStoreOptions = {}
): Promise<ObserveSession> {
  return withAttunementAndObserve(files, async ({ attunement, observe, observeFile }) => {
    const transition = resumeObserveSessionTransition(observe, sessionId, input, options);
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
  const observeFile = await canonicalObserveTarget(files.observeFile ?? `${attunementFile}.observe.json`);
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
  const observeFile = await canonicalObserveTarget(files.observeFile ?? `${attunementFile}.observe.json`);
  return withOrderedFiles([attunementFile, observeFile], async () => operation({
    attunement: await readAttunementState(attunementFile),
    observe: await readObserveState(observeFile),
    observeFile
  }));
}

async function withOrderedFiles<T>(input: readonly string[], operation: () => Promise<T>): Promise<T> {
  const files = [...new Set(input.map((file) => resolve(file)))].sort((left, right) => left.localeCompare(right));
  if (files.length !== input.length) throw new ObserveStoreError("invalid", "continuity stores must be different files");
  const validateAndOperate = async (): Promise<T> => {
    const identities = await Promise.all(files.map(async (file) => {
      const stat = await fs.stat(file).catch((cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(cause));
      return stat === undefined ? undefined : `${stat.dev}:${stat.ino}`;
    }));
    const existing = identities.filter((identity): identity is string => identity !== undefined);
    if (new Set(existing).size !== existing.length) throw new ObserveStoreError("invalid", "continuity stores must not alias the same file");
    return operation();
  };
  const enter = (index: number): Promise<T> => index === files.length
    ? validateAndOperate()
    : withFileMutationQueue(files[index]!, () => withFileLock(files[index]!, () => enter(index + 1))) as Promise<T>;
  return enter(0);
}

function requireThread(state: AttunementState, threadId: string): PersonalThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new ObserveStoreError("not-found", `PersonalThread '${threadId}' does not exist`);
  return thread;
}

function requireObserveAffiliation(attunement: AttunementState, observe: Awaited<ReturnType<typeof readObserveState>>, sessionId: string, threadId: string): ObserveSession {
  requireThread(attunement, threadId);
  const session = observe.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new ObserveStoreError("not-found", `Observe session '${sessionId}' does not exist`);
  if (session.threadId !== threadId || session.status !== "active"
    || session.consentVersion !== 2 || session.consentGrant === null) {
    throw new ObserveStoreError("conflict", "Observe session does not match the configured active PersonalThread");
  }
  return session;
}
