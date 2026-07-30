import { assertPlainDataTree, sha256Hex } from "@muse/shared";

import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { ContinuityPolicy } from "./types.js";

export interface CreateExperienceLearningPromotionHandleInput {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly appliedAt: string;
  readonly authority: "owner-explicit";
  readonly candidateId: string;
  readonly policyAfter: ContinuityPolicy;
  readonly policyBefore: ContinuityPolicy;
  readonly promotionAuditId: string;
  readonly promotionId: string;
  readonly threadId: string;
}

export interface ExperienceLearningPromotionHandle
  extends CreateExperienceLearningPromotionHandleInput {
  readonly handleId: string;
  readonly schemaVersion: 1;
}

const CREATE_KEYS = [
  "activeBehaviorDigestAfter",
  "activeBehaviorDigestBefore",
  "appliedAt",
  "authority",
  "candidateId",
  "policyAfter",
  "policyBefore",
  "promotionAuditId",
  "promotionId",
  "threadId"
] as const;
const HANDLE_KEYS = [...CREATE_KEYS, "handleId", "schemaVersion"] as const;
const DIGEST = /^[a-f0-9]{64}$/u;
const PROMOTION_ID = /^learning_promotion_[a-f0-9]{64}$/u;
const AUDIT_ID = /^learning_policy_audit_[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export function createExperienceLearningPromotionHandle(
  value: unknown
): ExperienceLearningPromotionHandle | undefined {
  try {
    assertPlainDataTree(value, "experienceLearningPromotionHandleInput");
  } catch {
    return undefined;
  }
  if (!isExactRecord(value, CREATE_KEYS)) return undefined;
  const policyBefore = normalizePolicy(value.policyBefore);
  const policyAfter = normalizePolicy(value.policyAfter);
  if (
    value.authority !== "owner-explicit"
    || typeof value.activeBehaviorDigestAfter !== "string"
    || !DIGEST.test(value.activeBehaviorDigestAfter)
    || typeof value.activeBehaviorDigestBefore !== "string"
    || !DIGEST.test(value.activeBehaviorDigestBefore)
    || typeof value.appliedAt !== "string"
    || !isCanonicalIso(value.appliedAt)
    || typeof value.candidateId !== "string"
    || !SAFE_ID.test(value.candidateId)
    || typeof value.promotionAuditId !== "string"
    || !AUDIT_ID.test(value.promotionAuditId)
    || typeof value.promotionId !== "string"
    || !PROMOTION_ID.test(value.promotionId)
    || typeof value.threadId !== "string"
    || !SAFE_ID.test(value.threadId)
    || policyBefore === undefined
    || policyAfter === undefined
    || policyAfter.version <= policyBefore.version
    || fingerprintContinuityPolicy(policyBefore)
      !== value.activeBehaviorDigestBefore
    || fingerprintContinuityPolicy(policyAfter)
      !== value.activeBehaviorDigestAfter) {
    return undefined;
  }
  const core: CreateExperienceLearningPromotionHandleInput = {
    activeBehaviorDigestAfter: value.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: value.activeBehaviorDigestBefore,
    appliedAt: value.appliedAt,
    authority: value.authority,
    candidateId: value.candidateId,
    policyAfter,
    policyBefore,
    promotionAuditId: value.promotionAuditId,
    promotionId: value.promotionId,
    threadId: value.threadId
  };
  const handleId = `learning_promotion_handle_${sha256Hex(JSON.stringify(core))}`;
  return Object.freeze({
    ...core,
    handleId,
    schemaVersion: 1
  });
}

export function parseExperienceLearningPromotionHandle(
  value: unknown
): ExperienceLearningPromotionHandle | undefined {
  try {
    assertPlainDataTree(value, "experienceLearningPromotionHandle");
  } catch {
    return undefined;
  }
  if (!isExactRecord(value, HANDLE_KEYS)
    || value.schemaVersion !== 1
    || typeof value.handleId !== "string") {
    return undefined;
  }
  const rebuilt = createExperienceLearningPromotionHandle({
    activeBehaviorDigestAfter: value.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: value.activeBehaviorDigestBefore,
    appliedAt: value.appliedAt,
    authority: value.authority,
    candidateId: value.candidateId,
    policyAfter: value.policyAfter,
    policyBefore: value.policyBefore,
    promotionAuditId: value.promotionAuditId,
    promotionId: value.promotionId,
    threadId: value.threadId
  });
  return rebuilt?.handleId === value.handleId ? rebuilt : undefined;
}

function normalizePolicy(value: unknown): ContinuityPolicy | undefined {
  if (!isExactRecord(value, ["detail", "nextStep", "suppression", "version"])
    || (value.detail !== "standard" && value.detail !== "compact")
    || (value.nextStep !== "direct"
      && value.nextStep !== "contextual"
      && value.nextStep !== "hidden")
    || (value.suppression !== "none"
      && value.suppression !== "acknowledge-previous")
    || !Number.isSafeInteger(value.version)
    || (value.version as number) < 0) {
    return undefined;
  }
  return Object.freeze({
    detail: value.detail,
    nextStep: value.nextStep,
    suppression: value.suppression,
    version: value.version as number
  });
}

function isCanonicalIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
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
