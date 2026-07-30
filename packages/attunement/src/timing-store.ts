/**
 * Thread-scoped timing state for Personal Continuity.
 *
 * This store deliberately persists only a user-selected thread, a bounded
 * category-level activity receipt, and deterministic delivery decisions. It
 * never accepts application names, window titles, clipboard contents, selected
 * text, screenshots, or model-generated interpretations.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { atomicWriteFile } from "@muse/stores";

import { AttunementStoreError } from "./attunement-store.js";
import {
  runActiveAttunementPolicyMutation,
  type ActiveAttunementPolicyWriteGate
} from "./active-policy-write-gate.js";
import { mutateFileState, type FileStateMutation } from "./file-state-mutation.js";
import type { ContinuityOutcome } from "./types.js";

export const TIMING_APP_CATEGORIES = ["communication", "planning", "research", "writing", "building", "other"] as const;
export type TimingAppCategory = (typeof TIMING_APP_CATEGORIES)[number];

export const TIMING_DECISIONS = ["silent", "digest", "offer"] as const;
export type TimingDecision = (typeof TIMING_DECISIONS)[number];

export const TIMING_COUNTERFACTUAL_ACTIONS = [
  "stay-silent",
  "queue-digest",
  "present-offer"
] as const;
export type TimingCounterfactualAction = (typeof TIMING_COUNTERFACTUAL_ACTIONS)[number];

export const TIMING_DECISION_REASONS = [
  "session-paused",
  "no-observation",
  "focus-block-too-short",
  "no-category-boundary",
  "offer-cooldown-active",
  "stable-focus-category-boundary"
] as const;
export type TimingDecisionReason = (typeof TIMING_DECISION_REASONS)[number];

export const TIMING_SESSION_STATUSES = ["active", "paused"] as const;
export type TimingSessionStatus = (typeof TIMING_SESSION_STATUSES)[number];

export interface TimingPolicy {
  /** Only feedback may change this field; it never changes collection or egress. */
  readonly offerCooldownMs: number;
  readonly stableFocusMs: number;
  readonly version: number;
}

export const DEFAULT_TIMING_POLICY: TimingPolicy = {
  offerCooldownMs: 90 * 60_000,
  stableFocusMs: 25 * 60_000,
  version: 0
};

export interface ThreadTimingSession {
  readonly consentVersion: number;
  readonly createdAt: string;
  readonly id: string;
  readonly policy: TimingPolicy;
  readonly status: TimingSessionStatus;
  readonly threadId: string;
  readonly updatedAt: string;
}

/** A category-only receipt. Raw desktop content is intentionally unrepresentable. */
export interface TimingObservation {
  readonly appCategory: TimingAppCategory;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly threadId: string;
}

interface TimingCandidateBase {
  readonly createdAt: string;
  readonly decision: TimingDecision;
  readonly evidenceObservationIds: readonly string[];
  readonly id: string;
  readonly reason: string;
  readonly sessionId: string;
  readonly threadId: string;
}

/** Schema-v1 compatibility shape. New decisions are never written this way. */
export interface LegacyTimingCandidate extends TimingCandidateBase {
  readonly ruleVersion: 1;
}

/**
 * Bounded live-behaviour counterfactual for a shadow-only decision. It records
 * what the timing reducer would have surfaced at this instant, not reasoning
 * traces, raw desktop content, authority, or permission.
 */
export interface TimingCounterfactual {
  readonly action: TimingCounterfactualAction;
  readonly evaluatedAt: string;
}

export interface ShadowTimingCandidate extends TimingCandidateBase {
  readonly counterfactual: TimingCounterfactual;
  readonly reason: TimingDecisionReason;
  readonly ruleVersion: 2;
}

export interface TimingPolicySnapshot {
  readonly offerCooldownMs: number;
  readonly stableFocusMs: number;
  readonly version: number;
}

/**
 * Schema-v3 timing decisions retain the exact, bounded policy values used by
 * the existing reducer. They add provenance only; delivery remains elsewhere.
 */
export interface MagShadowTimingCandidate extends TimingCandidateBase {
  readonly counterfactual: TimingCounterfactual;
  readonly policySnapshot: TimingPolicySnapshot;
  readonly reason: TimingDecisionReason;
  readonly ruleVersion: 3;
}

export type TimingCandidate =
  | LegacyTimingCandidate
  | ShadowTimingCandidate
  | MagShadowTimingCandidate;

export const MAG_SHADOW_TIMING_PROJECTION_VERSION =
  "muse.mag-shadow-timing-projection.v1" as const;

/** Safe, content-addressed timing input for Graph receipt capture. */
export type MagShadowTimingProjectionV1 = Readonly<{
  readonly candidate: Readonly<{
    readonly counterfactual: TimingCounterfactual;
    readonly createdAt: string;
    readonly decision: TimingDecision;
    readonly evidenceObservationIds: readonly string[];
    readonly id: string;
    readonly policySnapshot: TimingPolicySnapshot;
    readonly reason: TimingDecisionReason;
    readonly ruleVersion: 3;
    readonly sessionId: string;
    readonly threadId: string;
  }>;
  readonly observationDigest: string;
  readonly observations: readonly Readonly<{
    readonly id: string;
    readonly sessionId: string;
    readonly threadId: string;
  }>[];
  readonly projectionVersion: typeof MAG_SHADOW_TIMING_PROJECTION_VERSION;
  readonly schemaVersion: 1;
  readonly sessionConsentVersion: number;
}>;

