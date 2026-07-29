import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { isRecord, parseStrictJson } from "@muse/shared";
import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";

export const OBSERVE_CONSENT_VERSION = 2 as const;
export const OBSERVE_APP_CATEGORIES = ["communication", "planning", "research", "writing", "building", "other"] as const;
export const OBSERVE_CONSENT_FIELDS = Object.freeze(["appCategory", "startedAt", "endedAt", "durationMs"] as const);
export const OBSERVE_CONSENT_SOURCE = "active-app" as const;
export const OBSERVE_PAUSE_CONTROL = "muse observe pause <sessionId>" as const;
export const OBSERVE_CONSENT_TERMS = [
  "Observe only the exact PersonalThread you choose.",
  `Source ${OBSERVE_CONSENT_SOURCE}; fields ${OBSERVE_CONSENT_FIELDS.join(", ")}; never raw app content.`,
  "Choose an explicit cadence and retention window before enrollment.",
  `Pause collection with ${OBSERVE_PAUSE_CONTROL}, or permanently forget a session.`,
  "Observation never sends a message or performs an action automatically."
] as const;

export type ObserveAppCategory = (typeof OBSERVE_APP_CATEGORIES)[number];
export type ObserveConsentField = (typeof OBSERVE_CONSENT_FIELDS)[number];
export type ObserveSessionStatus = "active" | "paused";
export type ObserveErrorCode = "invalid" | "not-found" | "conflict";

export class ObserveStoreError extends Error {
  constructor(readonly code: ObserveErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObserveStoreError";
  }
}

export interface ObserveConsentGrant {
  readonly cadenceMs: number;
  readonly fields: readonly ObserveConsentField[];
  readonly pauseControl: typeof OBSERVE_PAUSE_CONTROL;
  readonly retentionDays: number;
  readonly source: typeof OBSERVE_CONSENT_SOURCE;
}

export const OBSERVE_CONSENT_TEMPLATE: ObserveConsentGrant = Object.freeze({
  cadenceMs: 10_000,
  fields: OBSERVE_CONSENT_FIELDS,
  pauseControl: OBSERVE_PAUSE_CONTROL,
  retentionDays: 30,
  source: OBSERVE_CONSENT_SOURCE
});

export interface StartObserveSessionInput {
  readonly acceptVersion: number;
  readonly consent: ObserveConsentGrant;
  readonly threadId: string;
}

export interface ObserveSession {
  readonly consentGrant: ObserveConsentGrant | null;
  readonly consentVersion: 1 | 2;
  readonly createdAt: string;
  readonly id: string;
  readonly observedThroughAt: string | null;
  readonly status: ObserveSessionStatus;
  readonly threadId: string;
  readonly updatedAt: string;
}

export interface ObserveObservation {
  readonly appCategory: ObserveAppCategory;
  readonly dataOrigin: "active-app";
  readonly durationMs: number;
  readonly endedAt: string;
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly threadId: string;
}

export interface ObserveActiveSegment {
  readonly appCategory: ObserveAppCategory;
  readonly lastSeenAt: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly threadId: string;
}

export interface ObserveCollectorLease {
  readonly claimedAt: string;
  readonly collectorFingerprint: string;
  readonly expiresAt: string;
  readonly fencingToken: number;
  readonly sessionId: string;
}

export interface ObserveState {
  readonly activeSegments: readonly ObserveActiveSegment[];
  readonly collectorLease: ObserveCollectorLease | null;
  readonly nextFencingToken: number;
  readonly observations: readonly ObserveObservation[];
  readonly schemaVersion: 2;
  readonly sessions: readonly ObserveSession[];
}

export interface ObserveStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface ObserveLeaseAuthority {
  readonly collectorFingerprint: string;
  readonly fencingToken: number;
}

const PHYSICAL_MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_OBSERVATIONS = 500;
const MAX_GAP_MS = 5 * 60_000;
const MAX_OBSERVATION_MS = 24 * 60 * 60_000;
const SESSION_ID = /^observe_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OBSERVATION_ID = /^observe_observation_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

const EMPTY_STATE: ObserveState = {
  activeSegments: [],
  collectorLease: null,
  nextFencingToken: 1,
  observations: [],
  schemaVersion: 2,
  sessions: []
};

export function emptyObserveState(): ObserveState {
  return EMPTY_STATE;
}

