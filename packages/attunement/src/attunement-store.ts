import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { atomicWriteFile, readTaskByIdStrict } from "@muse/stores";
import { isRecord, parseJson } from "@muse/shared";

import { baselinePolicy, isBaselinePolicy, policyForOutcome } from "./policy-reducer.js";
import { fingerprintContinuityTaskState } from "./interaction-evidence.js";
import { mutateFileState, type FileStateMutation } from "./file-state-mutation.js";
import {
  CONTINUITY_EVIDENCE_CLASSES,
  createOrganicContinuityWriteAuthority,
  resolveContinuityEvidenceClass,
  type ContinuityEvidenceWriteOptions
} from "./evidence-provenance.js";
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
  type ContinuityInteractionAnchor,
  type ContinuityInteractionReceipt,
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

export interface AttunementStoreOptions extends ContinuityEvidenceWriteOptions {
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
  readonly interactionAnchor?: Omit<ContinuityInteractionAnchor, "observedAt">;
  readonly threadId: string;
}

export type RecordContinuityTaskCompletionInteractionResult =
  | { readonly kind: "not-correlated" | "unavailable" }
  | { readonly kind: "recorded"; readonly receipt: ContinuityInteractionReceipt };

export interface ThreadInspection {
  readonly deliveries: readonly ContinuityDelivery[];
  readonly resetReceipts: readonly PolicyResetReceipt[];
  readonly thread: PersonalThread;
  readonly undoResetReceipts: readonly UndoResetReceipt[];
}

const EMPTY_STATE: AttunementState = {
  deliveries: [],
  interactionReceipts: [],
  nextPolicyVersion: 1,
  resetReceipts: [],
  schemaVersion: 4,
  threads: [],
  undoResetReceipts: []
};

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isReference(value: unknown, allowReminder = true): value is ArtifactReference {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isOneOf(value.artifactType, ARTIFACT_TYPES)
    && (allowReminder || value.artifactType !== "reminder")
    && isValidProviderId(value.providerId)
    && isCoherentArtifactProvider(value.artifactType, value.providerId)
    && isOneOf(value.role, ARTIFACT_ROLES);
}

function isLink(value: unknown, allowReminder = true): value is ArtifactLink {
  if (!isRecord(value) || !isReference(value, allowReminder)) return false;
  return isNonEmptyString(value.linkedAt)
    && value.linkedBy === "user"
    && isNonEmptyString(value.threadId);
}

function isPolicy(value: unknown): value is PersonalThread["policy"] {
  return isRecord(value)
    && isOneOf(value.detail, DETAIL_LEVELS)
    && isOneOf(value.nextStep, NEXT_STEP_PRESENTATIONS)
    && isOneOf(value.suppression, SUPPRESSION_MODES)
    && isSafeVersion(value.version);
}

function isThread(value: unknown, allowReminder = true): value is PersonalThread {
  return isRecord(value)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.id)
    && isOneOf(value.kind, THREAD_KINDS)
    && Array.isArray(value.links)
    && value.links.every((link) => isLink(link, allowReminder))
    && isPolicy(value.policy)
    && isNonEmptyString(value.title);
}

function isEvidenceClass(value: unknown): boolean {
  return isOneOf(value, CONTINUITY_EVIDENCE_CLASSES);
}

function isDelivery(value: unknown, requireEvidenceClass = false, allowReminder = true): value is ContinuityDelivery {
  if (!isRecord(value)
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every((reference) => isReference(reference, allowReminder))
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.openedAt)
    || !isSafeVersion(value.policyVersion)
    || !isNonEmptyString(value.threadId)
    || (value.runId !== undefined && !isNonEmptyString(value.runId))
    || (requireEvidenceClass ? !isEvidenceClass(value.evidenceClass) : value.evidenceClass !== undefined && !isEvidenceClass(value.evidenceClass))
    || (value.interactionAnchor !== undefined && !isInteractionAnchor(value.interactionAnchor))) {
    return false;
  }
  if (value.outcome === undefined) return true;
  return isRecord(value.outcome)
    && isOneOf(value.outcome.outcome, OUTCOMES)
    && (requireEvidenceClass ? isEvidenceClass(value.outcome.evidenceClass) : value.outcome.evidenceClass === undefined || isEvidenceClass(value.outcome.evidenceClass))
    && isSafeVersion(value.outcome.policyVersion)
    && isNonEmptyString(value.outcome.recordedAt);
}

