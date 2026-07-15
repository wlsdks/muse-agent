import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";

import { baselinePolicy, isBaselinePolicy, policyForOutcome } from "./policy-reducer.js";
import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  DETAIL_LEVELS,
  NEXT_STEP_PRESENTATIONS,
  OUTCOMES,
  SUPPRESSION_MODES,
  THREAD_KINDS,
  isCoherentArtifactProvider,
  isValidProviderId,
  type ArtifactLink,
  type ArtifactReference,
  type AttunementState,
  type ContinuityDelivery,
  type ContinuityOutcome,
  type PersonalThread,
  type PersonalThreadKind,
  type PolicyResetReceipt,
  type UndoResetReceipt
} from "./types.js";

export class AttunementStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttunementStoreError";
  }
}

export interface AttunementStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface CreateThreadInput {
  readonly kind: PersonalThreadKind;
  readonly title: string;
}

export interface LinkArtifactInput {
  readonly artifactId: string;
  readonly artifactType: ArtifactLink["artifactType"];
  /** Defaults to `"local"`; a `resource` MUST pass `mcp:<server>`. */
  readonly providerId?: string;
  readonly role: ArtifactLink["role"];
  readonly threadId: string;
}

/**
 * The provider-facing boundary that proves a supplied source is exact and
 * canonical before the generic store makes it durable. The core deliberately
 * cannot search task titles, resolve a notes vault, or reach an MCP server by
 * itself — the adapter confirms existence and returns the canonical id and the
 * provider it resolved against.
 */
export type ArtifactLinkValidator = (input: {
  readonly artifactId: string;
  readonly artifactType: ArtifactLink["artifactType"];
  readonly providerId: string;
}) => Promise<{
  readonly artifactId: string;
  readonly artifactType: ArtifactLink["artifactType"];
  readonly providerId: string;
}>;

export interface LinkArtifactOptions extends AttunementStoreOptions {
  readonly validateArtifact: ArtifactLinkValidator;
}

export interface UnlinkArtifactInput {
  readonly artifactId: string;
  readonly artifactType: ArtifactLink["artifactType"];
  readonly threadId: string;
}

export interface OpenDeliveryInput {
  readonly evidenceRefs: readonly ArtifactReference[];
  readonly expectedPolicyVersion: number;
  readonly threadId: string;
}

export interface ThreadInspection {
  readonly deliveries: readonly ContinuityDelivery[];
  readonly resetReceipts: readonly PolicyResetReceipt[];
  readonly thread: PersonalThread;
  readonly undoResetReceipts: readonly UndoResetReceipt[];
}

interface Mutation<T> {
  readonly changed: boolean;
  readonly result: T;
  readonly state: AttunementState;
}

const EMPTY_STATE: AttunementState = {
  deliveries: [],
  nextPolicyVersion: 1,
  resetReceipts: [],
  schemaVersion: 1,
  threads: [],
  undoResetReceipts: []
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReference(value: unknown): value is ArtifactReference {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isOneOf(value.artifactType, ARTIFACT_TYPES)
    && isValidProviderId(value.providerId)
    && isCoherentArtifactProvider(value.artifactType, value.providerId)
    && isOneOf(value.role, ARTIFACT_ROLES);
}

function isLink(value: unknown): value is ArtifactLink {
  if (!isRecord(value) || !isReference(value)) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.linkedAt)
    && record.linkedBy === "user"
    && isNonEmptyString(record.threadId);
}

function isPolicy(value: unknown): value is PersonalThread["policy"] {
  return isRecord(value)
    && isOneOf(value.detail, DETAIL_LEVELS)
    && isOneOf(value.nextStep, NEXT_STEP_PRESENTATIONS)
    && isOneOf(value.suppression, SUPPRESSION_MODES)
    && isSafeVersion(value.version);
}

function isThread(value: unknown): value is PersonalThread {
  return isRecord(value)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.id)
    && isOneOf(value.kind, THREAD_KINDS)
    && Array.isArray(value.links)
    && value.links.every(isLink)
    && isPolicy(value.policy)
    && isNonEmptyString(value.title);
}