export async function observeStatus(file: string): Promise<{
  readonly collector: { readonly expiresAt: string; readonly sessionId: string; readonly state: "active" } | { readonly state: "idle" };
  readonly sessions: readonly ObserveSession[];
}> {
  const state = await readObserveState(file);
  return {
    collector: state.collectorLease === null
      ? { state: "idle" }
      : { expiresAt: state.collectorLease.expiresAt, sessionId: state.collectorLease.sessionId, state: "active" },
    sessions: state.sessions
  };
}

export async function inspectObserveSession(file: string, sessionId: string): Promise<{
  readonly activeSegment: ObserveActiveSegment | null;
  readonly observations: readonly ObserveObservation[];
  readonly session: ObserveSession;
}> {
  const state = await readObserveState(file);
  const session = requireSession(state, sessionId);
  return {
    activeSegment: state.activeSegments.find((entry) => entry.sessionId === session.id) ?? null,
    observations: state.observations.filter((entry) => entry.sessionId === session.id),
    session
  };
}

export async function canonicalObserveTarget(file: string): Promise<string> {
  const absolute = resolve(file);
  try {
    return await fs.realpath(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new ObserveStoreError("invalid", "Observe store path cannot be resolved", { cause });
  }
  const leaf = await fs.lstat(absolute).catch(() => undefined);
  if (leaf?.isSymbolicLink()) throw new ObserveStoreError("invalid", "Observe store path is a dangling symlink");
  let parent: string;
  try {
    parent = await fs.realpath(dirname(absolute));
  } catch (cause) {
    throw new ObserveStoreError("invalid", "Observe store parent cannot be resolved", { cause });
  }
  return join(parent, basename(absolute));
}

export async function readObserveState(file: string): Promise<ObserveState> {
  const target = await canonicalObserveTarget(file);
  const entry = await fs.lstat(target).catch((cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(cause));
  if (entry?.isSymbolicLink()) throw new ObserveStoreError("conflict", "Observe store target changed to a symbolic link");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
    throw new ObserveStoreError("invalid", "Observe store cannot be opened", { cause });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || entry === undefined || entry.dev !== before.dev || entry.ino !== before.ino) throw new ObserveStoreError("conflict", "Observe store identity changed before it was opened");
    if (before.size > PHYSICAL_MAX_BYTES) throw new ObserveStoreError("invalid", "Observe store exceeds the physical size limit");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await fs.lstat(target).catch(() => undefined);
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || pathAfter === undefined || pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new ObserveStoreError("conflict", "Observe store changed while it was being read");
    }
    if (bytes.byteLength > CONTENT_MAX_BYTES) throw new ObserveStoreError("invalid", "Observe store exceeds the content size limit");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new ObserveStoreError("invalid", "Observe store is not valid UTF-8", { cause });
    }
    try {
      return parseObserveState(parseStrictJson(text, {
        maxArrayItems: 500,
        maxDepth: 8,
        maxNodes: 50_000,
        maxObjectMembers: 10_000
      }));
    } catch (cause) {
      if (cause instanceof ObserveStoreError) throw cause;
      throw new ObserveStoreError("invalid", "Observe store contains invalid JSON", { cause });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function startObserveSession(
  file: string,
  input: StartObserveSessionInput,
  options: ObserveStoreOptions = {}
): Promise<ObserveSession> {
  return mutateObserveState(file, (state) => startObserveSessionTransition(state, input, options));
}

/** Internal pure transition used by the canonical cross-store coordinator. */
export function startObserveSessionTransition(
  state: ObserveState,
  input: StartObserveSessionInput,
  options: ObserveStoreOptions = {}
): Mutation<ObserveSession> {
  if (input.acceptVersion !== OBSERVE_CONSENT_VERSION) throw new ObserveStoreError("invalid", "Observe consent version must be accepted exactly");
  const consentGrant = parseConsentGrant(input.consent);
  assertThreadId(input.threadId);
  if (state.sessions.length >= MAX_SESSIONS) throw new ObserveStoreError("conflict", "Observe session limit reached; forget an older session first");
  if (state.sessions.some((session) => session.status === "active")) throw new ObserveStoreError("conflict", "another Observe session is already active");
  const now = optionTime(options);
  const session: ObserveSession = {
    consentGrant,
    consentVersion: 2,
    createdAt: now,
    id: makeId("observe", options),
    observedThroughAt: null,
    status: "active",
    threadId: input.threadId,
    updatedAt: now
  };
  return { changed: true, result: session, state: { ...state, sessions: [...state.sessions, session] } };
}

export async function pauseObserveSession(file: string, sessionId: string, options: ObserveStoreOptions = {}): Promise<ObserveSession> {
  return mutateObserveState(file, (state) => {
    const session = requireSession(state, sessionId);
    if (session.status === "paused") return { changed: false, result: session, state };
    const segment = state.activeSegments.find((entry) => entry.sessionId === session.id);
    const observations = segment && segment.lastSeenAt > segment.startedAt
      ? appendObservation(state.observations, observationFromSegment(segment, segment.lastSeenAt, options))
      : state.observations;
    const updated = { ...session, status: "paused" as const, updatedAt: lifecycleTime(session, options) };
    return {
      changed: true,
      result: updated,
      state: {
        ...state,
        activeSegments: state.activeSegments.filter((entry) => entry.sessionId !== session.id),
        collectorLease: state.collectorLease?.sessionId === session.id ? null : state.collectorLease,
        observations,
        sessions: replaceSession(state.sessions, updated)
      }
    };
  });
}

export async function resumeObserveSession(file: string, sessionId: string, options: ObserveStoreOptions = {}): Promise<ObserveSession> {
  return mutateObserveState(file, (state) => resumeObserveSessionTransition(state, sessionId, options));
}

/** Internal pure transition used by the canonical cross-store coordinator. */
export function resumeObserveSessionTransition(state: ObserveState, sessionId: string, options: ObserveStoreOptions = {}): Mutation<ObserveSession> {
  const session = requireSession(state, sessionId);
  if (session.consentVersion !== 2 || session.consentGrant === null) {
    throw new ObserveStoreError("conflict", "legacy Observe session requires a new explicit consent enrollment");
  }
  if (session.status === "active") return { changed: false, result: session, state };
  if (state.sessions.some((entry) => entry.id !== session.id && entry.status === "active")) throw new ObserveStoreError("conflict", "another Observe session is already active");
  const updated = { ...session, status: "active" as const, updatedAt: lifecycleTime(session, options) };
  return { changed: true, result: updated, state: { ...state, sessions: replaceSession(state.sessions, updated) } };
}

export async function forgetObserveSession(file: string, sessionId: string): Promise<{ readonly deletedObservations: number }> {
  return mutateObserveState(file, (state) => {
    const session = requireSession(state, sessionId);
    const observations = state.observations.filter((entry) => entry.sessionId !== session.id);
    return {
      changed: true,
      result: { deletedObservations: state.observations.length - observations.length },
      state: {
        ...state,
        activeSegments: state.activeSegments.filter((entry) => entry.sessionId !== session.id),
        collectorLease: state.collectorLease?.sessionId === session.id ? null : state.collectorLease,
        observations,
        sessions: state.sessions.filter((entry) => entry.id !== session.id)
      }
    };
  });
}

/** Host-only primitive. Do not export this symbol from the package main barrel. */
export async function recordObserveSample(
  file: string,
  sessionId: string,
  appCategory: ObserveAppCategory,
  observedAt: string,
  authority: ObserveLeaseAuthority,
  options: ObserveStoreOptions = {}
): Promise<void> {
  assertCategory(appCategory);
  assertTime(observedAt);
  await mutateObserveState(file, (state) => {
    assertLeaseAuthority(state, sessionId, authority, observedAt);
    return reduceObserveSample(state, sessionId, appCategory, observedAt, options);
  });
}

/** Pure deterministic sample reducer; it has no persistence or lease authority. */
export function reduceObserveSample(
  state: ObserveState,
  sessionId: string,
  appCategory: ObserveAppCategory,
  observedAt: string,
  options: ObserveStoreOptions = {}
): Mutation<void> {
  assertCategory(appCategory);
  assertTime(observedAt);
  const session = requireSession(state, sessionId);
  if (session.status !== "active") throw new ObserveStoreError("conflict", "Observe session is paused");
  const segment = state.activeSegments.find((entry) => entry.sessionId === session.id);
  const latestEnd = state.observations.filter((entry) => entry.sessionId === session.id).reduce<string | undefined>((latest, entry) => latest === undefined || entry.endedAt > latest ? entry.endedAt : latest, undefined);
  const watermark = [session.createdAt, session.updatedAt, session.observedThroughAt, latestEnd, segment?.lastSeenAt]
    .filter((entry): entry is string => entry !== null && entry !== undefined)
    .reduce((latest, entry) => entry > latest ? entry : latest);
  if (observedAt < watermark) throw new ObserveStoreError("conflict", "Observe sample is stale");
  if (segment?.lastSeenAt === observedAt && segment.appCategory === appCategory) return { changed: false, result: undefined, state };

  const updatedSession: ObserveSession = { ...session, observedThroughAt: observedAt };
  let observations = state.observations;
  let nextSegment: ObserveActiveSegment;
  if (!segment) {
    nextSegment = newSegment(updatedSession, appCategory, observedAt);
  } else if (observedAt === segment.lastSeenAt) {
    if (appCategory > segment.appCategory) return { changed: false, result: undefined, state };
    if (segment.lastSeenAt > segment.startedAt) observations = appendObservation(observations, observationFromSegment(segment, observedAt, options));
    nextSegment = newSegment(updatedSession, appCategory, observedAt);
  } else {
    const gapMs = timeMs(observedAt) - timeMs(segment.lastSeenAt);
    const ageMs = timeMs(observedAt) - timeMs(segment.startedAt);
    if (gapMs > MAX_GAP_MS) {
      if (segment.lastSeenAt > segment.startedAt) observations = appendObservation(observations, observationFromSegment(segment, segment.lastSeenAt, options));
      nextSegment = newSegment(updatedSession, appCategory, observedAt);
    } else if (ageMs >= MAX_OBSERVATION_MS) {
      const cappedAt = new Date(timeMs(segment.startedAt) + MAX_OBSERVATION_MS).toISOString();
      observations = appendObservation(observations, observationFromSegment(segment, cappedAt, options));
      nextSegment = newSegment(updatedSession, appCategory, observedAt);
    } else if (segment.appCategory === appCategory) {
      nextSegment = { ...segment, lastSeenAt: observedAt };
    } else {
      observations = appendObservation(observations, observationFromSegment(segment, observedAt, options));
      nextSegment = newSegment(updatedSession, appCategory, observedAt);
    }
  }
  return {
    changed: true,
    result: undefined,
    state: {
      ...state,
      activeSegments: [nextSegment],
      observations,
      sessions: replaceSession(state.sessions, updatedSession)
    }
  };
}

/** Host-only primitive. The public package barrel deliberately omits it. */
export async function claimObserveLease(
  file: string,
  sessionId: string,
  collectorFingerprint: string,
  intervalMs: number,
  now: string
): Promise<ObserveLeaseAuthority> {
  return mutateObserveState(file, (state) => claimObserveLeaseTransition(state, sessionId, collectorFingerprint, intervalMs, now));
}

export function claimObserveLeaseTransition(
  state: ObserveState,
  sessionId: string,
  collectorFingerprint: string,
  intervalMs: number,
  now: string
): Mutation<ObserveLeaseAuthority> {
  assertFingerprint(collectorFingerprint);
  assertInterval(intervalMs);
  assertTime(now);
  const ttlMs = Math.max(30_000, intervalMs * 3);
  const session = requireSession(state, sessionId);
  if (session.status !== "active") throw new ObserveStoreError("conflict", "Observe session is paused");
  const current = state.collectorLease;
  if (current !== null && current.expiresAt > now) {
    if (current.sessionId !== session.id || current.collectorFingerprint !== collectorFingerprint) throw new ObserveStoreError("conflict", "Observe collection is already active");
    const renewed = { ...current, expiresAt: new Date(timeMs(now) + ttlMs).toISOString() };
    return { changed: renewed.expiresAt !== current.expiresAt, result: authorityOf(renewed), state: { ...state, collectorLease: renewed } };
  }
  if (state.nextFencingToken === Number.MAX_SAFE_INTEGER) throw new ObserveStoreError("conflict", "Observe collector fencing tokens are exhausted");
  const lease: ObserveCollectorLease = {
    claimedAt: now,
    collectorFingerprint,
    expiresAt: new Date(timeMs(now) + ttlMs).toISOString(),
    fencingToken: state.nextFencingToken,
    sessionId: session.id
  };
  return {
    changed: true,
    result: authorityOf(lease),
    state: { ...state, collectorLease: lease, nextFencingToken: state.nextFencingToken + 1 }
  };
}

/** Host-only primitive. */
export async function renewObserveLease(
  file: string,
  sessionId: string,
  authority: ObserveLeaseAuthority,
  intervalMs: number,
  now: string
): Promise<void> {
  await mutateObserveState(file, (state) => renewObserveLeaseTransition(state, sessionId, authority, intervalMs, now));
}

export function renewObserveLeaseTransition(state: ObserveState, sessionId: string, authority: ObserveLeaseAuthority, intervalMs: number, now: string): Mutation<void> {
  assertInterval(intervalMs);
  assertTime(now);
  const ttlMs = Math.max(30_000, intervalMs * 3);
  assertLeaseAuthority(state, sessionId, authority, now);
  const lease = state.collectorLease!;
  const renewed = { ...lease, expiresAt: new Date(timeMs(now) + ttlMs).toISOString() };
  return { changed: renewed.expiresAt !== lease.expiresAt, result: undefined, state: { ...state, collectorLease: renewed } };
}

/** Host-only primitive. */
export async function releaseObserveLease(file: string, sessionId: string, authority: ObserveLeaseAuthority): Promise<void> {
  await mutateObserveState(file, (state) => releaseObserveLeaseTransition(state, sessionId, authority));
}

export function releaseObserveLeaseTransition(state: ObserveState, sessionId: string, authority: ObserveLeaseAuthority): Mutation<void> {
  if (state.collectorLease === null) return { changed: false, result: undefined, state };
  assertLeaseAuthority(state, sessionId, authority);
  return { changed: true, result: undefined, state: { ...state, collectorLease: null } };
}

export interface Mutation<Result> { readonly changed: boolean; readonly result: Result; readonly state: ObserveState }

async function mutateObserveState<Result>(file: string, mutate: (state: ObserveState) => Mutation<Result> | Promise<Mutation<Result>>): Promise<Result> {
  const target = await canonicalObserveTarget(file);
  return withFileMutationQueue(target, () => withFileLock(target, async () => {
    const identity = await observePathIdentity(target);
    const current = await readObserveState(target);
    if (await observePathIdentity(target) !== identity) throw new ObserveStoreError("conflict", "Observe store identity changed during mutation read");
    const mutation = await mutate(current);
    if (mutation.changed) {
      if (await observePathIdentity(target) !== identity) throw new ObserveStoreError("conflict", "Observe store identity changed before mutation");
      await writeObserveStateUnlocked(target, mutation.state);
    }
    return mutation.result;
  })) as Promise<Result>;
}

export async function writeObserveStateUnlocked(file: string, state: ObserveState): Promise<void> {
  const validated = parseObserveState(state);
  const bytes = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > CONTENT_MAX_BYTES) throw new ObserveStoreError("invalid", "Observe output exceeds the content size limit");
  parseObserveState(parseStrictJson(bytes, { maxArrayItems: 500, maxDepth: 8, maxNodes: 50_000, maxObjectMembers: 10_000 }));
  await atomicWriteFile(file, bytes);
}