type PersistedTimingStateStamp = Readonly<{
  readonly digest: string;
}>;

type MagShadowTimingProjectionStamp = Readonly<{
  readonly candidateId: string;
  readonly state: TimingState;
  readonly stateDigest: string;
}>;

export interface TimingFeedback {
  readonly candidateId: string;
  readonly outcome: ContinuityOutcome;
  readonly recordedAt: string;
  readonly resultingCooldownMs: number;
  readonly resultingPolicyVersion: number;
  readonly sessionId: string;
  readonly threadId: string;
  readonly rollbackProposal?: TimingRollbackProposal;
  /** Added only while reading a schema-v1 rejected receipt that predates
   * rollback proposals. Fresh schema-v2 feedback never writes this marker. */
  readonly legacyUnproposedRejection?: true;
}

export interface TimingRollbackProposal {
  readonly baseCooldownMs: number;
  readonly basePolicyVersion: number;
  readonly boundary: {
    readonly actionScope: "not-expanded";
    readonly permission: "unchanged";
    readonly recipient: "unchanged";
    readonly source: "unchanged";
  };
  readonly candidateId: string;
  readonly createdAt: string;
  readonly proposedCooldownMs: number;
  readonly reason: "negative-outcome-rejected";
  readonly scope: "thread-display-timing";
  readonly sessionId: string;
  readonly threadId: string;
}

export interface TimingState {
  readonly candidates: readonly TimingCandidate[];
  readonly feedback: readonly TimingFeedback[];
  readonly observations: readonly TimingObservation[];
  readonly schemaVersion: 2;
  readonly sessions: readonly ThreadTimingSession[];
}

export interface TimingStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface StartTimingSessionInput {
  readonly consentVersion: number;
  readonly threadId: string;
}

export interface RecordTimingObservationInput {
  readonly appCategory: TimingAppCategory;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly startedAt: string;
}

const MAX_CANDIDATES = 200;
const MAX_OBSERVATIONS = 500;
const MAX_FEEDBACK = 200;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const MIN_COOLDOWN_MS = 30 * 60_000;

const PERSISTED_TIMING_STATES = new WeakMap<object, PersistedTimingStateStamp>();
const MAG_SHADOW_TIMING_PROJECTIONS =
  new WeakMap<object, MagShadowTimingProjectionStamp>();

const EMPTY_STATE: TimingState = freezeTimingState({
  candidates: [],
  feedback: [],
  observations: [],
  schemaVersion: 2,
  sessions: []
});

export function emptyTimingState(): TimingState {
  return EMPTY_STATE;
}

export async function readTimingState(file: string): Promise<TimingState> {
  try {
    return markPersistedTimingState(
      parseTimingState(JSON.parse(await readFile(file, "utf8")))
    );
  } catch (cause) {
    if (isMissingFile(cause)) return markPersistedTimingState(EMPTY_STATE);
    if (cause instanceof AttunementStoreError) throw cause;
    throw new AttunementStoreError(`cannot read timing state: ${describe(cause)}`);
  }
}

export async function startTimingSession(
  file: string,
  input: StartTimingSessionInput,
  assertKnownThread: (threadId: string) => Promise<void>,
  options: TimingStoreOptions = {}
): Promise<ThreadTimingSession> {
  validateThreadId(input.threadId);
  validateConsentVersion(input.consentVersion);
  await assertKnownThread(input.threadId);
  return mutateTimingState(file, options, (state) => {
    if (state.sessions.some((session) => session.status === "active")) {
      throw new AttunementStoreError("another thread timing session is already active; pause or forget it first");
    }
    const now = nowIso(options);
    const session: ThreadTimingSession = {
      consentVersion: input.consentVersion,
      createdAt: now,
      id: newId("timing", options),
      policy: DEFAULT_TIMING_POLICY,
      status: "active",
      threadId: input.threadId,
      updatedAt: now
    };
    return { changed: true, result: session, state: { ...state, sessions: [...state.sessions, session] } };
  });
}

export async function pauseTimingSession(file: string, sessionId: string, options: TimingStoreOptions = {}): Promise<ThreadTimingSession> {
  return updateSession(file, sessionId, options, (session, now) => ({ ...session, status: "paused", updatedAt: now }));
}

export async function resumeTimingSession(file: string, sessionId: string, options: TimingStoreOptions = {}): Promise<ThreadTimingSession> {
  return mutateTimingState(file, options, (state) => {
    const session = requireSession(state, sessionId);
    if (session.status === "active") return { changed: false, result: session, state };
    if (state.sessions.some((candidate) => candidate.id !== session.id && candidate.status === "active")) {
      throw new AttunementStoreError("another thread timing session is already active; pause it first");
    }
    const updated = { ...session, status: "active" as const, updatedAt: nowIso(options) };
    return { changed: true, result: updated, state: replaceSession(state, updated) };
  });
}