function isDelivery(value: unknown): value is ContinuityDelivery {
  if (!isRecord(value)
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every(isReference)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.openedAt)
    || !isSafeVersion(value.policyVersion)
    || !isNonEmptyString(value.threadId)) {
    return false;
  }
  if (value.outcome === undefined) return true;
  return isRecord(value.outcome)
    && isOneOf(value.outcome.outcome, OUTCOMES)
    && isSafeVersion(value.outcome.policyVersion)
    && isNonEmptyString(value.outcome.recordedAt);
}

function isResetReceipt(value: unknown): value is PolicyResetReceipt {
  return isRecord(value)
    && isSafeVersion(value.basePolicyVersion)
    && isPolicy(value.beforePolicy)
    && isNonEmptyString(value.id)
    && isSafeVersion(value.resetPolicyVersion)
    && isNonEmptyString(value.threadId);
}

function isUndoResetReceipt(value: unknown): value is UndoResetReceipt {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isSafeVersion(value.previousPolicyVersion)
    && isNonEmptyString(value.resetId)
    && isPolicy(value.restoredPolicy)
    && isNonEmptyString(value.threadId)
    && isNonEmptyString(value.undoneAt)
    && isSafeVersion(value.undoPolicyVersion);
}

function parseState(value: unknown): AttunementState {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.threads)
    || !value.threads.every(isThread)
    || !Array.isArray(value.deliveries)
    || !value.deliveries.every(isDelivery)
    || !Array.isArray(value.resetReceipts)
    || !value.resetReceipts.every(isResetReceipt)
    || !Array.isArray(value.undoResetReceipts)
    || !value.undoResetReceipts.every(isUndoResetReceipt)
    || !isSafeVersion(value.nextPolicyVersion)
    || value.nextPolicyVersion < 1) {
    throw new AttunementStoreError("attunement store is invalid; refusing to guess or overwrite it");
  }
  const state: AttunementState = {
    deliveries: value.deliveries,
    nextPolicyVersion: value.nextPolicyVersion,
    resetReceipts: value.resetReceipts,
    schemaVersion: value.schemaVersion,
    threads: value.threads,
    undoResetReceipts: value.undoResetReceipts
  };
  validateStateRelations(state);
  return state;
}

function nowIso(options: AttunementStoreOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function newId(prefix: string, options: AttunementStoreOptions): string {
  const raw = (options.idFactory ?? randomUUID)().trim();
  if (raw.length === 0) throw new AttunementStoreError("id factory returned an empty id");
  return `${prefix}_${raw}`;
}

function validateTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0) throw new AttunementStoreError("thread title must not be empty");
  return title;
}

/**
 * This is intentionally only the provider-neutral portion of source safety.
 * A provider validator must still prove existence and return a canonical ID,
 * but neither a raw nor a returned note ID may express a path escape.
 */
function assertSafeArtifactId(value: string, artifactType: ArtifactLink["artifactType"], source: string): string {
  const id = value.trim();
  if (id.length === 0) throw new AttunementStoreError(`${source} returned an empty canonical id`);
  if (artifactType === "resource") {
    // An external resource id is opaque to the store (the adapter proved it),
    // but it is still stored and later echoed, so bound it and reject control
    // characters that could corrupt the persisted JSON or terminal output.
    if (id.length > 512) throw new AttunementStoreError(`${source} returned a resource id over the 512-character limit`);
    if (hasControlCharacter(id)) throw new AttunementStoreError(`${source} returned a resource id with control characters`);
    return id;
  }
  if (artifactType !== "note") return id;
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(id)
    || id.includes("\\")
    || id.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AttunementStoreError(`${source} returned an unsafe relative note id`);
  }
  return id;
}

function requireThread(state: AttunementState, threadId: string): PersonalThread {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) throw new AttunementStoreError(`no personal thread with id '${threadId}'`);
  return thread;
}

function replaceThread(state: AttunementState, thread: PersonalThread): AttunementState {
  return { ...state, threads: state.threads.map((candidate) => candidate.id === thread.id ? thread : candidate) };
}

function sameReference(left: ArtifactReference, right: ArtifactReference): boolean {
  return left.artifactId === right.artifactId
    && left.artifactType === right.artifactType
    && left.providerId === right.providerId
    && left.role === right.role;
}

function sameEvidence(left: readonly ArtifactReference[], right: readonly ArtifactReference[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameReference(entry, right[index]!));
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new AttunementStoreError(`attunement store has duplicate ${label}`);
}