function parseObserveState(value: unknown): ObserveState {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "sessions", "observations", "activeSegments", "collectorLease", "nextFencingToken"])
    || ![1, 2].includes(value.schemaVersion as number) || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS
    || !Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS
    || !Array.isArray(value.activeSegments) || value.activeSegments.length > 1
    || !Number.isSafeInteger(value.nextFencingToken) || (value.nextFencingToken as number) < 1) {
    throw new ObserveStoreError("invalid", "Observe store has an unsupported schema or limit");
  }
  const legacy = value.schemaVersion === 1;
  const sessions = value.sessions.map((session) => parseSession(session, legacy));
  const observations = value.observations.map(parseObservation);
  const activeSegments = value.activeSegments.map(parseSegment);
  const collectorLease = value.collectorLease === null ? null : parseLease(value.collectorLease);
  if (new Set(sessions.map((entry) => entry.id)).size !== sessions.length || new Set(observations.map((entry) => entry.id)).size !== observations.length
    || sessions.filter((entry) => entry.status === "active").length > 1) throw new ObserveStoreError("invalid", "Observe store contains duplicate or conflicting sessions");
  const byId = new Map(sessions.map((entry) => [entry.id, entry]));
  for (const observation of observations) {
    const session = byId.get(observation.sessionId);
    if (!session || session.threadId !== observation.threadId || observation.startedAt < session.createdAt
      || session.observedThroughAt === null || observation.endedAt > session.observedThroughAt) throw new ObserveStoreError("invalid", "Observe store has inconsistent observation relationships");
  }
  for (const session of sessions) {
    const ordered = observations.filter((entry) => entry.sessionId === session.id).sort(compareObservation);
    for (let index = 1; index < ordered.length; index += 1) if (ordered[index - 1]!.endedAt > ordered[index]!.startedAt) throw new ObserveStoreError("invalid", "Observe observations overlap");
  }
  for (const segment of activeSegments) {
    const session = byId.get(segment.sessionId);
    const latest = observations.filter((entry) => entry.sessionId === segment.sessionId).sort(compareObservation).at(-1);
    if (!session || session.status !== "active" || session.threadId !== segment.threadId || session.observedThroughAt !== segment.lastSeenAt
      || segment.startedAt < (latest?.endedAt ?? session.createdAt)) throw new ObserveStoreError("invalid", "Observe store has an inconsistent active segment");
  }
  if (collectorLease !== null) {
    const session = byId.get(collectorLease.sessionId);
    if (!session || session.status !== "active" || collectorLease.fencingToken >= (value.nextFencingToken as number)) throw new ObserveStoreError("invalid", "Observe store has an inconsistent collector lease");
  }
  if (legacy) {
    const migratedObservations = [
      ...observations,
      ...activeSegments
        .filter((segment) => segment.lastSeenAt > segment.startedAt)
        .map(legacyObservationFromSegment)
    ].sort(compareObservation);
    if (migratedObservations.length > MAX_OBSERVATIONS
      || new Set(migratedObservations.map((entry) => entry.id)).size !== migratedObservations.length) {
      throw new ObserveStoreError("invalid", "Observe legacy active segment cannot be migrated without data loss");
    }
    return {
      activeSegments: [],
      collectorLease: null,
      nextFencingToken: value.nextFencingToken as number,
      observations: migratedObservations,
      schemaVersion: 2,
      sessions: sessions.map((session) => ({
        ...session,
        consentGrant: null,
        consentVersion: 1,
        status: "paused"
      }))
    };
  }
  return { activeSegments, collectorLease, nextFencingToken: value.nextFencingToken as number, observations, schemaVersion: 2, sessions };
}