/** Forget is destructive by design: session, observation, candidate, and feedback receipts are all removed. */
export async function forgetTimingSession(file: string, sessionId: string): Promise<{ readonly deletedCandidates: number; readonly deletedFeedback: number; readonly deletedObservations: number }> {
  return mutateTimingState(file, {}, (state) => {
    const session = requireSession(state, sessionId);
    const observations = state.observations.filter((observation) => observation.sessionId !== session.id);
    const candidates = state.candidates.filter((candidate) => candidate.sessionId !== session.id);
    const feedback = state.feedback.filter((entry) => entry.sessionId !== session.id);
    return {
      changed: true,
      result: {
        deletedCandidates: state.candidates.length - candidates.length,
        deletedFeedback: state.feedback.length - feedback.length,
        deletedObservations: state.observations.length - observations.length
      },
      state: { ...state, candidates, feedback, observations, sessions: state.sessions.filter((candidate) => candidate.id !== session.id) }
    };
  });
}

export async function recordTimingObservation(
  file: string,
  sessionId: string,
  input: RecordTimingObservationInput,
  options: TimingStoreOptions = {}
): Promise<TimingObservation> {
  validateObservationInput(input);
  return mutateTimingState(file, options, (state) => {
    const session = requireSession(state, sessionId);
    if (session.status !== "active") throw new AttunementStoreError("timing session is paused; no observation may be recorded");
    const observation: TimingObservation = {
      ...input,
      id: newId("observation", options),
      sessionId: session.id,
      threadId: session.threadId
    };
    const observations = trim([...state.observations, observation], MAX_OBSERVATIONS);
    return { changed: true, result: observation, state: { ...state, observations } };
  });
}

/**
 * Deterministic and explainable timing reducer. It never sends a message: an
 * `offer` only permits a caller to present an existing Continuity Pack.
 */
export async function evaluateTimingSession(
  file: string,
  sessionId: string,
  options: TimingStoreOptions = {}
): Promise<TimingCandidate> {
  return mutateTimingState(file, options, (state) => {
    const session = requireSession(state, sessionId);
    const observations = state.observations.filter((entry) => entry.sessionId === session.id);
    const latest = observations.at(-1);
    const prior = observations.at(-2);
    const evidenceObservationIds = latest ? prior ? [prior.id, latest.id] : [latest.id] : [];
    const existing = state.candidates.find((candidate) => sameIds(candidate.evidenceObservationIds, evidenceObservationIds));
    if (existing) return { changed: false, result: existing, state };
    const candidate = decideTiming(session, observations, state.candidates, nowIso(options), newId("candidate", options));
    return {
      changed: true,
      result: candidate,
      state: { ...state, candidates: trim([...state.candidates, candidate], MAX_CANDIDATES) }
    };
  });
}

export async function recordTimingFeedback(
  file: string,
  candidateId: string,
  outcome: ContinuityOutcome,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate,
  options: TimingStoreOptions = {}
): Promise<{ readonly applied: boolean; readonly feedback: TimingFeedback; readonly session: ThreadTimingSession }> {
  if (!["used", "adjusted", "ignored", "rejected"].includes(outcome)) {
    throw new AttunementStoreError("timing feedback must be used, adjusted, ignored, or rejected");
  }
  if (outcome === "rejected") {
    return recordRejectedTimingFeedbackProposal(file, candidateId, options);
  }
  return runActiveAttunementPolicyMutation(activePolicyWriteGate, () =>
    mutateTimingState<{ readonly applied: boolean; readonly feedback: TimingFeedback; readonly session: ThreadTimingSession }>(file, options, (state) => {
      const candidate = state.candidates.find((entry) => entry.id === candidateId);
      if (!candidate) throw new AttunementStoreError(`no timing candidate with id '${candidateId}'`);
      const session = requireSession(state, candidate.sessionId);
      const existing = state.feedback.find((entry) => entry.candidateId === candidate.id);
      if (existing) {
        if (existing.outcome !== outcome) throw new AttunementStoreError(`timing candidate '${candidateId}' already has immutable feedback '${existing.outcome}'`);
        return { changed: false, result: { applied: false, feedback: existing, session }, state };
      }
      const nextPolicy = policyForTimingOutcome(session.policy, outcome);
      const updatedSession: ThreadTimingSession = { ...session, policy: nextPolicy, updatedAt: nowIso(options) };
      const feedback: TimingFeedback = {
        candidateId: candidate.id,
        outcome,
        recordedAt: updatedSession.updatedAt,
        resultingCooldownMs: nextPolicy.offerCooldownMs,
        resultingPolicyVersion: nextPolicy.version,
        sessionId: session.id,
        threadId: session.threadId
      };
      return {
        changed: true,
        result: { applied: true, feedback, session: updatedSession },
        state: {
          ...replaceSession(state, updatedSession),
          feedback: trim([...state.feedback, feedback], MAX_FEEDBACK)
        }
      };
    })
  );
}

