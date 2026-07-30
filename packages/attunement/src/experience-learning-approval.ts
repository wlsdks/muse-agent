import { sha256Hex } from "@muse/shared";

import type { ExperienceLearningProposalPreview } from "./experience-learning-preview.js";
import type { ExperienceLearningReplayBundle } from "./experience-learning-replay-evidence.js";
import { EXPERIENCE_LEARNING_PROMOTION_MIN_CASES } from "./experience-learning-promotion.js";

export interface ExperienceLearningApprovalReceipt {
  readonly activeBehaviorDigestBefore: string;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly authority: "owner-explicit";
  readonly candidateId: string;
  readonly expiresAt: string;
  readonly previewId: string;
  readonly replayBundleId: string;
  readonly replayInputHash: string;
  readonly schemaVersion: 1;
}

export function createExperienceLearningApprovalReceipt(
  preview: ExperienceLearningProposalPreview,
  replayBundle: ExperienceLearningReplayBundle,
  approvedAt: string
): ExperienceLearningApprovalReceipt | undefined {
  if (!hasValidPreviewId(preview)
    || !hasValidReplayBundleId(replayBundle)
    || !isCanonicalIso(approvedAt)
    || replayBundle.candidateId !== preview.candidateId
    || replayBundle.replay.candidateId !== preview.candidateId
    || replayBundle.replay.recommendation !== "eligible-for-review"
    || replayBundle.replay.aggregate.total < EXPERIENCE_LEARNING_PROMOTION_MIN_CASES
    || Date.parse(approvedAt) < Date.parse(preview.proposedAt)
    || Date.parse(approvedAt) >= Date.parse(preview.expiresAt)) {
    return undefined;
  }
  const core = {
    activeBehaviorDigestBefore: preview.activeBehaviorDigestBefore,
    approvedAt,
    authority: "owner-explicit" as const,
    candidateId: preview.candidateId,
    expiresAt: preview.expiresAt,
    previewId: preview.previewId,
    replayBundleId: replayBundle.bundleId,
    replayInputHash: replayBundle.replay.inputHash,
    schemaVersion: 1 as const
  };
  return Object.freeze({
    ...core,
    approvalId: `learning_approval_${sha256Hex(JSON.stringify(core))}`
  });
}

function hasValidPreviewId(preview: ExperienceLearningProposalPreview): boolean {
  if (!isExactDataRecord(preview, [
    "activeBehaviorDigestAfter",
    "activeBehaviorDigestBefore",
    "boundary",
    "candidateId",
    "evidence",
    "expectedBenefit",
    "expiresAt",
    "experienceId",
    "previewId",
    "proposedAt",
    "proposedBehavior",
    "proposedChange",
    "schemaVersion",
    "scope"
  ]) || !isDeepPlainData(preview)) return false;
  const core = {
    activeBehaviorDigestAfter: preview.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: preview.activeBehaviorDigestBefore,
    boundary: preview.boundary,
    candidateId: preview.candidateId,
    evidence: preview.evidence,
    expectedBenefit: preview.expectedBenefit,
    expiresAt: preview.expiresAt,
    experienceId: preview.experienceId,
    proposedAt: preview.proposedAt,
    proposedBehavior: preview.proposedBehavior,
    proposedChange: preview.proposedChange,
    schemaVersion: preview.schemaVersion,
    scope: preview.scope
  };
  return preview.previewId === `learning_preview_${sha256Hex(JSON.stringify(core))}`;
}

function hasValidReplayBundleId(
  replayBundle: ExperienceLearningReplayBundle
): boolean {
  if (!isExactDataRecord(replayBundle, [
    "bundleId",
    "candidateId",
    "cases",
    "replay",
    "schemaVersion",
    "status"
  ]) || !isDeepPlainData(replayBundle)) return false;
  const core = {
    candidateId: replayBundle.candidateId,
    cases: replayBundle.cases,
    replay: replayBundle.replay,
    schemaVersion: replayBundle.schemaVersion,
    status: replayBundle.status
  };
  return replayBundle.bundleId === sha256Hex(JSON.stringify(core));
}

export function verifyExperienceLearningApprovalReceipt(
  value: unknown,
  preview: ExperienceLearningProposalPreview,
  replayBundle: ExperienceLearningReplayBundle,
  appliedAt: string
): ExperienceLearningApprovalReceipt | undefined {
  if (!isExactDataRecord(value, [
    "activeBehaviorDigestBefore",
    "approvalId",
    "approvedAt",
    "authority",
    "candidateId",
    "expiresAt",
    "previewId",
    "replayBundleId",
    "replayInputHash",
    "schemaVersion"
  ])
    || typeof value.approvedAt !== "string"
    || !isCanonicalIso(appliedAt)
    || Date.parse(appliedAt) < Date.parse(value.approvedAt)
    || Date.parse(appliedAt) >= Date.parse(preview.expiresAt)) {
    return undefined;
  }
  const rebuilt = createExperienceLearningApprovalReceipt(
    preview,
    replayBundle,
    value.approvedAt
  );
  if (!rebuilt) return undefined;
  return Object.keys(rebuilt).every((key) =>
    value[key] === rebuilt[key as keyof ExperienceLearningApprovalReceipt]
  ) ? rebuilt : undefined;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isExactDataRecord(
  value: unknown,
  fields: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    return false;
  }
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.enumerable === true;
  });
}

function isDeepPlainData(value: unknown): boolean {
  if (value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) {
    return true;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_unused, index) => String(index)),
      "length"
    ];
    const keys = Reflect.ownKeys(value);
    return keys.length === expectedKeys.length
      && keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
      && expectedKeys.slice(0, -1).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && Object.hasOwn(descriptor, "value")
          && descriptor.get === undefined
          && descriptor.set === undefined
          && descriptor.enumerable === true
          && isDeepPlainData(descriptor.value);
      });
  }
  if (typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.enumerable === true
      && isDeepPlainData(descriptor.value);
  });
}