function parseSession(value: unknown, legacy: boolean): ObserveSession {
  const expectedKeys = legacy
    ? ["consentVersion", "createdAt", "id", "observedThroughAt", "status", "threadId", "updatedAt"]
    : ["consentGrant", "consentVersion", "createdAt", "id", "observedThroughAt", "status", "threadId", "updatedAt"];
  if (!isRecord(value) || !exactKeys(value, expectedKeys)
    || (legacy ? value.consentVersion !== 1 : ![1, 2].includes(value.consentVersion as number))
    || !SESSION_ID.test(String(value.id)) || !isTime(value.createdAt) || !isTime(value.updatedAt)
    || (value.observedThroughAt !== null && !isTime(value.observedThroughAt)) || !["active", "paused"].includes(String(value.status))) throw new ObserveStoreError("invalid", "Observe store contains an invalid session");
  assertThreadId(value.threadId);
  if (value.updatedAt < value.createdAt || (value.observedThroughAt !== null && value.observedThroughAt < value.createdAt)) throw new ObserveStoreError("invalid", "Observe session time is inconsistent");
  if (legacy) return { ...(value as unknown as Omit<ObserveSession, "consentGrant">), consentGrant: null };
  const consentGrant = value.consentGrant === null ? null : parseConsentGrant(value.consentGrant);
  if ((value.consentVersion === 2) !== (consentGrant !== null) || (consentGrant === null && value.status === "active")) {
    throw new ObserveStoreError("invalid", "Observe session consent grant is inconsistent");
  }
  return { ...(value as unknown as ObserveSession), consentGrant };
}

