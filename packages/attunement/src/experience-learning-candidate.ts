import { sha256Hex } from "@muse/shared";

import {
  DETAIL_LEVELS,
  NEXT_STEP_PRESENTATIONS,
  OUTCOMES,
  SUPPRESSION_MODES,
  type ContinuityDetailLevel,
  type ContinuityOutcome,
  type ContinuitySuppression,
  type NextStepPresentation
} from "./types.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ID_MAX = 160;
const TEXT_MAX = 500;
export const EXPERIENCE_LEARNING_MAX_TTL_MS = 30 * 24 * 60 * 60_000;

export const EXPERIENCE_LEARNING_SCOPES = [
  "thread-display",
  "thread-timing",
  "thread-suppression"
] as const;
export type ExperienceLearningScope = (typeof EXPERIENCE_LEARNING_SCOPES)[number];

export const EXPERIENCE_TIMING_ADJUSTMENTS = [
  "increase-cooldown",
  "increase-stable-focus"
] as const;
export type ExperienceTimingAdjustment = (typeof EXPERIENCE_TIMING_ADJUSTMENTS)[number];

/**
 * The complete adaptive authority surface. It can only alter presentation,
 * suppression, or make proactive timing more conservative; it has no fields
 * for permission, source, recipient, retention, or external actions.
 */
export type ExperienceLearningChange =
  | Readonly<{
      detail: ContinuityDetailLevel;
      kind: "thread-display";
      nextStep: NextStepPresentation;
    }>
  | Readonly<{
      kind: "thread-suppression";
      suppression: ContinuitySuppression;
    }>
  | Readonly<{
      adjustment: ExperienceTimingAdjustment;
      kind: "thread-timing";
    }>;

export const EXPERIENCE_SOURCE_RUN_CLASSES = ["controlled", "organic-production"] as const;
export type ExperienceSourceRunClass = (typeof EXPERIENCE_SOURCE_RUN_CLASSES)[number];

const EXPERIENCE_LEARNING_OUTCOMES: readonly ContinuityOutcome[] = [
  "adjusted",
  "ignored",
  "rejected"
];

export interface ExperienceSourceRun {
  readonly behaviorDigest: string;
  readonly completedAt: string;
  readonly evidenceClass: ExperienceSourceRunClass;
  readonly runId: string;
}

export interface ExplicitExperienceOutcome {
  readonly authority: "owner-explicit";
  readonly outcome: ContinuityOutcome;
  readonly outcomeId: string;
  readonly recordedAt: string;
  readonly runId: string;
}

export interface ProposeExperienceLearningCandidateInput {
  readonly activeBehaviorDigest: string;
  readonly expectedBenefit: string;
  readonly expiresAt: string;
  readonly experienceId: string;
  readonly outcome?: ExplicitExperienceOutcome;
  readonly proposedAt: string;
  readonly proposedBehavior: string;
  readonly proposedChange: ExperienceLearningChange;
  readonly scope: {
    readonly kind: ExperienceLearningScope;
    readonly threadId: string;
  };
  readonly sourceRun?: ExperienceSourceRun;
}

export interface ExperienceLearningCandidate {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly activation: "none";
  readonly candidateId: string;
  readonly expectedBenefit: string;
  readonly expiresAt: string;
  readonly experienceId: string;
  readonly outcome: ExplicitExperienceOutcome;
  readonly pipeline: "collaboration-policy";
  readonly proposedAt: string;
  readonly proposedBehavior: string;
  readonly proposedChange: ExperienceLearningChange;
  readonly scope: {
    readonly kind: ExperienceLearningScope;
    readonly threadId: string;
  };
  readonly sourceRun: ExperienceSourceRun;
  readonly status: "proposed";
}

/**
 * Builds a detached proposal receipt only when one immutable source run and
 * one explicit owner outcome name the same run. It cannot activate behavior:
 * the before/after active digest is byte-identical and the returned authority
 * is permanently `activation: "none"`.
 */
