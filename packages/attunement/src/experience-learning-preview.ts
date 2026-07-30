import { sha256Hex } from "@muse/shared";

import {
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate
} from "./experience-learning-candidate.js";

export interface ExperienceLearningProposalPreview {
  readonly activeBehaviorDigestAfter: string;
  readonly activeBehaviorDigestBefore: string;
  readonly boundary: {
    readonly actionScope: "not-expanded";
    readonly activation: "none";
    readonly permission: "unchanged";
    readonly recipient: "unchanged";
    readonly source: "unchanged";
  };
  readonly candidateId: string;
  readonly evidence: {
    readonly outcome: ExperienceLearningCandidate["outcome"];
    readonly sourceRun: ExperienceLearningCandidate["sourceRun"];
  };
  readonly expectedBenefit: string;
  readonly expiresAt: string;
  readonly experienceId: string;
  readonly previewId: string;
  readonly proposedAt: string;
  readonly proposedBehavior: string;
  readonly proposedChange: ExperienceLearningCandidate["proposedChange"];
  readonly schemaVersion: 1;
  readonly scope: ExperienceLearningCandidate["scope"];
}

/**
 * Creates a display-only, content-bound owner review receipt. It exposes no
 * approval, write-gate, policy registry, or effect callback.
 */
export function buildExperienceLearningProposalPreview(
  candidate: ExperienceLearningCandidate
): ExperienceLearningProposalPreview | undefined {
  try {
    return buildValidatedPreview(candidate);
  } catch {
    return undefined;
  }
}

function buildValidatedPreview(
  candidate: ExperienceLearningCandidate
): ExperienceLearningProposalPreview | undefined {
  if (!hasExactDataFields(candidate, [
    "activeBehaviorDigestAfter",
    "activeBehaviorDigestBefore",
    "activation",
    "candidateId",
    "expectedBenefit",
    "expiresAt",
    "experienceId",
    "outcome",
    "pipeline",
    "proposedAt",
    "proposedBehavior",
    "proposedChange",
    "scope",
    "sourceRun",
    "status"
  ])
    || !hasExactDataFields(candidate.outcome, [
      "authority",
      "outcome",
      "outcomeId",
      "recordedAt",
      "runId"
    ])
    || !hasExactDataFields(candidate.sourceRun, [
      "behaviorDigest",
      "completedAt",
      "evidenceClass",
      "runId"
    ])
    || !hasExactDataFields(candidate.scope, ["kind", "threadId"])
    || !hasExactLearningChange(candidate.proposedChange)) {
    return undefined;
  }
  const rebuilt = proposeExperienceLearningCandidate({
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
  if (!rebuilt
    || rebuilt.candidateId !== candidate.candidateId
    || candidate.activeBehaviorDigestAfter !== candidate.activeBehaviorDigestBefore
    || candidate.activation !== "none"
    || candidate.pipeline !== "collaboration-policy"
    || candidate.status !== "proposed") {
    return undefined;
  }
  const core = {
    activeBehaviorDigestAfter: candidate.activeBehaviorDigestAfter,
    activeBehaviorDigestBefore: candidate.activeBehaviorDigestBefore,
    boundary: Object.freeze({
      actionScope: "not-expanded" as const,
      activation: "none" as const,
      permission: "unchanged" as const,
      recipient: "unchanged" as const,
      source: "unchanged" as const
    }),
    candidateId: candidate.candidateId,
    evidence: Object.freeze({
      outcome: Object.freeze({ ...candidate.outcome }),
      sourceRun: Object.freeze({ ...candidate.sourceRun })
    }),
    expectedBenefit: candidate.expectedBenefit,
    expiresAt: candidate.expiresAt,
    experienceId: candidate.experienceId,
    proposedAt: candidate.proposedAt,
    proposedBehavior: candidate.proposedBehavior,
    proposedChange: Object.freeze({ ...candidate.proposedChange }) as ExperienceLearningCandidate["proposedChange"],
    schemaVersion: 1 as const,
    scope: Object.freeze({ ...candidate.scope })
  };
  const previewId = `learning_preview_${sha256Hex(JSON.stringify(core))}`;
  return Object.freeze({ ...core, previewId });
}

function hasExactLearningChange(
  value: ExperienceLearningCandidate["proposedChange"]
): boolean {
  if (value.kind === "thread-display") {
    return hasExactDataFields(value, ["detail", "kind", "nextStep"]);
  }
  if (value.kind === "thread-suppression") {
    return hasExactDataFields(value, ["kind", "suppression"]);
  }
  return value.kind === "thread-timing"
    && hasExactDataFields(value, ["adjustment", "kind"]);
}

function hasExactDataFields(value: object, fields: readonly string[]): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
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
      && descriptor.set === undefined;
  });
}
