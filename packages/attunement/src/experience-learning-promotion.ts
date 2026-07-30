import {
  assertPlainDataTree,
  sha256Hex,
  type AdaptationLoopHealthInput
} from "@muse/shared";

import {
  EXPERIENCE_LEARNING_SCOPES,
  parseExperienceLearningChange,
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
import { reduceExperienceLearningContinuityPolicy } from "./experience-learning-policy-reducer.js";
import { buildExperienceLearningPolicyAudit } from "./experience-learning-policy-audit.js";
import {
  createExperienceLearningPromotionHandle,
  type ExperienceLearningPromotionHandle
} from "./experience-learning-promotion-handle.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { ContinuityPolicy, ExperienceLearningPolicyAudit } from "./types.js";

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
  readonly currentPolicy: ContinuityPolicy;
  readonly nextPolicyVersion: number;
  readonly replay: ExperienceLearningReplay;
  readonly replayCases: readonly ExperienceReplayCase[];
}

export interface ExperienceLearningPolicyTransition {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly candidateId: string;
  readonly proposedBehavior: string;
  readonly proposedChange: ExperienceLearningCandidate["proposedChange"];
  readonly policyAfter: ContinuityPolicy;
  readonly policyBefore: ContinuityPolicy;
  readonly replayInputHash: string;
  readonly scope: ExperienceLearningCandidate["scope"];
}

/**
 * Must atomically compare the exact active policy with `policyBefore` and
 * replace it with `policyAfter`. Digests are redundant fail-closed evidence.
 */
export type ExperienceLearningPolicyCompareAndSwap = (
  transition: Readonly<{
    expectedDigest: string;
    audit: ExperienceLearningPolicyAudit;
    nextDigest: string;
    policyAfter: ContinuityPolicy;
    policyBefore: ContinuityPolicy;
    promotionHandle?: ExperienceLearningPromotionHandle;
    threadId: string;
  }>
) => Promise<boolean>;

export interface ExperienceLearningPromotionReceipt extends ExperienceLearningPolicyTransition {
  readonly appliedAt: string;
  readonly approvedAt: string;
  readonly authority: "owner-explicit";
  readonly promotionApplied: true;
  readonly promotionId: string;
  readonly schemaVersion: 2;
}