function recordRejectedTimingFeedbackProposal(
  file: string,
  candidateId: string,
  options: TimingStoreOptions
): Promise<{ readonly applied: false; readonly feedback: TimingFeedback; readonly session: ThreadTimingSession }> {
  return mutateTimingState(file, options, (state) => {
    const candidate = state.candidates.find((entry) => entry.id === candidateId);
    if (!candidate) throw new AttunementStoreError(`no timing candidate with id '${candidateId}'`);
    const session = requireSession(state, candidate.sessionId);
    const existing = state.feedback.find((entry) => entry.candidateId === candidate.id);
    if (existing) {
      if (existing.outcome !== "rejected") {
        throw new AttunementStoreError(`timing candidate '${candidateId}' already has immutable feedback '${existing.outcome}'`);
      }
      return { changed: false, result: { applied: false, feedback: existing, session }, state };
    }
    const recordedAt = nowIso(options);
    const feedback: TimingFeedback = {
      candidateId: candidate.id,
      outcome: "rejected",
      recordedAt,
      resultingCooldownMs: session.policy.offerCooldownMs,
      resultingPolicyVersion: session.policy.version,
      rollbackProposal: {
        baseCooldownMs: session.policy.offerCooldownMs,
        basePolicyVersion: session.policy.version,
        boundary: {
          actionScope: "not-expanded",
          permission: "unchanged",
          recipient: "unchanged",
          source: "unchanged"
        },
        candidateId: candidate.id,
        createdAt: recordedAt,
        proposedCooldownMs: MAX_COOLDOWN_MS,
        reason: "negative-outcome-rejected",
        scope: "thread-display-timing",
        sessionId: session.id,
        threadId: session.threadId
      },
      sessionId: session.id,
      threadId: session.threadId
    };
    return {
      changed: true,
      result: { applied: false, feedback, session },
      state: { ...state, feedback: trim([...state.feedback, feedback], MAX_FEEDBACK) }
    };
  });
}

export function inspectTimingSession(state: TimingState, sessionId: string): {
  readonly candidates: readonly TimingCandidate[];
  readonly feedback: readonly TimingFeedback[];
  readonly observations: readonly TimingObservation[];
  readonly session: ThreadTimingSession;
} {
  const session = requireSession(state, sessionId);
  return {
    candidates: state.candidates.filter((entry) => entry.sessionId === session.id),
    feedback: state.feedback.filter((entry) => entry.sessionId === session.id),
    observations: state.observations.filter((entry) => entry.sessionId === session.id),
    session
  };
}

/**
 * Projects an already-persisted v3 timing candidate into the minimal Graph
 * capture input. The source state remains authoritative; callers receive no
 * raw desktop content and older candidates deliberately cannot opt in.
 */
export function projectMagShadowTimingDecision(
  state: TimingState,
  candidateId: string
): MagShadowTimingProjectionV1 | undefined {
  if (typeof state !== "object" || state === null || typeof candidateId !== "string") {
    return undefined;
  }
  const stamp = PERSISTED_TIMING_STATES.get(state);
  if (stamp === undefined || timingStateDigest(state) !== stamp.digest) return undefined;
  const projection = projectMagShadowTimingDecisionFromState(state, candidateId);
  if (projection === undefined) return undefined;
  MAG_SHADOW_TIMING_PROJECTIONS.set(projection, Object.freeze({
    candidateId,
    state,
    stateDigest: stamp.digest
  }));
  return projection;
}

/**
 * Accepts only the exact projection minted from an unchanged validated read.
 * This is intentionally identity-bound: structural lookalikes cannot become
 * provenance for a graph receipt.
 */
export function verifyMagShadowTimingProjection(
  value: unknown
): MagShadowTimingProjectionV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const stamp = MAG_SHADOW_TIMING_PROJECTIONS.get(value);
  if (
    stamp === undefined
    || PERSISTED_TIMING_STATES.get(stamp.state)?.digest !== stamp.stateDigest
    || timingStateDigest(stamp.state) !== stamp.stateDigest
  ) {
    return undefined;
  }
  const recomputed = projectMagShadowTimingDecisionFromState(
    stamp.state,
    stamp.candidateId
  );
  if (
    recomputed === undefined
    || JSON.stringify(recomputed) !== JSON.stringify(value)
  ) {
    return undefined;
  }
  return value as MagShadowTimingProjectionV1;
}