function parseConsentGrant(value: unknown): ObserveConsentGrant {
  const fields = isRecord(value) && Array.isArray(value.fields) ? value.fields : undefined;
  if (!isRecord(value) || !exactKeys(value, ["cadenceMs", "fields", "pauseControl", "retentionDays", "source"])
    || value.source !== OBSERVE_CONSENT_SOURCE || value.pauseControl !== OBSERVE_PAUSE_CONTROL
    || fields === undefined || fields.length !== OBSERVE_CONSENT_FIELDS.length
    || !OBSERVE_CONSENT_FIELDS.every((field, index) => fields[index] === field)
    || !Number.isSafeInteger(value.cadenceMs) || (value.cadenceMs as number) < 10_000 || (value.cadenceMs as number) > 5 * 60_000
    || !Number.isSafeInteger(value.retentionDays) || (value.retentionDays as number) < 1 || (value.retentionDays as number) > 365) {
    throw new ObserveStoreError("invalid", "Observe consent grant must include exact source, fields, cadence, retention, and pause control");
  }
  return {
    cadenceMs: value.cadenceMs as number,
    fields: OBSERVE_CONSENT_FIELDS,
    pauseControl: OBSERVE_PAUSE_CONTROL,
    retentionDays: value.retentionDays as number,
    source: OBSERVE_CONSENT_SOURCE
  };
}