export function proposeExperienceLearningCandidate(
  input: ProposeExperienceLearningCandidateInput
): ExperienceLearningCandidate | undefined {
  if (!isExactRecord(input, [
    "activeBehaviorDigest",
    "expectedBenefit",
    "expiresAt",
    "experienceId",
    "outcome",
    "proposedAt",
    "proposedBehavior",
    "proposedChange",
    "scope",
    "sourceRun"
  ])) return undefined;
  const sourceRun = input.sourceRun;
  const outcome = input.outcome;
  if (!sourceRun || !outcome) return undefined;
  if (!isSourceRun(sourceRun) || !isExplicitOutcome(outcome)) return undefined;
  if (!isExperienceLearningOutcome(outcome.outcome)) return undefined;
  if (sourceRun.runId !== outcome.runId) return undefined;
  if (!isDigest(input.activeBehaviorDigest)) return undefined;
  const proposedChange = parseExperienceLearningChange(input.proposedChange, input.scope?.kind);
  if (!isBoundedText(input.experienceId, ID_MAX)
    || !isBoundedText(input.proposedBehavior, TEXT_MAX)
    || !isBoundedText(input.expectedBenefit, TEXT_MAX)
    || !isIso(input.proposedAt)
    || !isIso(input.expiresAt)
    || Date.parse(input.expiresAt) <= Date.parse(input.proposedAt)
    || Date.parse(input.expiresAt) - Date.parse(input.proposedAt) > EXPERIENCE_LEARNING_MAX_TTL_MS
    || Date.parse(outcome.recordedAt) > Date.parse(input.proposedAt)
    || Date.parse(sourceRun.completedAt) > Date.parse(outcome.recordedAt)
    || !isScope(input.scope)
    || !proposedChange) {
    return undefined;
  }

  const sourceCopy = Object.freeze({ ...sourceRun });
  const outcomeCopy = Object.freeze({ ...outcome });
  const scopeCopy = Object.freeze({ ...input.scope });
  const candidateId = `learning_${sha256Hex(JSON.stringify([
    input.experienceId,
    sourceCopy.runId,
    sourceCopy.behaviorDigest,
    sourceCopy.evidenceClass,
    sourceCopy.completedAt,
    outcomeCopy.outcomeId,
    outcomeCopy.outcome,
    outcomeCopy.recordedAt,
    input.activeBehaviorDigest,
    scopeCopy.kind,
    scopeCopy.threadId,
    input.proposedBehavior,
    proposedChange,
    input.expectedBenefit,
    input.proposedAt,
    input.expiresAt
  ]))}`;
  return Object.freeze({
    activeBehaviorDigestAfter: input.activeBehaviorDigest,
    activeBehaviorDigestBefore: input.activeBehaviorDigest,
    activation: "none",
    candidateId,
    expectedBenefit: input.expectedBenefit,
    expiresAt: input.expiresAt,
    experienceId: input.experienceId,
    outcome: outcomeCopy,
    pipeline: "collaboration-policy",
    proposedAt: input.proposedAt,
    proposedBehavior: input.proposedBehavior,
    proposedChange,
    scope: scopeCopy,
    sourceRun: sourceCopy,
    status: "proposed"
  });
}

export function isExperienceLearningOutcome(
  outcome: ContinuityOutcome
): outcome is Exclude<ContinuityOutcome, "used"> {
  return EXPERIENCE_LEARNING_OUTCOMES.includes(outcome);
}

export function parseExperienceLearningChange(
  value: unknown,
  expectedKind?: ExperienceLearningScope
): ExperienceLearningChange | undefined {
  if (!isExactRecord(value, expectedKind === "thread-display"
    ? ["detail", "kind", "nextStep"]
    : expectedKind === "thread-suppression"
      ? ["kind", "suppression"]
      : expectedKind === "thread-timing"
        ? ["adjustment", "kind"]
        : [])) {
    return undefined;
  }
  if (expectedKind === "thread-display"
    && value.kind === expectedKind
    && DETAIL_LEVELS.includes(value.detail as ContinuityDetailLevel)
    && NEXT_STEP_PRESENTATIONS.includes(value.nextStep as NextStepPresentation)) {
    return Object.freeze({
      detail: value.detail as ContinuityDetailLevel,
      kind: expectedKind,
      nextStep: value.nextStep as NextStepPresentation
    });
  }
  if (expectedKind === "thread-suppression"
    && value.kind === expectedKind
    && SUPPRESSION_MODES.includes(value.suppression as ContinuitySuppression)) {
    return Object.freeze({
      kind: expectedKind,
      suppression: value.suppression as ContinuitySuppression
    });
  }
  if (expectedKind === "thread-timing"
    && value.kind === expectedKind
    && EXPERIENCE_TIMING_ADJUSTMENTS.includes(value.adjustment as ExperienceTimingAdjustment)) {
    return Object.freeze({
      adjustment: value.adjustment as ExperienceTimingAdjustment,
      kind: expectedKind
    });
  }
  return undefined;
}

function isSourceRun(value: unknown): value is ExperienceSourceRun {
  return isExactRecord(value, ["behaviorDigest", "completedAt", "evidenceClass", "runId"])
    && isDigest(value.behaviorDigest)
    && isIso(value.completedAt)
    && EXPERIENCE_SOURCE_RUN_CLASSES.includes(value.evidenceClass as ExperienceSourceRunClass)
    && isBoundedText(value.runId, ID_MAX);
}

function isExplicitOutcome(value: unknown): value is ExplicitExperienceOutcome {
  return isExactRecord(value, ["authority", "outcome", "outcomeId", "recordedAt", "runId"])
    && value.authority === "owner-explicit"
    && OUTCOMES.includes(value.outcome as ContinuityOutcome)
    && isBoundedText(value.outcomeId, ID_MAX)
    && isIso(value.recordedAt)
    && isBoundedText(value.runId, ID_MAX);
}

function isScope(value: unknown): value is ProposeExperienceLearningCandidateInput["scope"] {
  return isExactRecord(value, ["kind", "threadId"])
    && EXPERIENCE_LEARNING_SCOPES.includes(value.kind as ExperienceLearningScope)
    && isBoundedText(value.threadId, ID_MAX);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
