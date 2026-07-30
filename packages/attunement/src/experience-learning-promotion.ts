import { sha256Hex } from "@muse/shared";

import {
  EXPERIENCE_LEARNING_SCOPES,
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate
} from "./experience-learning-candidate.js";
import {
  compareExperienceLearningReplay,
  type ExperienceLearningReplay,
  type ExperienceReplayCase
} from "./experience-learning-replay.js";
import {
  runActiveAttunementPolicyMutation,
  type ActiveAttunementPolicyWriteGate
} from "./active-policy-write-gate.js";

export const EXPERIENCE_LEARNING_PROMOTION_MIN_CASES = 10;

export interface ExperienceLearningPromotionApproval {
  readonly approvedAt: string;
  readonly authority: "owner-explicit";
  readonly candidateId: string;
  readonly replayInputHash: string;
}

export interface ExperienceLearningPromotionInput {
  readonly approval: ExperienceLearningPromotionApproval;
  readonly appliedAt: string;
  readonly candidate: ExperienceLearningCandidate;
  readonly replay: ExperienceLearningReplay;
  readonly replayCases: readonly ExperienceReplayCase[];
}

export interface ExperienceLearningPolicyTransition {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly candidateId: string;
  readonly proposedBehavior: string;
  readonly replayInputHash: string;
  readonly scope: ExperienceLearningCandidate["scope"];
}

/**
 * Must atomically compare the active behavior digest with `expectedDigest` and
 * replace it with `nextDigest`. `false` means no mutation occurred.
 */
export type ExperienceLearningPolicyCompareAndSwap = (
  transition: Readonly<{
    expectedDigest: string;
    nextDigest: string;
  }>
) => Promise<boolean>;

export interface ExperienceLearningPromotionReceipt extends ExperienceLearningPolicyTransition {
  readonly appliedAt: string;
  readonly approvedAt: string;
  readonly authority: "owner-explicit";
  readonly promotionApplied: true;
  readonly promotionId: string;
  readonly schemaVersion: 1;
}

export interface ExperienceLearningRollbackReceipt {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly promotionId: string;
  readonly rollbackApplied: true;
  readonly rollbackId: string;
  readonly rolledBackAt: string;
  readonly schemaVersion: 1;
}

export type ExperienceLearningPromotionErrorCode =
  | "candidate-expired"
  | "ineligible-replay"
  | "insufficient-evidence"
  | "invalid-approval"
  | "invalid-input"
  | "stale-active-policy";

export class ExperienceLearningPromotionError extends Error {
  constructor(readonly code: ExperienceLearningPromotionErrorCode) {
    super(`experience learning promotion blocked: ${code}`);
    this.name = "ExperienceLearningPromotionError";
  }
}

/**
 * Applies one owner-approved candidate through an atomic active-policy digest
 * compare-and-swap. Frozen replay is recomputed before the mutation; supplied
 * aggregates cannot promote themselves.
 */
export async function promoteExperienceLearningCandidate(
  input: ExperienceLearningPromotionInput,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined,
  compareAndSwap: ExperienceLearningPolicyCompareAndSwap
): Promise<ExperienceLearningPromotionReceipt> {
  const transition = validatePromotion(input);
  return runActiveAttunementPolicyMutation(activePolicyWriteGate, async () => {
    const applied = await compareAndSwap(Object.freeze({
      expectedDigest: transition.activeBehaviorDigestBefore,
      nextDigest: transition.activeBehaviorDigestAfter
    }));
    if (!applied) throw new ExperienceLearningPromotionError("stale-active-policy");

    const promotionId = `learning_promotion_${sha256Hex(JSON.stringify([
      transition.candidateId,
      transition.replayInputHash,
      transition.activeBehaviorDigestBefore,
      transition.activeBehaviorDigestAfter,
      transition.scope.kind,
      transition.scope.threadId,
      transition.proposedBehavior,
      input.approval.approvedAt,
      input.appliedAt
    ]))}`;
    return Object.freeze({
      ...transition,
      appliedAt: input.appliedAt,
      approvedAt: input.approval.approvedAt,
      authority: "owner-explicit" as const,
      promotionApplied: true as const,
      promotionId,
      schemaVersion: 1 as const
    });
  });
}