function projectMagShadowTimingDecisionFromState(
  state: TimingState,
  candidateId: string
): MagShadowTimingProjectionV1 | undefined {
  const candidate = state.candidates.find((entry) => entry.id === candidateId);
  if (candidate === undefined) return undefined;
  const session = state.sessions.find((entry) => entry.id === candidate.sessionId);
  if (
    candidate.ruleVersion !== 3
    || session === undefined
    || session.threadId !== candidate.threadId
    || !isCanonicalInstant(candidate.createdAt)
    || candidate.counterfactual.evaluatedAt !== candidate.createdAt
    || !isTimingPolicySnapshot(candidate.policySnapshot)
    || candidate.evidenceObservationIds.length > 2
    || candidate.policySnapshot.offerCooldownMs !== session.policy.offerCooldownMs
    || candidate.policySnapshot.stableFocusMs !== session.policy.stableFocusMs
    || candidate.policySnapshot.version !== session.policy.version
  ) {
    return undefined;
  }
  const observationById = new Map(state.observations.map((observation) => [
    observation.id,
    observation
  ]));
  const exactObservations: TimingObservation[] = [];
  for (const id of candidate.evidenceObservationIds) {
    const observation = observationById.get(id);
    if (
      observation === undefined
      || !isCanonicalTimingObservation(observation)
      || observation.sessionId !== candidate.sessionId
      || observation.threadId !== candidate.threadId
    ) {
      return undefined;
    }
    if (exactObservations.some((entry) => entry.id === id)) return undefined;
    exactObservations.push(observation);
  }
  const projectedObservations = exactObservations.map((observation) =>
    Object.freeze({
      id: observation.id,
      sessionId: observation.sessionId,
      threadId: observation.threadId
    })
  );
  const policySnapshot = Object.freeze({
    offerCooldownMs: candidate.policySnapshot.offerCooldownMs,
    stableFocusMs: candidate.policySnapshot.stableFocusMs,
    version: candidate.policySnapshot.version
  });
  const projectedCandidate = Object.freeze({
    counterfactual: Object.freeze({ ...candidate.counterfactual }),
    createdAt: candidate.createdAt,
    decision: candidate.decision,
    evidenceObservationIds: Object.freeze([...candidate.evidenceObservationIds]),
    id: candidate.id,
    policySnapshot,
    reason: candidate.reason,
    ruleVersion: 3 as const,
    sessionId: candidate.sessionId,
    threadId: candidate.threadId
  });
  return Object.freeze({
    candidate: projectedCandidate,
    observationDigest: timingObservationDigest(exactObservations),
    observations: Object.freeze(projectedObservations),
    projectionVersion: MAG_SHADOW_TIMING_PROJECTION_VERSION,
    schemaVersion: 1 as const,
    sessionConsentVersion: session.consentVersion
  });
}

function decideTiming(
  session: ThreadTimingSession,
  observations: readonly TimingObservation[],
  candidates: readonly TimingCandidate[],
  createdAt: string,
  id: string
): TimingCandidate {
  const latest = observations.at(-1);
  const prior = observations.at(-2);
  const evidenceObservationIds = latest ? prior ? [prior.id, latest.id] : [latest.id] : [];
  const decision = (decision: TimingDecision, reason: TimingDecisionReason): MagShadowTimingCandidate => ({
    counterfactual: {
      action: counterfactualActionForDecision(decision),
      evaluatedAt: createdAt
    },
    createdAt,
    decision,
    evidenceObservationIds,
    id,
    policySnapshot: Object.freeze({
      offerCooldownMs: session.policy.offerCooldownMs,
      stableFocusMs: session.policy.stableFocusMs,
      version: session.policy.version
    }),
    reason,
    ruleVersion: 3,
    sessionId: session.id,
    threadId: session.threadId
  });
  if (session.status !== "active") return decision("silent", "session-paused");
  if (!latest) return decision("silent", "no-observation");
  if (latest.durationMs < session.policy.stableFocusMs) return decision("silent", "focus-block-too-short");
  if (!prior || prior.appCategory === latest.appCategory) return decision("silent", "no-category-boundary");
  const previousOffer = candidates
    .filter((candidate) => candidate.sessionId === session.id && candidate.decision === "offer")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (previousOffer && Date.parse(createdAt) - Date.parse(previousOffer.createdAt) < session.policy.offerCooldownMs) {
    return decision("digest", "offer-cooldown-active");
  }
  return decision("offer", "stable-focus-category-boundary");
}

function policyForTimingOutcome(
  policy: TimingPolicy,
  outcome: Exclude<ContinuityOutcome, "rejected">
): TimingPolicy {
  const cooldown = outcome === "used"
    ? policy.offerCooldownMs
    : outcome === "adjusted"
      ? Math.min(MAX_COOLDOWN_MS, policy.offerCooldownMs + 30 * 60_000)
      : Math.min(MAX_COOLDOWN_MS, policy.offerCooldownMs * 2);
  return { ...policy, offerCooldownMs: Math.max(MIN_COOLDOWN_MS, cooldown), version: policy.version + 1 };
}

async function updateSession(
  file: string,
  sessionId: string,
  options: TimingStoreOptions,
  update: (session: ThreadTimingSession, now: string) => ThreadTimingSession
): Promise<ThreadTimingSession> {
  return mutateTimingState(file, options, (state) => {
    const session = requireSession(state, sessionId);
    const updated = update(session, nowIso(options));
    if (updated.status === session.status) return { changed: false, result: session, state };
    return { changed: true, result: updated, state: replaceSession(state, updated) };
  });
}

async function mutateTimingState<T>(
  file: string,
  options: TimingStoreOptions,
  fn: (state: TimingState) => FileStateMutation<TimingState, T>
): Promise<T> {
  void options;
  return mutateFileState(file, readTimingState, writeTimingState, fn);
}