function parseObservation(value: unknown): ObserveObservation {
  if (!isRecord(value) || !exactKeys(value, ["appCategory", "dataOrigin", "durationMs", "endedAt", "id", "sessionId", "startedAt", "threadId"])
    || !OBSERVATION_ID.test(String(value.id)) || !SESSION_ID.test(String(value.sessionId)) || value.dataOrigin !== "active-app"
    || !isCategory(value.appCategory) || !isTime(value.startedAt) || !isTime(value.endedAt) || !Number.isSafeInteger(value.durationMs)) throw new ObserveStoreError("invalid", "Observe store contains an invalid observation");
  assertThreadId(value.threadId);
  const duration = timeMs(value.endedAt) - timeMs(value.startedAt);
  if (duration <= 0 || duration > MAX_OBSERVATION_MS || duration !== value.durationMs) throw new ObserveStoreError("invalid", "Observe observation duration is inconsistent");
  return value as unknown as ObserveObservation;
}

function parseSegment(value: unknown): ObserveActiveSegment {
  if (!isRecord(value) || !exactKeys(value, ["appCategory", "lastSeenAt", "sessionId", "startedAt", "threadId"])
    || !isCategory(value.appCategory) || !SESSION_ID.test(String(value.sessionId)) || !isTime(value.startedAt) || !isTime(value.lastSeenAt)
    || value.startedAt > value.lastSeenAt || timeMs(value.lastSeenAt) - timeMs(value.startedAt) >= MAX_OBSERVATION_MS) {
    throw new ObserveStoreError("invalid", "Observe store contains an invalid active segment");
  }
  assertThreadId(value.threadId);
  return value as unknown as ObserveActiveSegment;
}