/**
 * Shape validation keeps corrupt JSON parseable; this relation validation keeps
 * it safe. In particular, a link cannot be moved to another thread by editing
 * its embedded id, and policy versions cannot be rewound into a stale CAS hit.
 */
function validateStateRelations(state: AttunementState): void {
  assertUnique(state.threads.map((thread) => thread.id), "thread ids");
  assertUnique(state.deliveries.map((delivery) => delivery.id), "delivery ids");
  assertUnique(state.resetReceipts.map((receipt) => receipt.id), "reset receipt ids");
  assertUnique(state.undoResetReceipts.map((receipt) => receipt.id), "undo receipt ids");

  const threads = new Map(state.threads.map((thread) => [thread.id, thread]));
  for (const thread of state.threads) {
    const linkKeys = thread.links.map((link) => `${link.providerId}:${link.artifactType}:${link.artifactId}`);
    assertUnique(linkKeys, `artifact links on thread '${thread.id}'`);
    if (thread.links.some((link) => link.threadId !== thread.id)) {
      throw new AttunementStoreError(`attunement store has a link assigned to the wrong thread '${thread.id}'`);
    }
    const nextSteps = thread.links.filter((link) => link.role === "next-step");
    if (nextSteps.length > 1 || nextSteps.some((link) => link.artifactType !== "task")) {
      throw new AttunementStoreError(`attunement store has an invalid next-step on thread '${thread.id}'`);
    }
  }

  const resetById = new Map(state.resetReceipts.map((receipt) => [receipt.id, receipt]));
  const generatedByThread = new Map<string, number[]>();
  const addVersion = (threadId: string, version: number): void => {
    const versions = generatedByThread.get(threadId) ?? [];
    versions.push(version);
    generatedByThread.set(threadId, versions);
  };

  for (const delivery of state.deliveries) {
    if (!threads.has(delivery.threadId)) throw new AttunementStoreError(`delivery '${delivery.id}' references a missing thread`);
    if (delivery.evidenceRefs.some((reference) => reference.role === "next-step" && reference.artifactType !== "task")) {
      throw new AttunementStoreError(`delivery '${delivery.id}' has a non-task next-step`);
    }
    if (delivery.outcome) {
      if (delivery.outcome.policyVersion <= delivery.policyVersion) {
        throw new AttunementStoreError(`delivery '${delivery.id}' has an outcome at or before its delivery policy version`);
      }
      addVersion(delivery.threadId, delivery.outcome.policyVersion);
    }
  }
  for (const receipt of state.resetReceipts) {
    if (!threads.has(receipt.threadId)) throw new AttunementStoreError(`reset '${receipt.id}' references a missing thread`);
    if (receipt.beforePolicy.version !== receipt.basePolicyVersion || receipt.resetPolicyVersion <= receipt.basePolicyVersion) {
      throw new AttunementStoreError(`reset '${receipt.id}' has inconsistent policy versions`);
    }
    addVersion(receipt.threadId, receipt.resetPolicyVersion);
  }
  for (const receipt of state.undoResetReceipts) {
    const reset = resetById.get(receipt.resetId);
    if (!threads.has(receipt.threadId) || !reset || reset.threadId !== receipt.threadId) {
      throw new AttunementStoreError(`undo reset '${receipt.id}' references an invalid reset or thread`);
    }
    if (receipt.previousPolicyVersion !== reset.resetPolicyVersion
      || receipt.restoredPolicy.version !== receipt.undoPolicyVersion
      || receipt.undoPolicyVersion <= receipt.previousPolicyVersion) {
      throw new AttunementStoreError(`undo reset '${receipt.id}' has inconsistent policy versions`);
    }
    addVersion(receipt.threadId, receipt.undoPolicyVersion);
  }

  const generatedVersions = [...generatedByThread.values()].flat();
  assertUnique(generatedVersions.map(String), "generated policy versions");
  const maximumVersion = Math.max(0, ...generatedVersions, ...state.threads.map((thread) => thread.policy.version));
  if (state.nextPolicyVersion <= maximumVersion) {
    throw new AttunementStoreError("attunement store has a non-monotonic next policy version");
  }
  for (const thread of state.threads) {
    const changes = generatedByThread.get(thread.id) ?? [];
    const expectedVersion = changes.length === 0 ? 0 : Math.max(...changes);
    if (thread.policy.version !== expectedVersion) {
      throw new AttunementStoreError(`thread '${thread.id}' has a policy version that does not match its receipts`);
    }
  }
  for (const delivery of state.deliveries) {
    const availableVersions = new Set([0, ...(generatedByThread.get(delivery.threadId) ?? [])]);
    if (!availableVersions.has(delivery.policyVersion)) {
      throw new AttunementStoreError(`delivery '${delivery.id}' has an unknown policy version`);
    }
  }
}

