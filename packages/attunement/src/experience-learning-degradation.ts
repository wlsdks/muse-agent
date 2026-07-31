import {
  assertPlainDataTree,
  sha256Hex,
  type AdaptationLoopHealthInput
} from "@muse/shared";

import {
  parseExperienceLearningPromotionHandle,
  type ExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";
import { OUTCOMES, type ContinuityOutcome } from "./types.js";

export const EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE = 5;
export const EXPERIENCE_LEARNING_DEGRADATION_USED_DROP = 2;
export const EXPERIENCE_LEARNING_DEGRADATION_REJECTED_RISE = 1;

export interface ExperienceLearningOutcomeEvidence {
  readonly authority: "owner-explicit";
  readonly behaviorDigest: string;
  readonly deliveryId: string;
  readonly evidenceClass: "organic-production";
  readonly outcome: ContinuityOutcome;
  readonly outcomeId: string;
  readonly recordedAt: string;
  readonly threadId: string;
}

export interface ExperienceLearningOutcomeSummary {
  readonly adjusted: number;
  readonly ignored: number;
  readonly rejected: number;
  readonly total: number;
  readonly used: number;
}

export interface ExperienceLearningRollbackProposal {
  readonly authority: "none";
  readonly baselineOutcomeIds: readonly string[];
  readonly criteriaVersion: 1;
  readonly effectPerformed: false;
  readonly handleId: string;
  readonly ownerApprovalRequired: true;
  readonly promotedOutcomeIds: readonly string[];
  readonly proposalId: string;
  readonly reason: "post-promotion-regression";
  readonly schemaVersion: 1;
  readonly status: "proposed";
}

export interface ExperienceLearningDegradationAssessment {
  readonly baseline: ExperienceLearningOutcomeSummary;
  readonly handleId: string;
  readonly promoted: ExperienceLearningOutcomeSummary;
  readonly proposal?: ExperienceLearningRollbackProposal;
  readonly reason:
    | "insufficient-window"
    | "no-regression"
    | "post-promotion-regression";
  readonly requiredOutcomesPerWindow: 5;
  readonly status: "hold" | "propose-rollback";
}

/**
 * Produces an inert, content-bound rollback proposal from two complete,
 * comparable organic outcome windows. It never grants approval or performs
 * rollback; the existing owner-gated handle path remains the only mutation.
 */
export function assessExperienceLearningDegradation(
  value: unknown
): ExperienceLearningDegradationAssessment | undefined {
  try {
    assertPlainDataTree(value, "experienceLearningDegradationInput");
  } catch {
    return undefined;
  }
  if (!isExactRecord(value, ["baseline", "handle", "promoted"])) return undefined;
  const handle = parseExperienceLearningPromotionHandle(value.handle);
  if (!handle) return undefined;
  const baseline = parseWindow(
    value.baseline,
    handle,
    "baseline"
  );
  const promoted = parseWindow(
    value.promoted,
    handle,
    "promoted"
  );
  if (!baseline || !promoted) return undefined;
  const ids = [...baseline, ...promoted].flatMap((entry) => [
    `delivery:${entry.deliveryId}`,
    `outcome:${entry.outcomeId}`
  ]);
  if (new Set(ids).size !== ids.length) return undefined;

  const baselineSummary = summarize(baseline);
  const promotedSummary = summarize(promoted);
  const complete = baseline.length === EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE
    && promoted.length === EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE;
  if (!complete) {
    return Object.freeze({
      baseline: baselineSummary,
      handleId: handle.handleId,
      promoted: promotedSummary,
      reason: "insufficient-window",
      requiredOutcomesPerWindow: EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE,
      status: "hold"
    });
  }
  const regressed =
    baselineSummary.used - promotedSummary.used
      >= EXPERIENCE_LEARNING_DEGRADATION_USED_DROP
    && promotedSummary.rejected - baselineSummary.rejected
      >= EXPERIENCE_LEARNING_DEGRADATION_REJECTED_RISE;
  if (!regressed) {
    return Object.freeze({
      baseline: baselineSummary,
      handleId: handle.handleId,
      promoted: promotedSummary,
      reason: "no-regression",
      requiredOutcomesPerWindow: EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE,
      status: "hold"
    });
  }
  const baselineOutcomeIds = baseline.map((entry) => entry.outcomeId);
  const promotedOutcomeIds = promoted.map((entry) => entry.outcomeId);
  if (!isCanonicalOutcomeIdWindow(baselineOutcomeIds)
    || !isCanonicalOutcomeIdWindow(promotedOutcomeIds)) {
    return undefined;
  }

  const proposalCore = {
    authority: "none" as const,
    baselineOutcomeIds,
    criteriaVersion: 1 as const,
    effectPerformed: false as const,
    handleId: handle.handleId,
    ownerApprovalRequired: true as const,
    promotedOutcomeIds,
    reason: "post-promotion-regression" as const,
    schemaVersion: 1 as const,
    status: "proposed" as const
  };
  const proposal = Object.freeze({
    authority: proposalCore.authority,
    baselineOutcomeIds: Object.freeze([...proposalCore.baselineOutcomeIds]),
    criteriaVersion: proposalCore.criteriaVersion,
    effectPerformed: proposalCore.effectPerformed,
    handleId: proposalCore.handleId,
    ownerApprovalRequired: proposalCore.ownerApprovalRequired,
    promotedOutcomeIds: Object.freeze([...proposalCore.promotedOutcomeIds]),
    proposalId: `learning_rollback_proposal_${sha256Hex(JSON.stringify(proposalCore))}`,
    reason: proposalCore.reason,
    schemaVersion: proposalCore.schemaVersion,
    status: proposalCore.status
  });
  return Object.freeze({
    baseline: baselineSummary,
    handleId: handle.handleId,
    promoted: promotedSummary,
    proposal,
    reason: "post-promotion-regression",
    requiredOutcomesPerWindow: EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE,
    status: "propose-rollback"
  });
}

/**
 * Recomputes a serialized inert proposal before it can affect loop health.
 * This verifies receipt integrity only; it grants no approval or rollback.
 */
export function projectVerifiedExperienceLearningRollbackProposalHealth(
  value: unknown
): AdaptationLoopHealthInput | undefined {
  try {
    assertPlainDataTree(value, "experienceLearningRollbackProposal");
  } catch {
    return undefined;
  }
  if (!isExactRecord(value, [
    "authority",
    "baselineOutcomeIds",
    "criteriaVersion",
    "effectPerformed",
    "handleId",
    "ownerApprovalRequired",
    "promotedOutcomeIds",
    "proposalId",
    "reason",
    "schemaVersion",
    "status"
  ])
    || value.authority !== "none"
    || value.criteriaVersion !== 1
    || value.effectPerformed !== false
    || value.ownerApprovalRequired !== true
    || value.reason !== "post-promotion-regression"
    || value.schemaVersion !== 1
    || value.status !== "proposed"
    || typeof value.handleId !== "string"
    || !/^learning_promotion_handle_[a-f0-9]{64}$/u.test(value.handleId)
    || typeof value.proposalId !== "string"
    || !isCanonicalOutcomeIdWindow(value.baselineOutcomeIds)
    || !isCanonicalOutcomeIdWindow(value.promotedOutcomeIds)) {
    return undefined;
  }
  const ids = [...value.baselineOutcomeIds, ...value.promotedOutcomeIds];
  if (new Set(ids).size !== ids.length) return undefined;
  const core = {
    authority: value.authority,
    baselineOutcomeIds: value.baselineOutcomeIds,
    criteriaVersion: value.criteriaVersion,
    effectPerformed: value.effectPerformed,
    handleId: value.handleId,
    ownerApprovalRequired: value.ownerApprovalRequired,
    promotedOutcomeIds: value.promotedOutcomeIds,
    reason: value.reason,
    schemaVersion: value.schemaVersion,
    status: value.status
  };
  const proposalId =
    `learning_rollback_proposal_${sha256Hex(JSON.stringify(core))}`;
  return value.proposalId === proposalId
    ? Object.freeze({
        evidenceId: proposalId,
        evidenceVerified: true,
        status: "rollback-proposed"
      })
    : undefined;
}

function parseWindow(
  value: unknown,
  handle: ExperienceLearningPromotionHandle,
  kind: "baseline" | "promoted"
): readonly ExperienceLearningOutcomeEvidence[] | undefined {
  if (!Array.isArray(value)
    || value.length > EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE) {
    return undefined;
  }
  const parsed: ExperienceLearningOutcomeEvidence[] = [];
  let previousKey: string | undefined;
  for (const entry of value) {
    if (!isExactRecord(entry, [
      "authority",
      "behaviorDigest",
      "deliveryId",
      "evidenceClass",
      "outcome",
      "outcomeId",
      "recordedAt",
      "threadId"
    ])
      || entry.authority !== "owner-explicit"
      || entry.evidenceClass !== "organic-production"
      || entry.threadId !== handle.threadId
      || entry.behaviorDigest !== (
        kind === "baseline"
          ? handle.activeBehaviorDigestBefore
          : handle.activeBehaviorDigestAfter
      )
      || typeof entry.deliveryId !== "string"
      || !isSafeId(entry.deliveryId)
      || typeof entry.outcomeId !== "string"
      || !isSafeId(entry.outcomeId)
      || !OUTCOMES.includes(entry.outcome as ContinuityOutcome)
      || typeof entry.recordedAt !== "string"
      || !isCanonicalIso(entry.recordedAt)) {
      return undefined;
    }
    const timestamp = Date.parse(entry.recordedAt);
    const appliedAt = Date.parse(handle.appliedAt);
    if ((kind === "baseline" && timestamp >= appliedAt)
      || (kind === "promoted" && timestamp < appliedAt)) {
      return undefined;
    }
    const orderKey = `${entry.recordedAt}\u0000${entry.outcomeId}`;
    if (previousKey !== undefined && orderKey <= previousKey) return undefined;
    previousKey = orderKey;
    parsed.push(Object.freeze({
      authority: "owner-explicit",
      behaviorDigest: entry.behaviorDigest,
      deliveryId: entry.deliveryId,
      evidenceClass: "organic-production",
      outcome: entry.outcome as ContinuityOutcome,
      outcomeId: entry.outcomeId,
      recordedAt: entry.recordedAt,
      threadId: entry.threadId
    }));
  }
  return Object.freeze(parsed);
}

function summarize(
  outcomes: readonly ExperienceLearningOutcomeEvidence[]
): ExperienceLearningOutcomeSummary {
  const summary = {
    adjusted: 0,
    ignored: 0,
    rejected: 0,
    total: outcomes.length,
    used: 0
  };
  for (const entry of outcomes) summary[entry.outcome] += 1;
  return Object.freeze(summary);
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isCanonicalOutcomeIdWindow(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length === EXPERIENCE_LEARNING_DEGRADATION_WINDOW_SIZE
    && value.every((entry) =>
      typeof entry === "string"
      && /^continuity_outcome_[a-f0-9]{64}$/u.test(entry));
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length
    && ownKeys.every((key) =>
      typeof key === "string" && keys.includes(key));
}