/**
 * Reverts exactly one promotion only while its promoted digest is still
 * current. Concurrent policy changes therefore fail closed instead of being
 * overwritten.
 */
export async function rollbackExperienceLearningPromotion(
  receipt: ExperienceLearningPromotionReceipt,
  rolledBackAt: string,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined,
  compareAndSwap: ExperienceLearningPolicyCompareAndSwap
): Promise<ExperienceLearningRollbackReceipt> {
  if (!isValidPromotionReceipt(receipt)
    || !isIso(rolledBackAt)
    || Date.parse(rolledBackAt) < Date.parse(receipt.appliedAt)) {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  return runActiveAttunementPolicyMutation(activePolicyWriteGate, async () => {
    const applied = await compareAndSwap(Object.freeze({
      expectedDigest: receipt.activeBehaviorDigestAfter,
      nextDigest: receipt.activeBehaviorDigestBefore
    }));
    if (!applied) throw new ExperienceLearningPromotionError("stale-active-policy");

    const rollbackId = `learning_rollback_${sha256Hex(JSON.stringify([
      receipt.promotionId,
      receipt.activeBehaviorDigestAfter,
      receipt.activeBehaviorDigestBefore,
      rolledBackAt
    ]))}`;
    return Object.freeze({
      activeBehaviorDigestAfter: receipt.activeBehaviorDigestBefore,
      activeBehaviorDigestBefore: receipt.activeBehaviorDigestAfter,
      promotionId: receipt.promotionId,
      rollbackApplied: true as const,
      rollbackId,
      rolledBackAt,
      schemaVersion: 1 as const
    });
  });
}

function validatePromotion(input: ExperienceLearningPromotionInput): ExperienceLearningPolicyTransition {
  if (!isIso(input.appliedAt) || !isExactApproval(input.approval)) {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  const candidate = input.candidate;
  const rebuiltCandidate = proposeExperienceLearningCandidate({
    activeBehaviorDigest: candidate.activeBehaviorDigestBefore,
    expectedBenefit: candidate.expectedBenefit,
    expiresAt: candidate.expiresAt,
    experienceId: candidate.experienceId,
    outcome: candidate.outcome,
    proposedAt: candidate.proposedAt,
    proposedBehavior: candidate.proposedBehavior,
    scope: candidate.scope,
    sourceRun: candidate.sourceRun
  });
  if (!rebuiltCandidate
    || rebuiltCandidate.candidateId !== candidate.candidateId
    || candidate.activeBehaviorDigestBefore !== candidate.activeBehaviorDigestAfter
    || candidate.activation !== "none"
    || candidate.status !== "proposed") {
    throw new ExperienceLearningPromotionError("invalid-input");
  }

  const recomputedReplay = compareExperienceLearningReplay(candidate, input.replayCases);
  if (!recomputedReplay || !sameReplay(recomputedReplay, input.replay)) {
    throw new ExperienceLearningPromotionError("ineligible-replay");
  }
  if (recomputedReplay.aggregate.total < EXPERIENCE_LEARNING_PROMOTION_MIN_CASES) {
    throw new ExperienceLearningPromotionError("insufficient-evidence");
  }
  if (recomputedReplay.recommendation !== "eligible-for-review"
    || recomputedReplay.aggregate.improvements < 1
    || recomputedReplay.aggregate.regressions !== 0) {
    throw new ExperienceLearningPromotionError("ineligible-replay");
  }
  if (input.approval.authority !== "owner-explicit"
    || input.approval.candidateId !== candidate.candidateId
    || input.approval.replayInputHash !== recomputedReplay.inputHash
    || Date.parse(input.approval.approvedAt) < Date.parse(candidate.proposedAt)
    || Date.parse(input.appliedAt) < Date.parse(input.approval.approvedAt)) {
    throw new ExperienceLearningPromotionError("invalid-approval");
  }
  if (Date.parse(input.appliedAt) >= Date.parse(candidate.expiresAt)) {
    throw new ExperienceLearningPromotionError("candidate-expired");
  }

  const activeBehaviorDigestAfter = computePromotedDigest(
    candidate.activeBehaviorDigestBefore,
    candidate.scope,
    candidate.proposedBehavior
  );
  return Object.freeze({
    activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: candidate.activeBehaviorDigestBefore,
    candidateId: candidate.candidateId,
    proposedBehavior: candidate.proposedBehavior,
    replayInputHash: recomputedReplay.inputHash,
    scope: Object.freeze({ ...candidate.scope })
  });
}

function sameReplay(left: ExperienceLearningReplay, right: ExperienceLearningReplay): boolean {
  return left.candidateId === right.candidateId
    && left.inputHash === right.inputHash
    && left.promotionApplied === right.promotionApplied
    && left.recommendation === right.recommendation
    && left.replayStatus === right.replayStatus
    && left.schemaVersion === right.schemaVersion
    && left.caseIds.length === right.caseIds.length
    && left.caseIds.every((caseId, index) => caseId === right.caseIds[index])
    && left.aggregate.baselinePassed === right.aggregate.baselinePassed
    && left.aggregate.challengerPassed === right.aggregate.challengerPassed
    && left.aggregate.improvements === right.aggregate.improvements
    && left.aggregate.regressions === right.aggregate.regressions
    && left.aggregate.ties === right.aggregate.ties
    && left.aggregate.total === right.aggregate.total;
}

function isExactApproval(value: ExperienceLearningPromotionApproval): boolean {
  return isExactRecord(value, ["approvedAt", "authority", "candidateId", "replayInputHash"])
    && value.authority === "owner-explicit"
    && isIso(value.approvedAt)
    && typeof value.candidateId === "string"
    && value.candidateId.length > 0
    && /^[a-f0-9]{64}$/u.test(value.replayInputHash);
}

function isValidPromotionReceipt(value: ExperienceLearningPromotionReceipt): boolean {
  if (!isExactRecord(value, [
    "activeBehaviorDigestAfter",
    "activeBehaviorDigestBefore",
    "appliedAt",
    "approvedAt",
    "authority",
    "candidateId",
    "promotionApplied",
    "promotionId",
    "proposedBehavior",
    "replayInputHash",
    "schemaVersion",
    "scope"
  ])
    || value.authority !== "owner-explicit"
    || value.promotionApplied !== true
    || value.schemaVersion !== 1
    || !isIso(value.appliedAt)
    || !isIso(value.approvedAt)
    || !isDigest(value.activeBehaviorDigestBefore)
    || !isDigest(value.activeBehaviorDigestAfter)
    || !isDigest(value.replayInputHash)
    || typeof value.candidateId !== "string"
    || value.candidateId.length === 0
    || typeof value.proposedBehavior !== "string"
    || value.proposedBehavior.length === 0
    || value.proposedBehavior.length > 500
    || value.proposedBehavior.trim() !== value.proposedBehavior
    || !isExactRecord(value.scope, ["kind", "threadId"])
    || !EXPERIENCE_LEARNING_SCOPES.includes(value.scope.kind as ExperienceLearningCandidate["scope"]["kind"])
    || typeof value.scope.threadId !== "string"
    || value.scope.threadId.length === 0
    || Date.parse(value.approvedAt) > Date.parse(value.appliedAt)
    || value.activeBehaviorDigestAfter !== computePromotedDigest(
      value.activeBehaviorDigestBefore,
      value.scope as unknown as ExperienceLearningCandidate["scope"],
      value.proposedBehavior
    )) {
    return false;
  }
  const expectedId = `learning_promotion_${sha256Hex(JSON.stringify([
    value.candidateId,
    value.replayInputHash,
    value.activeBehaviorDigestBefore,
    value.activeBehaviorDigestAfter,
    value.scope.kind,
    value.scope.threadId,
    value.proposedBehavior,
    value.approvedAt,
    value.appliedAt
  ]))}`;
  return value.promotionId === expectedId;
}

function computePromotedDigest(
  activeBehaviorDigestBefore: string,
  scope: ExperienceLearningCandidate["scope"],
  proposedBehavior: string
): string {
  return sha256Hex(JSON.stringify([
    "muse.experience-learning-promotion.v1",
    activeBehaviorDigestBefore,
    scope.kind,
    scope.threadId,
    proposedBehavior
  ]));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}