async function writeTimingState(file: string, state: TimingState): Promise<void> {
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

function parseTimingState(value: unknown): TimingState {
  if (isTimingStateShape(value, 2, isFeedback)) {
    const state = value as unknown as TimingState;
    validateTimingStateRelationships(state);
    return state;
  }
  if (isTimingStateShape(value, 1, isLegacyFeedback)) {
    const legacy = value as {
      readonly candidates: readonly TimingCandidate[];
      readonly feedback: readonly TimingFeedback[];
      readonly observations: readonly TimingObservation[];
      readonly sessions: readonly ThreadTimingSession[];
    };
    const migrated: TimingState = {
      candidates: legacy.candidates,
      feedback: legacy.feedback.map((entry) =>
        entry.outcome === "rejected" && entry.rollbackProposal === undefined
          ? { ...entry, legacyUnproposedRejection: true as const }
          : entry
      ),
      observations: legacy.observations,
      schemaVersion: 2,
      sessions: legacy.sessions
    };
    validateTimingStateRelationships(migrated);
    return migrated;
  }
  throw new AttunementStoreError("timing state is malformed or uses an unsupported schema");
}

function isTimingStateShape(
  value: unknown,
  schemaVersion: 1 | 2,
  feedbackValidator: (entry: unknown) => boolean
): value is Record<string, unknown> {
  return isExactRecord(value, ["candidates", "feedback", "observations", "schemaVersion", "sessions"])
    && value.schemaVersion === schemaVersion
    && Array.isArray(value.sessions)
    && Array.isArray(value.observations)
    && Array.isArray(value.candidates)
    && Array.isArray(value.feedback)
    && value.sessions.every(isSession)
    && value.observations.every(isObservation)
    && value.candidates.every(isCandidate)
    && value.feedback.every(feedbackValidator);
}

/** File JSON is untrusted: preserve the graph invariants that TypeScript types cannot enforce at runtime. */
function validateTimingStateRelationships(state: TimingState): void {
  const sessions = indexTimingEntries(state.sessions, "session");
  const observations = indexTimingEntries(state.observations, "observation");
  const candidates = indexTimingEntries(state.candidates, "candidate");
  const feedbackCandidateIds = new Set<string>();

  for (const observation of state.observations) {
    const session = sessions.get(observation.sessionId);
    if (!session || session.threadId !== observation.threadId) throwInconsistentTimingRelationships();
  }

  for (const candidate of state.candidates) {
    const session = sessions.get(candidate.sessionId);
    if (!session || session.threadId !== candidate.threadId) throwInconsistentTimingRelationships();
    const evidenceIds = new Set<string>();
    for (const evidenceId of candidate.evidenceObservationIds) {
      const observation = observations.get(evidenceId);
      if (!evidenceIds.add(evidenceId) || !observation || observation.sessionId !== candidate.sessionId || observation.threadId !== candidate.threadId) {
        throwInconsistentTimingRelationships();
      }
    }
  }

  for (const entry of state.feedback) {
    const session = sessions.get(entry.sessionId);
    const candidate = candidates.get(entry.candidateId);
    if (!feedbackCandidateIds.add(entry.candidateId) || !session || !candidate || session.threadId !== entry.threadId || candidate.sessionId !== entry.sessionId || candidate.threadId !== entry.threadId) {
      throwInconsistentTimingRelationships();
    }
    const proposal = entry.rollbackProposal;
    if (
      proposal
      && (
        proposal.basePolicyVersion > session.policy.version
        || (
          proposal.basePolicyVersion === session.policy.version
          && proposal.baseCooldownMs !== session.policy.offerCooldownMs
        )
      )
    ) {
      throwInconsistentTimingRelationships();
    }
    if (
      entry.legacyUnproposedRejection
      && (
        entry.resultingPolicyVersion < 1
        || entry.resultingCooldownMs !== MAX_COOLDOWN_MS
        || entry.resultingPolicyVersion > session.policy.version
        || (
          entry.resultingPolicyVersion === session.policy.version
          && entry.resultingCooldownMs !== session.policy.offerCooldownMs
        )
      )
    ) {
      throwInconsistentTimingRelationships();
    }
  }
}

function indexTimingEntries<Entry extends { readonly id: string }>(entries: readonly Entry[], kind: string): ReadonlyMap<string, Entry> {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new AttunementStoreError(`timing state contains duplicate ${kind} ids`);
    byId.set(entry.id, entry);
  }
  return byId;
}

function throwInconsistentTimingRelationships(): never {
  throw new AttunementStoreError("timing state has inconsistent relationships");
}

function isSession(value: unknown): value is ThreadTimingSession {
  return isExactRecord(value, ["consentVersion", "createdAt", "id", "policy", "status", "threadId", "updatedAt"]) && isNonEmptyString(value.id) && isNonEmptyString(value.threadId) && isNonEmptyString(value.createdAt) && isNonEmptyString(value.updatedAt)
    && isIso(value.createdAt) && isIso(value.updatedAt) && isPositiveSafeInteger(value.consentVersion) && TIMING_SESSION_STATUSES.includes(value.status as TimingSessionStatus) && isPolicy(value.policy);
}

function isPolicy(value: unknown): value is TimingPolicy {
  return isExactRecord(value, ["offerCooldownMs", "stableFocusMs", "version"]) && isPositiveSafeInteger(value.offerCooldownMs) && isPositiveSafeInteger(value.stableFocusMs) && isNonNegativeSafeInteger(value.version);
}

function isObservation(value: unknown): value is TimingObservation {
  return isExactRecord(value, ["appCategory", "durationMs", "endedAt", "id", "sessionId", "startedAt", "threadId"]) && isNonEmptyString(value.id) && isNonEmptyString(value.sessionId) && isNonEmptyString(value.threadId)
    && isNonEmptyString(value.startedAt) && isNonEmptyString(value.endedAt) && isIso(value.startedAt) && isIso(value.endedAt) && Date.parse(value.endedAt) >= Date.parse(value.startedAt) && isPositiveSafeInteger(value.durationMs)
    && TIMING_APP_CATEGORIES.includes(value.appCategory as TimingAppCategory);
}

