import { continuityOutcomeId } from "./outcome-id.js";
import { CONTINUITY_EVIDENCE_CLASSES } from "./evidence-provenance.js";
import type {
  ExperienceSourceRun,
  ExperienceSourceRunClass,
  ExplicitExperienceOutcome
} from "./experience-learning-candidate.js";
import { OUTCOMES, type ContinuityDelivery } from "./types.js";

export type ExperienceLearningSourceHeldReason =
  | "evidence-class-mismatch"
  | "invalid-input"
  | "invalid-temporal-order"
  | "missing-explicit-outcome"
  | "missing-policy-provenance"
  | "missing-run-id"
  | "unclassified-evidence";

export type ExperienceLearningSourceProjection =
  | Readonly<{
      outcome: ExplicitExperienceOutcome;
      sourceRun: ExperienceSourceRun;
      status: "eligible";
    }>
  | Readonly<{
      reason: ExperienceLearningSourceHeldReason;
      status: "held";
    }>;

/**
 * Converts one persisted delivery into candidate evidence only when the exact
 * policy, run, explicit owner outcome, evidence class, and time order all
 * agree. It is a read-only authority gate; it never proposes or promotes.
 */
export function projectExperienceLearningSource(
  delivery: ContinuityDelivery
): ExperienceLearningSourceProjection {
  if (!isBoundedText(delivery.id)
    || !isIso(delivery.openedAt)) {
    return held("invalid-input");
  }
  if (!CONTINUITY_EVIDENCE_CLASSES.includes(delivery.evidenceClass)
    || (delivery.outcome
      && (!CONTINUITY_EVIDENCE_CLASSES.includes(delivery.outcome.evidenceClass)
        || !OUTCOMES.includes(delivery.outcome.outcome)))) {
    return held("invalid-input");
  }
  if (!isDigest(delivery.policyDigest)) return held("missing-policy-provenance");
  if (!isBoundedText(delivery.runId)) return held("missing-run-id");
  const outcome = delivery.outcome;
  if (!outcome
    || outcome.authority !== "owner-explicit"
    || !isBoundedText(outcome.id)) {
    return held("missing-explicit-outcome");
  }
  if (!isIso(outcome.recordedAt)
    || Date.parse(outcome.recordedAt) < Date.parse(delivery.openedAt)) {
    return held("invalid-temporal-order");
  }
  if (delivery.evidenceClass === "unclassified"
    || outcome.evidenceClass === "unclassified") {
    return held("unclassified-evidence");
  }
  if (delivery.evidenceClass !== outcome.evidenceClass) {
    return held("evidence-class-mismatch");
  }
  const expectedOutcomeId = continuityOutcomeId({
    deliveryId: delivery.id,
    evidenceClass: outcome.evidenceClass,
    outcome: outcome.outcome,
    ...(outcome.ownerNote ? { ownerNote: outcome.ownerNote } : {}),
    recordedAt: outcome.recordedAt,
    runId: delivery.runId
  });
  if (outcome.id !== expectedOutcomeId) return held("missing-explicit-outcome");

  const evidenceClass: ExperienceSourceRunClass = delivery.evidenceClass === "organic"
    ? "organic-production"
    : "controlled";
  return Object.freeze({
    outcome: Object.freeze({
      authority: "owner-explicit" as const,
      outcome: outcome.outcome,
      outcomeId: outcome.id,
      recordedAt: outcome.recordedAt,
      runId: delivery.runId
    }),
    sourceRun: Object.freeze({
      behaviorDigest: delivery.policyDigest,
      completedAt: delivery.openedAt,
      evidenceClass,
      runId: delivery.runId
    }),
    status: "eligible" as const
  });
}

function held(reason: ExperienceLearningSourceHeldReason): ExperienceLearningSourceProjection {
  return Object.freeze({ reason, status: "held" as const });
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 160
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
