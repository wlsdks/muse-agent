import { assertPlainDataTree, sha256Hex } from "@muse/shared";

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
  readonly criteriaVersion: 1;
  readonly effectPerformed: false;
  readonly handleId: string;
  readonly ownerApprovalRequired: true;
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

  const proposalCore = {
    authority: "none" as const,
    baselineOutcomeIds: baseline.map((entry) => entry.outcomeId),
    criteriaVersion: 1 as const,
    effectPerformed: false as const,
    handleId: handle.handleId,
    ownerApprovalRequired: true as const,
    promotedOutcomeIds: promoted.map((entry) => entry.outcomeId),
    reason: "post-promotion-regression" as const,
    schemaVersion: 1 as const,
    status: "proposed" as const
  };
  const proposal = Object.freeze({
    authority: proposalCore.authority,
    criteriaVersion: proposalCore.criteriaVersion,
    effectPerformed: proposalCore.effectPerformed,
    handleId: proposalCore.handleId,
    ownerApprovalRequired: proposalCore.ownerApprovalRequired,
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