export interface ExperienceLearningRollbackReceipt {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly promotionId: string;
  readonly policyAfter: ContinuityPolicy;
  readonly policyBefore: ContinuityPolicy;
  readonly rollbackApplied: true;
  readonly rollbackId: string;
  readonly rolledBackAt: string;
  readonly schemaVersion: 2;
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
  const promotionId = `learning_promotion_${sha256Hex(JSON.stringify([
    transition.candidateId,
    transition.replayInputHash,
    transition.activeBehaviorDigestBefore,
    transition.activeBehaviorDigestAfter,
    transition.scope.kind,
    transition.scope.threadId,
    transition.proposedBehavior,
    transition.proposedChange,
    input.approval.approvedAt,
    input.appliedAt
  ]))}`;
  const receipt: ExperienceLearningPromotionReceipt = Object.freeze({
    ...transition,
    appliedAt: input.appliedAt,
    approvedAt: input.approval.approvedAt,
    authority: "owner-explicit",
    promotionApplied: true,
    promotionId,
    schemaVersion: 2
  });
  return runActiveAttunementPolicyMutation(activePolicyWriteGate, async () => {
    const audit = promotionAudit(receipt);
    const promotionHandle = createExperienceLearningPromotionHandle({
      activeBehaviorDigestAfter: receipt.activeBehaviorDigestAfter,
      activeBehaviorDigestBefore: receipt.activeBehaviorDigestBefore,
      appliedAt: receipt.appliedAt,
      authority: receipt.authority,
      candidateId: receipt.candidateId,
      policyAfter: receipt.policyAfter,
      policyBefore: receipt.policyBefore,
      promotionAuditId: audit.id,
      promotionId: receipt.promotionId,
      threadId: receipt.scope.threadId
    });
    if (!promotionHandle) {
      throw new ExperienceLearningPromotionError("invalid-input");
    }
    const applied = await compareAndSwap(Object.freeze({
      audit,
      expectedDigest: transition.activeBehaviorDigestBefore,
      nextDigest: transition.activeBehaviorDigestAfter,
      policyAfter: transition.policyAfter,
      policyBefore: transition.policyBefore,
      promotionHandle,
      threadId: transition.scope.threadId
    }));
    if (!applied) throw new ExperienceLearningPromotionError("stale-active-policy");
    return receipt;
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
  rollbackPolicyVersion: number,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined,
  compareAndSwap: ExperienceLearningPolicyCompareAndSwap
): Promise<ExperienceLearningRollbackReceipt> {
  if (!isValidPromotionReceipt(receipt)
    || !isIso(rolledBackAt)
    || !Number.isSafeInteger(rollbackPolicyVersion)
    || rollbackPolicyVersion <= receipt.policyAfter.version
    || Date.parse(rolledBackAt) < Date.parse(receipt.appliedAt)) {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  const restoredPolicy = Object.freeze({
    ...receipt.policyBefore,
    version: rollbackPolicyVersion
  });
  const restoredDigest = fingerprintContinuityPolicy(restoredPolicy);
  const rollbackId = `learning_rollback_${sha256Hex(JSON.stringify([
    receipt.promotionId,
    receipt.activeBehaviorDigestAfter,
    restoredDigest,
    rolledBackAt
  ]))}`;
  const rollbackReceipt: ExperienceLearningRollbackReceipt = Object.freeze({
    activeBehaviorDigestAfter: restoredDigest,
    activeBehaviorDigestBefore: receipt.activeBehaviorDigestAfter,
    policyAfter: restoredPolicy,
    policyBefore: receipt.policyAfter,
    promotionId: receipt.promotionId,
    rollbackApplied: true,
    rollbackId,
    rolledBackAt,
    schemaVersion: 2
  });
  return runActiveAttunementPolicyMutation(activePolicyWriteGate, async () => {
    const applied = await compareAndSwap(Object.freeze({
      audit: rollbackAudit(receipt, rollbackReceipt),
      expectedDigest: receipt.activeBehaviorDigestAfter,
      nextDigest: restoredDigest,
      policyAfter: restoredPolicy,
      policyBefore: receipt.policyAfter,
      threadId: receipt.scope.threadId
    }));
    if (!applied) throw new ExperienceLearningPromotionError("stale-active-policy");
    return rollbackReceipt;
  });
}

/**
 * Projects only a fully recomputed promotion receipt into the cross-loop health
 * contract. This grants no mutation authority and never creates approval.
 */
export function projectVerifiedExperienceLearningPromotionHealth(
  value: unknown
): AdaptationLoopHealthInput | undefined {
  try {
    assertPlainDataTree(value, "experienceLearningPromotionReceipt");
  } catch {
    return undefined;
  }
  const receipt = value as unknown as ExperienceLearningPromotionReceipt;
  if (!isValidPromotionReceipt(receipt)) {
    return undefined;
  }
  return Object.freeze({
    evidenceId: receipt.promotionId,
    evidenceVerified: true,
    status: "promoted"
  });
}

function promotionAudit(
  receipt: ExperienceLearningPromotionReceipt
): ExperienceLearningPolicyAudit {
  return buildExperienceLearningPolicyAudit({
    activeBehaviorDigestAfter: receipt.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: receipt.activeBehaviorDigestBefore,
    authority: "owner-explicit",
    candidateId: receipt.candidateId,
    kind: "promotion",
    occurredAt: receipt.appliedAt,
    policyAfter: receipt.policyAfter,
    policyBefore: receipt.policyBefore,
    sourceId: receipt.candidateId,
    threadId: receipt.scope.threadId
  });
}

function rollbackAudit(
  promotion: ExperienceLearningPromotionReceipt,
  rollback: ExperienceLearningRollbackReceipt
): ExperienceLearningPolicyAudit {
  const promotedAudit = promotionAudit(promotion);
  return buildExperienceLearningPolicyAudit({
    activeBehaviorDigestAfter: rollback.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: rollback.activeBehaviorDigestBefore,
    authority: "owner-explicit",
    candidateId: promotion.candidateId,
    kind: "rollback",
    occurredAt: rollback.rolledBackAt,
    policyAfter: rollback.policyAfter,
    policyBefore: rollback.policyBefore,
    sourceId: promotedAudit.id,
    threadId: promotion.scope.threadId
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
    proposedChange: candidate.proposedChange,
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

  if (!isExactContinuityPolicy(input.currentPolicy)
    || fingerprintContinuityPolicy(input.currentPolicy) !== candidate.activeBehaviorDigestBefore) {
    throw new ExperienceLearningPromotionError("stale-active-policy");
  }
  const policyAfter = reduceExperienceLearningContinuityPolicy(
    input.currentPolicy,
    candidate.proposedChange,
    input.nextPolicyVersion
  );
  if (!policyAfter) throw new ExperienceLearningPromotionError("invalid-input");
  const activeBehaviorDigestAfter = fingerprintContinuityPolicy(policyAfter);
  return Object.freeze({
    activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: candidate.activeBehaviorDigestBefore,
    candidateId: candidate.candidateId,
    proposedBehavior: candidate.proposedBehavior,
    proposedChange: Object.freeze({ ...candidate.proposedChange }) as ExperienceLearningCandidate["proposedChange"],
    policyAfter,
    policyBefore: Object.freeze({ ...input.currentPolicy }),
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
    "policyAfter",
    "policyBefore",
    "proposedBehavior",
    "proposedChange",
    "replayInputHash",
    "schemaVersion",
    "scope"
  ])
    || value.authority !== "owner-explicit"
    || value.promotionApplied !== true
    || value.schemaVersion !== 2
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
    || !isExactContinuityPolicy(value.policyBefore)
    || !isExactContinuityPolicy(value.policyAfter)
    || value.scope.threadId.length === 0) {
    return false;
  }
  const scope = value.scope as unknown as ExperienceLearningCandidate["scope"];
  const proposedChange = parseExperienceLearningChange(value.proposedChange, scope.kind);
  if (!proposedChange
    || Date.parse(value.approvedAt) > Date.parse(value.appliedAt)
    || fingerprintContinuityPolicy(value.policyBefore) !== value.activeBehaviorDigestBefore
    || fingerprintContinuityPolicy(value.policyAfter) !== value.activeBehaviorDigestAfter) return false;
  const recomputedPolicyAfter = reduceExperienceLearningContinuityPolicy(
    value.policyBefore,
    proposedChange,
    value.policyAfter.version
  );
  if (!recomputedPolicyAfter
    || fingerprintContinuityPolicy(recomputedPolicyAfter) !== value.activeBehaviorDigestAfter) {
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
    proposedChange,
    value.approvedAt,
    value.appliedAt
  ]))}`;
  return value.promotionId === expectedId;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isExactContinuityPolicy(value: unknown): value is ContinuityPolicy {
  return isExactRecord(value, ["detail", "nextStep", "suppression", "version"])
    && (value.detail === "standard" || value.detail === "compact")
    && (value.nextStep === "direct" || value.nextStep === "contextual" || value.nextStep === "hidden")
    && (value.suppression === "none" || value.suppression === "acknowledge-previous")
    && Number.isSafeInteger(value.version)
    && (value.version as number) >= 0;
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