function parseLease(value: unknown): ObserveCollectorLease {
  if (!isRecord(value) || !exactKeys(value, ["claimedAt", "collectorFingerprint", "expiresAt", "fencingToken", "sessionId"])
    || !isTime(value.claimedAt) || !isTime(value.expiresAt) || value.claimedAt >= value.expiresAt || !FINGERPRINT.test(String(value.collectorFingerprint))
    || !Number.isSafeInteger(value.fencingToken) || (value.fencingToken as number) < 1 || !SESSION_ID.test(String(value.sessionId))) throw new ObserveStoreError("invalid", "Observe store contains an invalid collector lease");
  return value as unknown as ObserveCollectorLease;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_TIME.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertTime(value: unknown): asserts value is string {
  if (!isTime(value)) throw new ObserveStoreError("invalid", "Observe time must be canonical UTC milliseconds");
}

function isCategory(value: unknown): value is ObserveAppCategory {
  return typeof value === "string" && OBSERVE_APP_CATEGORIES.includes(value as ObserveAppCategory);
}

function assertCategory(value: unknown): asserts value is ObserveAppCategory {
  if (!isCategory(value)) throw new ObserveStoreError("invalid", "Observe app category is invalid");
}

function assertThreadId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ObserveStoreError("invalid", "Observe thread id is invalid");
}

function optionTime(options: ObserveStoreOptions): string {
  const value = (options.now ?? (() => new Date()))().toISOString();
  assertTime(value);
  return value;
}

function lifecycleTime(session: ObserveSession, options: ObserveStoreOptions): string {
  return [optionTime(options), session.updatedAt, session.observedThroughAt ?? session.createdAt].reduce((latest, value) => value > latest ? value : latest);
}