function isCandidate(value: unknown): value is TimingCandidate {
  const baseKeys = ["createdAt", "decision", "evidenceObservationIds", "id", "reason", "ruleVersion", "sessionId", "threadId"];
  const exact = isExactRecord(value, baseKeys)
    || isExactRecord(value, [...baseKeys, "counterfactual"])
    || isExactRecord(value, [...baseKeys, "counterfactual", "policySnapshot"]);
  if (!exact || !isNonEmptyString(value.id) || !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.threadId)
    || !isNonEmptyString(value.createdAt) || !isIso(value.createdAt) || !isNonEmptyString(value.reason)
    || !TIMING_DECISIONS.includes(value.decision as TimingDecision)
    || !Array.isArray(value.evidenceObservationIds) || !value.evidenceObservationIds.every(isNonEmptyString)) {
    return false;
  }
  if (value.ruleVersion === 1) return !("counterfactual" in value);
  if (value.ruleVersion === 2) return (
    TIMING_DECISION_REASONS.includes(value.reason as TimingDecisionReason)
    && "counterfactual" in value
    && isTimingCounterfactual(value.counterfactual)
    && value.counterfactual.action === counterfactualActionForDecision(value.decision as TimingDecision)
    && value.counterfactual.evaluatedAt === value.createdAt
  );
  return value.ruleVersion === 3
    && TIMING_DECISION_REASONS.includes(value.reason as TimingDecisionReason)
    && "counterfactual" in value
    && isTimingCounterfactual(value.counterfactual)
    && value.counterfactual.action === counterfactualActionForDecision(value.decision as TimingDecision)
    && value.counterfactual.evaluatedAt === value.createdAt
    && "policySnapshot" in value
    && isTimingPolicySnapshot(value.policySnapshot);
}

function isTimingPolicySnapshot(value: unknown): value is TimingPolicySnapshot {
  return isExactRecord(value, ["offerCooldownMs", "stableFocusMs", "version"])
    && isPositiveSafeInteger(value.offerCooldownMs)
    && isPositiveSafeInteger(value.stableFocusMs)
    && isNonNegativeSafeInteger(value.version);
}

function isCanonicalTimingObservation(observation: TimingObservation): boolean {
  return isCanonicalInstant(observation.startedAt)
    && isCanonicalInstant(observation.endedAt)
    && Date.parse(observation.endedAt) >= Date.parse(observation.startedAt);
}

function isCanonicalInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function timingObservationDigest(observations: readonly TimingObservation[]): string {
  return createHash("sha256").update(JSON.stringify(observations.map((observation) => ({
    appCategory: observation.appCategory,
    durationMs: observation.durationMs,
    endedAt: observation.endedAt,
    id: observation.id,
    sessionId: observation.sessionId,
    startedAt: observation.startedAt,
    threadId: observation.threadId
  }))), "utf8").digest("hex");
}

function timingStateDigest(state: TimingState): string {
  return createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex");
}

function markPersistedTimingState(state: TimingState): TimingState {
  const frozen = freezeTimingState(state);
  PERSISTED_TIMING_STATES.set(frozen, Object.freeze({
    digest: timingStateDigest(frozen)
  }));
  return frozen;
}