function isInteractionAnchor(value: unknown): value is ContinuityInteractionAnchor {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isIsoTimestamp(value.linkedAt)
    && isIsoTimestamp(value.observedAt)
    && value.observedStatus === "open"
    && isFingerprint(value.openStateFingerprint)
    && value.providerId === "local"
    && value.role === "next-step";
}

function isInteractionReceipt(value: unknown, requireEvidenceClass = false): value is ContinuityInteractionReceipt {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isIsoTimestamp(value.completedAt)
    && isNonEmptyString(value.deliveryId)
    && isFingerprint(value.doneStateFingerprint)
    && isNonEmptyString(value.eventId)
    && (requireEvidenceClass ? isEvidenceClass(value.evidenceClass) : value.evidenceClass === undefined || isEvidenceClass(value.evidenceClass))
    && isNonEmptyString(value.id)
    && isIsoTimestamp(value.linkedAt)
    && isFingerprint(value.openStateFingerprint)
    && value.providerId === "local"
    && isIsoTimestamp(value.recordedAt)
    && value.role === "next-step"
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.threadId)
    && value.transition === "open-to-done";
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
  const allowReminder = isRecord(value) && value.schemaVersion === 4;
  if (!isRecord(value)
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4)
    || !Array.isArray(value.threads)
    || !value.threads.every((thread) => isThread(thread, allowReminder))
    || !Array.isArray(value.deliveries)
    || !value.deliveries.every((delivery) => isDelivery(
      delivery,
      value.schemaVersion === 3 || value.schemaVersion === 4,
      allowReminder
    ))
    || !Array.isArray(value.resetReceipts)
    || !value.resetReceipts.every(isResetReceipt)
    || !Array.isArray(value.undoResetReceipts)
    || !value.undoResetReceipts.every(isUndoResetReceipt)
    || ((value.schemaVersion === 2 || value.schemaVersion === 3 || value.schemaVersion === 4)
      && (!Array.isArray(value.interactionReceipts)
        || !value.interactionReceipts.every((receipt) => isInteractionReceipt(receipt, value.schemaVersion === 3 || value.schemaVersion === 4))))
    || !isSafeVersion(value.nextPolicyVersion)
    || value.nextPolicyVersion < 1) {
    throw new AttunementStoreError("attunement store is invalid; refusing to guess or overwrite it");
  }
  const state: AttunementState = {
    deliveries: (value.deliveries as unknown as readonly ContinuityDelivery[]).map((delivery) => ({
      ...delivery,
      evidenceClass: delivery.evidenceClass ?? "unclassified",
      ...(delivery.outcome
        ? { outcome: { ...delivery.outcome, evidenceClass: delivery.outcome.evidenceClass ?? "unclassified" } }
        : {})
    })),
    interactionReceipts: value.schemaVersion === 2 || value.schemaVersion === 3 || value.schemaVersion === 4
      ? (value.interactionReceipts as unknown as readonly ContinuityInteractionReceipt[])
          .map((receipt) => ({ ...receipt, evidenceClass: receipt.evidenceClass ?? "unclassified" }))
      : [],
    nextPolicyVersion: value.nextPolicyVersion,
    resetReceipts: value.resetReceipts,
    schemaVersion: 4,
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
  assertUnique(state.deliveries.flatMap((delivery) => delivery.runId ? [delivery.runId] : []), "delivery run ids");
  assertUnique(state.interactionReceipts.map((receipt) => receipt.id), "interaction receipt ids");
  assertUnique(state.interactionReceipts.map((receipt) => receipt.eventId), "interaction event ids");
  assertUnique(state.interactionReceipts.map((receipt) => receipt.deliveryId), "interaction delivery ids");
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
    if (delivery.interactionAnchor) {
      if (!delivery.runId || (Number.isFinite(Date.parse(delivery.openedAt))
        && delivery.interactionAnchor.observedAt !== delivery.openedAt)
        || !delivery.evidenceRefs.some((reference) => reference.artifactId === delivery.interactionAnchor!.artifactId
          && reference.artifactType === "task" && reference.providerId === "local" && reference.role === "next-step")) {
        throw new AttunementStoreError(`delivery '${delivery.id}' has an invalid interaction anchor`);
      }
    }
    if (delivery.outcome) {
      if (delivery.outcome.policyVersion <= delivery.policyVersion) {
        throw new AttunementStoreError(`delivery '${delivery.id}' has an outcome at or before its delivery policy version`);
      }
      addVersion(delivery.threadId, delivery.outcome.policyVersion);
    }
  }
  const deliveriesById = new Map(state.deliveries.map((delivery) => [delivery.id, delivery]));
  for (const receipt of state.interactionReceipts) {
    const delivery = deliveriesById.get(receipt.deliveryId);
    const anchor = delivery?.interactionAnchor;
    if (!delivery || !anchor || !delivery.runId
      || receipt.artifactId !== anchor.artifactId
      || receipt.linkedAt !== anchor.linkedAt
      || receipt.openStateFingerprint !== anchor.openStateFingerprint
      || receipt.providerId !== anchor.providerId || receipt.role !== anchor.role
      || receipt.runId !== delivery.runId || receipt.threadId !== delivery.threadId
      || Date.parse(receipt.completedAt) <= Date.parse(delivery.openedAt)) {
      throw new AttunementStoreError(`interaction receipt '${receipt.id}' has invalid delivery binding`);
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
  fn: (state: AttunementState) => FileStateMutation<AttunementState, T> | Promise<FileStateMutation<AttunementState, T>>
): Promise<T> {
  return mutateFileState(file, readAttunementState, writeAttunementState, fn);
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
    if (isNodeErrorCode(cause, "ENOENT")) return EMPTY_STATE;
    throw cause;
  }
  try {
    const parsed = parseJson(raw);
    if (parsed === undefined) {
      throw new AttunementStoreError("attunement store is not valid JSON; refusing to overwrite it");
    }
    return parseState(parsed);
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
  if (!ARTIFACT_TYPES.includes(input.artifactType)) throw new AttunementStoreError("artifact type must be task, note, reminder, or resource");
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

/** Delete one user-owned thread and every receipt that is meaningful only within it. */
export async function deletePersonalThread(
  file: string,
  threadId: string
): Promise<{ readonly deletedDeliveries: number; readonly deletedResetReceipts: number; readonly thread: PersonalThread }> {
  return mutate(file, (state) => {
    const thread = requireThread(state, threadId);
    const resetIds = new Set(state.resetReceipts.filter((receipt) => receipt.threadId === thread.id).map((receipt) => receipt.id));
    const deletedDeliveries = state.deliveries.filter((delivery) => delivery.threadId === thread.id).length;
    const deletedResetReceipts = resetIds.size;
    return {
      changed: true,
      result: { deletedDeliveries, deletedResetReceipts, thread },
      state: {
        ...state,
        deliveries: state.deliveries.filter((delivery) => delivery.threadId !== thread.id),
        interactionReceipts: state.interactionReceipts.filter((receipt) => receipt.threadId !== thread.id),
        resetReceipts: state.resetReceipts.filter((receipt) => receipt.threadId !== thread.id),
        threads: state.threads.filter((candidate) => candidate.id !== thread.id),
        undoResetReceipts: state.undoResetReceipts.filter((receipt) => receipt.threadId !== thread.id && !resetIds.has(receipt.resetId))
      }
    };
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
    const openedAt = nowIso(options);
    let interactionAnchor: ContinuityInteractionAnchor | undefined;
    if (input.interactionAnchor) {
      const link = thread.links.find((entry) => entry.artifactId === input.interactionAnchor!.artifactId
        && entry.artifactType === "task"
        && entry.linkedAt === input.interactionAnchor!.linkedAt
        && entry.linkedBy === "user"
        && entry.providerId === "local"
        && entry.role === "next-step");
      if (!link || input.interactionAnchor.observedStatus !== "open"
        || input.interactionAnchor.providerId !== "local" || input.interactionAnchor.role !== "next-step"
        || !isFingerprint(input.interactionAnchor.openStateFingerprint)) {
        throw new AttunementStoreError("delivery interaction anchor must match the exact open local next-step");
      }
      interactionAnchor = { ...input.interactionAnchor, observedAt: openedAt };
    }
    const delivery: ContinuityDelivery = {
      evidenceClass: resolveContinuityEvidenceClass(options),
      evidenceRefs: expectedRefs,
      id: newId("delivery", options),
      ...(interactionAnchor ? { interactionAnchor } : {}),
      openedAt,
      policyVersion: thread.policy.version,
      runId: newId("continuity_run", options),
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
      outcome: {
        evidenceClass: resolveContinuityEvidenceClass(options),
        outcome,
        policyVersion: version,
        recordedAt: nowIso(options)
      }
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

/** Exact production operation: authority is consumed by this one outcome write. */
export function recordProductionAuthorizedContinuityOutcome(
  file: string,
  deliveryId: string,
  outcome: ContinuityOutcome,
  options: Omit<AttunementStoreOptions, "evidenceAuthority" | "evidenceClass"> = {}
): ReturnType<typeof recordContinuityOutcome> {
  return recordContinuityOutcome(file, deliveryId, outcome, {
    ...options,
    evidenceAuthority: createOrganicContinuityWriteAuthority()
  });
}

/**
 * Observe a task completion that already succeeded through a trusted local
 * composition root. The task store and delivery anchor supply every durable
 * fact; callers cannot submit an outcome, event id, timestamp, or scope.
 */
export async function recordContinuityTaskCompletionInteraction(
  file: string,
  tasksFile: string,
  taskId: string,
  options: ContinuityEvidenceWriteOptions = {}
): Promise<RecordContinuityTaskCompletionInteractionResult> {
  let task: Awaited<ReturnType<typeof readTaskByIdStrict>>;
  try {
    task = await readTaskByIdStrict(tasksFile, taskId);
  } catch {
    return { kind: "unavailable" };
  }
  if (!task || task.status !== "done" || !isIsoTimestamp(task.completedAt)) return { kind: "not-correlated" };
  const completedAt = task.completedAt;
  const eventId = `continuity_task_completed_${createHash("sha256")
    .update(`${task.id}\u0000${completedAt}`).digest("hex").slice(0, 24)}`;
  const doneStateFingerprint = fingerprintContinuityTaskState({
    artifactId: task.id,
    status: "done",
    updatedAt: completedAt
  });
  const expectedOpenStateFingerprint = fingerprintContinuityTaskState({
    artifactId: task.id,
    status: "open",
    updatedAt: task.createdAt
  });
  return mutate<RecordContinuityTaskCompletionInteractionResult>(file, (state) => {
    const replay = state.interactionReceipts.find((receipt) => receipt.eventId === eventId);
    if (replay) {
      if (replay.openStateFingerprint !== expectedOpenStateFingerprint) {
        return { changed: false, result: { kind: "not-correlated" }, state };
      }
      if (replay.artifactId !== task.id || replay.completedAt !== completedAt
        || replay.doneStateFingerprint !== doneStateFingerprint) {
        throw new AttunementStoreError("continuity interaction event identity conflicts with existing evidence");
      }
      return { changed: false, result: { kind: "recorded", receipt: replay }, state };
    }
    const candidates = state.deliveries.filter((delivery) => {
      const anchor = delivery.interactionAnchor;
      if (!anchor || !delivery.runId || anchor.artifactId !== task.id
        || anchor.openStateFingerprint !== expectedOpenStateFingerprint
        || state.interactionReceipts.some((receipt) => receipt.deliveryId === delivery.id)
        || Date.parse(completedAt) <= Date.parse(delivery.openedAt)
        || Date.parse(completedAt) <= Date.parse(anchor.observedAt)) return false;
      const thread = state.threads.find((entry) => entry.id === delivery.threadId);
      return thread?.links.some((link) => link.artifactId === anchor.artifactId
        && link.artifactType === "task"
        && link.linkedAt === anchor.linkedAt
        && link.linkedBy === "user"
        && link.providerId === "local"
        && link.role === "next-step") ?? false;
    });
    if (candidates.length !== 1) return { changed: false, result: { kind: "not-correlated" }, state };
    const delivery = candidates[0]!;
    const anchor = delivery.interactionAnchor!;
    const receipt: ContinuityInteractionReceipt = {
      artifactId: task.id,
      completedAt,
      deliveryId: delivery.id,
      doneStateFingerprint,
      eventId,
      evidenceClass: resolveContinuityEvidenceClass(options),
      id: `continuity_interaction_${createHash("sha256")
        .update(`${eventId}\u0000${delivery.id}`).digest("hex").slice(0, 24)}`,
      linkedAt: anchor.linkedAt,
      openStateFingerprint: anchor.openStateFingerprint,
      providerId: "local",
      recordedAt: new Date().toISOString(),
      role: "next-step",
      runId: delivery.runId!,
      threadId: delivery.threadId,
      transition: "open-to-done"
    };
    return {
      changed: true,
      result: { kind: "recorded", receipt },
      state: { ...state, interactionReceipts: [...state.interactionReceipts, receipt], schemaVersion: 4 }
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