function makeId(prefix: "observe" | "observe_observation", options: ObserveStoreOptions): string {
  const id = options.idFactory?.() ?? `${prefix}_${randomUUID()}`;
  const pattern = prefix === "observe" ? SESSION_ID : OBSERVATION_ID;
  if (!pattern.test(id)) throw new ObserveStoreError("invalid", `Observe ${prefix} id factory returned a non-canonical id`);
  return id;
}

function requireSession(state: ObserveState, id: string): ObserveSession {
  const session = state.sessions.find((entry) => entry.id === id);
  if (!session) throw new ObserveStoreError("not-found", `Observe session '${id}' does not exist`);
  return session;
}

function replaceSession(sessions: readonly ObserveSession[], updated: ObserveSession): readonly ObserveSession[] {
  return sessions.map((entry) => entry.id === updated.id ? updated : entry);
}

function newSegment(session: ObserveSession, appCategory: ObserveAppCategory, observedAt: string): ObserveActiveSegment {
  return { appCategory, lastSeenAt: observedAt, sessionId: session.id, startedAt: observedAt, threadId: session.threadId };
}

function observationFromSegment(segment: ObserveActiveSegment, endedAt: string, options: ObserveStoreOptions): ObserveObservation {
  return {
    appCategory: segment.appCategory,
    dataOrigin: "active-app",
    durationMs: timeMs(endedAt) - timeMs(segment.startedAt),
    endedAt,
    id: makeId("observe_observation", options),
    sessionId: segment.sessionId,
    startedAt: segment.startedAt,
    threadId: segment.threadId
  };
}

function legacyObservationFromSegment(segment: ObserveActiveSegment): ObserveObservation {
  const hex = createHash("sha256")
    .update(`observe-legacy-segment\0${segment.sessionId}\0${segment.startedAt}\0${segment.lastSeenAt}\0${segment.appCategory}`)
    .digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return {
    appCategory: segment.appCategory,
    dataOrigin: "active-app",
    durationMs: timeMs(segment.lastSeenAt) - timeMs(segment.startedAt),
    endedAt: segment.lastSeenAt,
    id: `observe_observation_${uuid}`,
    sessionId: segment.sessionId,
    startedAt: segment.startedAt,
    threadId: segment.threadId
  };
}

function appendObservation(observations: readonly ObserveObservation[], observation: ObserveObservation): readonly ObserveObservation[] {
  return [...observations, observation].sort(compareObservation).slice(-MAX_OBSERVATIONS);
}

function compareObservation(left: ObserveObservation, right: ObserveObservation): number {
  return left.endedAt.localeCompare(right.endedAt) || left.id.localeCompare(right.id);
}

function timeMs(value: string): number {
  return Date.parse(value);
}

async function observePathIdentity(file: string): Promise<string> {
  const stat = await fs.lstat(file).catch((cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(cause));
  if (stat === undefined) return "missing";
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ObserveStoreError("conflict", "Observe store target identity is invalid");
  return `${stat.dev}:${stat.ino}`;
}

function assertFingerprint(value: string): void {
  if (!FINGERPRINT.test(value)) throw new ObserveStoreError("invalid", "Observe collector identity is invalid");
}

function assertInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 5 * 60_000 || Math.max(30_000, value * 3) > 15 * 60_000) {
    throw new ObserveStoreError("invalid", "Observe collection interval must be between 10 seconds and 5 minutes");
  }
}

function authorityOf(lease: ObserveCollectorLease): ObserveLeaseAuthority {
  return { collectorFingerprint: lease.collectorFingerprint, fencingToken: lease.fencingToken };
}

function assertLeaseAuthority(state: ObserveState, sessionId: string, authority: ObserveLeaseAuthority, now?: string): void {
  assertFingerprint(authority.collectorFingerprint);
  if (!Number.isSafeInteger(authority.fencingToken) || authority.fencingToken < 1) throw new ObserveStoreError("invalid", "Observe collector fence is invalid");
  const lease = state.collectorLease;
  if (lease === null || lease.sessionId !== sessionId || lease.collectorFingerprint !== authority.collectorFingerprint
    || lease.fencingToken !== authority.fencingToken || (now !== undefined && lease.expiresAt <= now)) {
    throw new ObserveStoreError("conflict", "Observe collector authority is no longer current");
  }
}