async function mutate<T>(
  file: string,
  fn: (state: AttunementState) => Mutation<T> | Promise<Mutation<T>>
): Promise<T> {
  return withFileMutationQueue(file, () => withFileLock(file, async () => {
    const state = await readAttunementState(file);
    const mutation = await fn(state);
    if (mutation.changed) await writeAttunementState(file, mutation.state);
    return mutation.result;
  }));
}

export function emptyAttunementState(): AttunementState {
  return EMPTY_STATE;
}

/** Read only. Missing means a new personal continuity space; corrupt means stop. */
export async function readAttunementState(file: string): Promise<AttunementState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw cause;
  }
  try {
    return parseState(JSON.parse(raw) as unknown);
  } catch (cause) {
    if (cause instanceof AttunementStoreError) throw cause;
    throw new AttunementStoreError("attunement store is not valid JSON; refusing to overwrite it");
  }
}

/** Owner-only, fsynced atomic write used only inside a locked mutation (or test seeding). */
export async function writeAttunementState(file: string, state: AttunementState): Promise<void> {
  parseState(state);
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

export async function createPersonalThread(
  file: string,
  input: CreateThreadInput,
  options: AttunementStoreOptions = {}
): Promise<PersonalThread> {
  if (!THREAD_KINDS.includes(input.kind)) throw new AttunementStoreError("thread kind must be life or work");
  const title = validateTitle(input.title);
  return mutate<PersonalThread>(file, (state) => {
    const thread: PersonalThread = {
      createdAt: nowIso(options),
      id: newId("thread", options),
      kind: input.kind,
      links: [],
      policy: baselinePolicy(),
      title
    };
    return { changed: true, result: thread, state: { ...state, threads: [...state.threads, thread] } };
  });
}

/**
 * Stores exactly one user-authored local reference. A next-step must be a task
 * and thread-local singular; changing it is an explicit unlink then link.
 */
export async function linkArtifact(
  file: string,
  input: LinkArtifactInput,
  options: LinkArtifactOptions
): Promise<{ readonly created: boolean; readonly link: ArtifactLink }> {
  if (!ARTIFACT_TYPES.includes(input.artifactType)) throw new AttunementStoreError("artifact type must be task, note, or resource");
  if (!ARTIFACT_ROLES.includes(input.role)) throw new AttunementStoreError("artifact role must be context or next-step");
  if (input.role === "next-step" && input.artifactType !== "task") {
    throw new AttunementStoreError("only a local task can be a next-step");
  }
  const requestedProvider = input.providerId ?? "local";
  if (!isValidProviderId(requestedProvider) || !isCoherentArtifactProvider(input.artifactType, requestedProvider)) {
    throw new AttunementStoreError(
      `provider '${requestedProvider}' does not match a ${input.artifactType} (task/note are 'local'; a resource is 'mcp:<server>')`
    );
  }
  if (typeof options?.validateArtifact !== "function") {
    throw new AttunementStoreError("linking requires an exact artifact validator");
  }
  const validated = await options.validateArtifact({
    artifactId: input.artifactId,
    artifactType: input.artifactType,
    providerId: requestedProvider
  });
  if (validated.artifactType !== input.artifactType) throw new AttunementStoreError("artifact validator changed the artifact type");
  if (validated.providerId !== requestedProvider) throw new AttunementStoreError("artifact validator changed the provider");
  if (!isCoherentArtifactProvider(validated.artifactType, validated.providerId)) {
    throw new AttunementStoreError("artifact validator returned an incoherent provider for this artifact type");
  }
  const providerId = validated.providerId;
  const artifactId = assertSafeArtifactId(validated.artifactId, input.artifactType, "artifact validator");
  return mutate<{ readonly created: boolean; readonly link: ArtifactLink }>(file, (state) => {
    const thread = requireThread(state, input.threadId);
    const existing = thread.links.find((link) =>
      link.artifactType === input.artifactType && link.artifactId === artifactId && link.providerId === providerId);
    if (existing) {
      if (existing.role === input.role) return { changed: false, result: { created: false, link: existing }, state };
      throw new AttunementStoreError(`artifact '${artifactId}' is already linked as ${existing.role}; unlink it before changing its role`);
    }
    if (input.role === "next-step" && thread.links.some((link) => link.role === "next-step")) {
      throw new AttunementStoreError("thread already has a next-step; unlink it before linking another task");
    }
    const link: ArtifactLink = {
      artifactId,
      artifactType: input.artifactType,
      linkedAt: nowIso(options),
      linkedBy: "user",
      providerId,
      role: input.role,
      threadId: thread.id
    };
    const nextThread: PersonalThread = { ...thread, links: [...thread.links, link] };
    return { changed: true, result: { created: true, link }, state: replaceThread(state, nextThread) };
  });
}

export async function unlinkArtifact(file: string, input: UnlinkArtifactInput): Promise<boolean> {
  return mutate<boolean>(file, (state) => {
    const thread = requireThread(state, input.threadId);
    const links = thread.links.filter((link) => !(link.artifactType === input.artifactType && link.artifactId === input.artifactId));
    if (links.length === thread.links.length) return { changed: false, result: false, state };
    return { changed: true, result: true, state: replaceThread(state, { ...thread, links }) };
  });
}

/** Open a feedback-addressable delivery only when it exactly reflects this thread's stored links. */
export async function openContinuityDelivery(
  file: string,
  input: OpenDeliveryInput,
  options: AttunementStoreOptions = {}
): Promise<ContinuityDelivery> {
  return mutate<ContinuityDelivery>(file, (state) => {
    const thread = requireThread(state, input.threadId);
    if (thread.policy.version !== input.expectedPolicyVersion) {
      throw new AttunementStoreError("thread policy changed while building this pack; rebuild before opening it");
    }
    const expectedRefs = thread.links.map(({ artifactId, artifactType, providerId, role }) => ({ artifactId, artifactType, providerId, role }));
    if (!sameEvidence(expectedRefs, input.evidenceRefs)) {
      throw new AttunementStoreError("delivery evidence must exactly match this thread's stored links");
    }
    const delivery: ContinuityDelivery = {
      evidenceRefs: expectedRefs,
      id: newId("delivery", options),
      openedAt: nowIso(options),
      policyVersion: thread.policy.version,
      threadId: thread.id
    };
    return { changed: true, result: delivery, state: { ...state, deliveries: [...state.deliveries, delivery] } };
  });
}

export async function recordContinuityOutcome(
  file: string,
  deliveryId: string,
  outcome: ContinuityOutcome,
  options: AttunementStoreOptions = {}
): Promise<{ readonly applied: boolean; readonly delivery: ContinuityDelivery; readonly policy: PersonalThread["policy"] }> {
  if (!OUTCOMES.includes(outcome)) throw new AttunementStoreError("outcome must be used, adjusted, ignored, or rejected");
  return mutate<{ readonly applied: boolean; readonly delivery: ContinuityDelivery; readonly policy: PersonalThread["policy"] }>(file, (state) => {
    const deliveryIndex = state.deliveries.findIndex((candidate) => candidate.id === deliveryId);
    if (deliveryIndex < 0) throw new AttunementStoreError(`no continuity delivery with id '${deliveryId}'`);
    const delivery = state.deliveries[deliveryIndex]!;
    const thread = requireThread(state, delivery.threadId);
    if (delivery.outcome) {
      if (delivery.outcome.outcome !== outcome) {
        throw new AttunementStoreError(`delivery '${deliveryId}' already recorded outcome '${delivery.outcome.outcome}'; outcomes cannot be overwritten`);
      }
      return { changed: false, result: { applied: false, delivery, policy: thread.policy }, state };
    }
    const version = state.nextPolicyVersion;
    const policy = policyForOutcome(outcome, version);
    const updatedDelivery: ContinuityDelivery = {
      ...delivery,
      outcome: { outcome, policyVersion: version, recordedAt: nowIso(options) }
    };
    const deliveries = [...state.deliveries];
    deliveries[deliveryIndex] = updatedDelivery;
    const nextThread: PersonalThread = { ...thread, policy };
    return {
      changed: true,
      result: { applied: true, delivery: updatedDelivery, policy },
      state: { ...replaceThread(state, nextThread), deliveries, nextPolicyVersion: version + 1 }
    };
  });
}

export async function resetThreadPolicy(
  file: string,
  threadId: string,
  options: AttunementStoreOptions = {}
): Promise<{ readonly alreadyBaseline: boolean; readonly receipt?: PolicyResetReceipt; readonly thread: PersonalThread }> {
  return mutate<{ readonly alreadyBaseline: boolean; readonly receipt?: PolicyResetReceipt; readonly thread: PersonalThread }>(file, (state) => {
    const thread = requireThread(state, threadId);
    if (isBaselinePolicy(thread.policy)) return { changed: false, result: { alreadyBaseline: true, thread }, state };
    const resetPolicyVersion = state.nextPolicyVersion;
    const receipt: PolicyResetReceipt = {
      basePolicyVersion: thread.policy.version,
      beforePolicy: thread.policy,
      id: newId("reset", options),
      resetPolicyVersion,
      threadId: thread.id
    };
    const nextThread: PersonalThread = { ...thread, policy: baselinePolicy(resetPolicyVersion) };
    const nextState = replaceThread(state, nextThread);
    return {
      changed: true,
      result: { alreadyBaseline: false, receipt, thread: nextThread },
      state: { ...nextState, nextPolicyVersion: resetPolicyVersion + 1, resetReceipts: [...state.resetReceipts, receipt] }
    };
  });
}

export async function undoThreadReset(
  file: string,
  threadId: string,
  resetId: string,
  options: AttunementStoreOptions = {}
): Promise<{ readonly applied: boolean; readonly receipt: UndoResetReceipt; readonly thread: PersonalThread }> {
  return mutate<{ readonly applied: boolean; readonly receipt: UndoResetReceipt; readonly thread: PersonalThread }>(file, (state) => {
    const existing = state.undoResetReceipts.find((receipt) => receipt.threadId === threadId && receipt.resetId === resetId);
    const thread = requireThread(state, threadId);
    // Replay lookup intentionally precedes CAS: a completed undo is a no-op,
    // even if later policy mutations make the old reset stale.
    if (existing) return { changed: false, result: { applied: false, receipt: existing, thread }, state };
    const reset = state.resetReceipts.find((receipt) => receipt.id === resetId && receipt.threadId === threadId);
    if (!reset) throw new AttunementStoreError(`no reset '${resetId}' belongs to thread '${threadId}'`);
    if (thread.policy.version !== reset.resetPolicyVersion) {
      throw new AttunementStoreError("cannot undo a stale reset after another policy change");
    }
    const undoPolicyVersion = state.nextPolicyVersion;
    const restoredPolicy = { ...reset.beforePolicy, version: undoPolicyVersion };
    const receipt: UndoResetReceipt = {
      id: newId("undo", options),
      previousPolicyVersion: reset.resetPolicyVersion,
      resetId: reset.id,
      restoredPolicy,
      threadId,
      undoneAt: nowIso(options),
      undoPolicyVersion
    };
    const nextThread: PersonalThread = { ...thread, policy: restoredPolicy };
    const nextState = replaceThread(state, nextThread);
    return {
      changed: true,
      result: { applied: true, receipt, thread: nextThread },
      state: { ...nextState, nextPolicyVersion: undoPolicyVersion + 1, undoResetReceipts: [...state.undoResetReceipts, receipt] }
    };
  });
}

export function inspectThread(state: AttunementState, threadId: string): ThreadInspection {
  const thread = requireThread(state, threadId);
  return {
    deliveries: state.deliveries.filter((delivery) => delivery.threadId === threadId),
    resetReceipts: state.resetReceipts.filter((receipt) => receipt.threadId === threadId),
    thread,
    undoResetReceipts: state.undoResetReceipts.filter((receipt) => receipt.threadId === threadId)
  };
}