function freezeTimingState<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freezeTimingState(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function isTimingCounterfactual(value: unknown): value is TimingCounterfactual {
  return isExactRecord(value, ["action", "evaluatedAt"])
    && TIMING_COUNTERFACTUAL_ACTIONS.includes(value.action as TimingCounterfactualAction)
    && isNonEmptyString(value.evaluatedAt)
    && isIso(value.evaluatedAt);
}

function counterfactualActionForDecision(decision: TimingDecision): TimingCounterfactualAction {
  return decision === "offer"
    ? "present-offer"
    : decision === "digest"
      ? "queue-digest"
      : "stay-silent";
}

function isFeedback(value: unknown): value is TimingFeedback {
  const baseKeys = ["candidateId", "outcome", "recordedAt", "resultingCooldownMs", "resultingPolicyVersion", "sessionId", "threadId"];
  const hasProposal = isExactRecord(value, [...baseKeys, "rollbackProposal"]);
  const hasLegacyMarker = isExactRecord(value, [...baseKeys, "legacyUnproposedRejection"]);
  const exact = isExactRecord(value, baseKeys) || hasProposal || hasLegacyMarker;
  if (!exact) return false;
  const entry = value as Record<string, unknown>;
  if (!isNonEmptyString(entry.candidateId) || !isNonEmptyString(entry.sessionId) || !isNonEmptyString(entry.threadId) || !isNonEmptyString(entry.recordedAt)
    || !isIso(entry.recordedAt) || !["used", "adjusted", "ignored", "rejected"].includes(entry.outcome as string) || !isPositiveSafeInteger(entry.resultingCooldownMs)
    || !isNonNegativeSafeInteger(entry.resultingPolicyVersion)) {
    return false;
  }
  if (entry.outcome !== "rejected") return !hasProposal && !hasLegacyMarker;
  if (hasLegacyMarker) {
    return entry.legacyUnproposedRejection === true && !("rollbackProposal" in entry);
  }
  const proposal = entry.rollbackProposal;
  return hasProposal
    && isTimingRollbackProposal(proposal)
    && proposal.candidateId === entry.candidateId
    && proposal.sessionId === entry.sessionId
    && proposal.threadId === entry.threadId
    && proposal.createdAt === entry.recordedAt
    && proposal.baseCooldownMs === entry.resultingCooldownMs
    && proposal.basePolicyVersion === entry.resultingPolicyVersion;
}

function isLegacyFeedback(value: unknown): value is TimingFeedback {
  const baseKeys = ["candidateId", "outcome", "recordedAt", "resultingCooldownMs", "resultingPolicyVersion", "sessionId", "threadId"];
  if (isExactRecord(value, baseKeys)) {
    return isFeedbackBase(value)
      && (
        value.outcome !== "rejected"
        || (
          value.resultingCooldownMs === MAX_COOLDOWN_MS
          && typeof value.resultingPolicyVersion === "number"
          && value.resultingPolicyVersion >= 1
        )
      );
  }
  if (!isExactRecord(value, [...baseKeys, "rollbackProposal"]) || !isFeedbackBase(value)) {
    return false;
  }
  return value.outcome === "rejected"
    && isTimingRollbackProposal(value.rollbackProposal)
    && value.rollbackProposal.candidateId === value.candidateId
    && value.rollbackProposal.sessionId === value.sessionId
    && value.rollbackProposal.threadId === value.threadId
    && value.rollbackProposal.createdAt === value.recordedAt
    && value.rollbackProposal.baseCooldownMs === value.resultingCooldownMs
    && value.rollbackProposal.basePolicyVersion === value.resultingPolicyVersion;
}

function isFeedbackBase(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.candidateId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.threadId)
    && isNonEmptyString(value.recordedAt)
    && isIso(value.recordedAt)
    && ["used", "adjusted", "ignored", "rejected"].includes(value.outcome as string)
    && isPositiveSafeInteger(value.resultingCooldownMs)
    && isNonNegativeSafeInteger(value.resultingPolicyVersion);
}

function isTimingRollbackProposal(value: unknown): value is TimingRollbackProposal {
  return isExactRecord(value, [
    "baseCooldownMs",
    "basePolicyVersion",
    "boundary",
    "candidateId",
    "createdAt",
    "proposedCooldownMs",
    "reason",
    "scope",
    "sessionId",
    "threadId"
  ])
    && isPositiveSafeInteger(value.baseCooldownMs)
    && isNonNegativeSafeInteger(value.basePolicyVersion)
    && isExactRecord(value.boundary, ["actionScope", "permission", "recipient", "source"])
    && value.boundary.actionScope === "not-expanded"
    && value.boundary.permission === "unchanged"
    && value.boundary.recipient === "unchanged"
    && value.boundary.source === "unchanged"
    && isNonEmptyString(value.candidateId)
    && isNonEmptyString(value.createdAt)
    && isIso(value.createdAt)
    && value.proposedCooldownMs === MAX_COOLDOWN_MS
    && value.reason === "negative-outcome-rejected"
    && value.scope === "thread-display-timing"
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.threadId);
}

function validateObservationInput(input: RecordTimingObservationInput): void {
  if (!TIMING_APP_CATEGORIES.includes(input.appCategory)) throw new AttunementStoreError("observation app category is invalid");
  if (!isPositiveSafeInteger(input.durationMs)) throw new AttunementStoreError("observation duration must be a positive safe integer");
  if (!isIso(input.startedAt) || !isIso(input.endedAt) || Date.parse(input.endedAt) < Date.parse(input.startedAt)) {
    throw new AttunementStoreError("observation timestamps must be ordered ISO timestamps");
  }
}

function validateThreadId(threadId: string): void {
  if (!isNonEmptyString(threadId)) throw new AttunementStoreError("timing thread id must be a non-empty string");
}

function validateConsentVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new AttunementStoreError("timing consent version must be a positive safe integer");
}

function requireSession(state: TimingState, sessionId: string): ThreadTimingSession {
  if (!isNonEmptyString(sessionId)) throw new AttunementStoreError("timing session id must be a non-empty string");
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new AttunementStoreError(`no timing session with id '${sessionId}'`);
  return session;
}

function replaceSession(state: TimingState, session: ThreadTimingSession): TimingState {
  return { ...state, sessions: state.sessions.map((entry) => entry.id === session.id ? session : entry) };
}

function trim<T>(values: readonly T[], max: number): readonly T[] {
  return values.length > max ? values.slice(values.length - max) : values;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nowIso(options: TimingStoreOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function newId(prefix: string, options: TimingStoreOptions): string {
  const value = (options.idFactory ?? randomUUID)().trim();
  if (!isNonEmptyString(value)) throw new AttunementStoreError("timing id factory returned an empty id");
  return `${prefix}_${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject unknown fields so raw desktop content can never survive a store read. */
function isExactRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key)) && allowedKeys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIso(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function isMissingFile(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
