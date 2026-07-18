import type {
  AttunementState,
  ContinuityDelivery,
  ContinuityEvidenceClass,
  ContinuityOutcome,
  PersonalThreadKind
} from "./types.js";

export const CONTINUITY_KILL_CRITERION_FIRST_PACKS = 20;
export const CONTINUITY_IMPROVEMENT_COHORT_SIZE = 5;
export const CONTINUITY_LONGITUDINAL_FEEDBACK_PER_KIND = CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2;
export const CONTINUITY_LONGITUDINAL_DISTINCT_DATES_PER_KIND = 2;

export class ContinuityEvaluationError extends Error {
  override readonly name = "ContinuityEvaluationError";
}

export interface ContinuityFeedbackCohort {
  readonly rejected: number;
  readonly used: number;
}

export interface ContinuityImprovementGate {
  readonly firstFiveFeedback: ContinuityFeedbackCohort;
  readonly nextFiveFeedback: ContinuityFeedbackCohort;
  readonly reason: string;
  readonly status: "awaiting-feedback" | "improving" | "mixed" | "regressing" | "unchanged";
}

export interface ContinuityKindEvaluation {
  readonly automationGate: { readonly reasons: readonly string[]; readonly status: "hold" | "manual-only" };
  readonly firstPacks: { readonly considered: number; readonly rejected: number; readonly used: number };
  readonly improvementGate: ContinuityImprovementGate;
  readonly outcomes: Record<ContinuityOutcome, number>;
  readonly totalDeliveries: number;
  readonly withOutcome: number;
}

export interface ContinuityEvaluation extends ContinuityKindEvaluation {
  /** Consumers must render this split rather than treating aggregate results as success. */
  readonly byKind: Readonly<Record<PersonalThreadKind, ContinuityKindEvaluation>>;
  readonly longitudinalGate: ContinuityLongitudinalGate;
  readonly schemaVersion: 2;
  readonly technicalEvidence: ContinuityTechnicalEvidenceDigest;
}

export interface ContinuityTechnicalEvidenceSlice {
  readonly deliveries: Readonly<Record<ContinuityEvidenceClass, number>>;
  readonly outcomes: Readonly<Record<ContinuityEvidenceClass, Readonly<Record<ContinuityOutcome, number>>>>;
}

export interface ContinuityTechnicalEvidenceDigest {
  readonly byKind: Readonly<Record<PersonalThreadKind, ContinuityTechnicalEvidenceSlice>>;
  readonly overall: ContinuityTechnicalEvidenceSlice;
}

export interface ContinuityLongitudinalKindCoverage {
  readonly distinctUtcDates: number;
  readonly distinctUtcDatesTarget: number;
  readonly explicitFeedback: number;
  readonly explicitFeedbackTarget: number;
  readonly remainingDates: number;
  readonly remainingFeedback: number;
}

export interface ContinuityLongitudinalGate {
  readonly byKind: Readonly<Record<PersonalThreadKind, ContinuityLongitudinalKindCoverage>>;
  readonly reasons: readonly string[];
  readonly status: "audit-required" | "collecting";
}

function timestampMs(value: string, field: "openedAt" | "recordedAt", deliveryId: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ContinuityEvaluationError(`delivery '${deliveryId}' has an invalid ${field} timestamp`);
  return parsed;
}

function utcOpenedDate(delivery: ContinuityDelivery): string {
  return new Date(timestampMs(delivery.openedAt, "openedAt", delivery.id)).toISOString().slice(0, 10);
}

/** Package-internal canonical delivery order shared by evaluation and review. */
export function orderContinuityDeliveries(deliveries: readonly ContinuityDelivery[]): readonly ContinuityDelivery[] {
  return deliveries
    .map((delivery) => ({ delivery, openedAtMs: timestampMs(delivery.openedAt, "openedAt", delivery.id) }))
    .sort((left, right) => left.openedAtMs - right.openedAtMs || left.delivery.id.localeCompare(right.delivery.id))
    .map(({ delivery }) => delivery);
}

function orderContinuityFeedback(deliveries: readonly ContinuityDelivery[]): readonly ContinuityDelivery[] {
  return deliveries
    .filter((delivery) => delivery.outcome !== undefined)
    .map((delivery) => ({
      delivery,
      recordedAtMs: timestampMs(delivery.outcome!.recordedAt, "recordedAt", delivery.id)
    }))
    .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.delivery.id.localeCompare(right.delivery.id))
    .map(({ delivery }) => delivery);
}

function longitudinalCoverage(deliveries: readonly ContinuityDelivery[]): ContinuityLongitudinalKindCoverage {
  const feedback = deliveries.filter(isOrganicOutcomePair);
  const distinctUtcDates = new Set(feedback.map(utcOpenedDate)).size;
  return {
    distinctUtcDates,
    distinctUtcDatesTarget: CONTINUITY_LONGITUDINAL_DISTINCT_DATES_PER_KIND,
    explicitFeedback: feedback.length,
    explicitFeedbackTarget: CONTINUITY_LONGITUDINAL_FEEDBACK_PER_KIND,
    remainingDates: Math.max(0, CONTINUITY_LONGITUDINAL_DISTINCT_DATES_PER_KIND - distinctUtcDates),
    remainingFeedback: Math.max(0, CONTINUITY_LONGITUDINAL_FEEDBACK_PER_KIND - feedback.length)
  };
}

function longitudinalGate(byKind: Readonly<Record<PersonalThreadKind, readonly ContinuityDelivery[]>>): ContinuityLongitudinalGate {
  const coverage = { life: longitudinalCoverage(byKind.life), work: longitudinalCoverage(byKind.work) };
  const reasons: string[] = [];
  for (const kind of ["life", "work"] as const) {
    const current = coverage[kind];
    if (current.remainingFeedback > 0) reasons.push(`${kind} needs ${String(current.remainingFeedback)} more explicit feedback entries before a first-five/next-five comparison`);
    if (current.remainingDates > 0) reasons.push(`${kind} needs ${String(current.remainingDates)} more UTC opened ${current.remainingDates === 1 ? "date" : "dates"} with explicit feedback`);
  }
  return reasons.length > 0
    ? { byKind: coverage, reasons, status: "collecting" }
    : {
        byKind: coverage,
        reasons: ["numeric coverage is complete; human audit is still required for natural timing, distinct domains, comparability, and strict action receipts"],
        status: "audit-required"
      };
}

function feedbackCohort(deliveries: readonly ContinuityDelivery[]): ContinuityFeedbackCohort {
  return {
    rejected: deliveries.filter((delivery) => delivery.outcome?.outcome === "rejected").length,
    used: deliveries.filter((delivery) => delivery.outcome?.outcome === "used").length
  };
}

function evaluateKind(deliveries: readonly ContinuityDelivery[]): ContinuityKindEvaluation {
  const organicDeliveries = deliveries.filter((delivery) => delivery.evidenceClass === "organic");
  const outcomes: Record<ContinuityOutcome, number> = { adjusted: 0, ignored: 0, rejected: 0, used: 0 };
  const feedback = orderContinuityFeedback(deliveries.filter(isOrganicOutcomePair));
  for (const delivery of feedback) outcomes[delivery.outcome!.outcome] += 1;
  const firstPacks = orderContinuityDeliveries(organicDeliveries).slice(0, CONTINUITY_KILL_CRITERION_FIRST_PACKS);
  const firstFiveFeedback = feedbackCohort(feedback.slice(0, CONTINUITY_IMPROVEMENT_COHORT_SIZE));
  const nextFiveFeedback = feedbackCohort(feedback.slice(CONTINUITY_IMPROVEMENT_COHORT_SIZE, CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2));
  const improvementGate: ContinuityImprovementGate = feedback.length < CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2
    ? { firstFiveFeedback, nextFiveFeedback, reason: `need ${String(CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2 - feedback.length)} more explicit feedback entries before comparing cohorts`, status: "awaiting-feedback" }
    : nextFiveFeedback.used >= firstFiveFeedback.used && nextFiveFeedback.rejected <= firstFiveFeedback.rejected
      ? { firstFiveFeedback, nextFiveFeedback, reason: nextFiveFeedback.used === firstFiveFeedback.used && nextFiveFeedback.rejected === firstFiveFeedback.rejected ? "the next five feedback outcomes are unchanged from the first five" : "the next five feedback outcomes improved without a higher rejection count", status: nextFiveFeedback.used === firstFiveFeedback.used && nextFiveFeedback.rejected === firstFiveFeedback.rejected ? "unchanged" : "improving" }
      : nextFiveFeedback.used <= firstFiveFeedback.used && nextFiveFeedback.rejected >= firstFiveFeedback.rejected
        ? { firstFiveFeedback, nextFiveFeedback, reason: "the next five feedback outcomes have lower use or higher rejection; fix pack usefulness before automation", status: "regressing" }
        : { firstFiveFeedback, nextFiveFeedback, reason: "the next five feedback outcomes trade higher use for higher rejection, or the reverse; inspect the packs before automation", status: "mixed" };
  const used = firstPacks.filter((delivery) => isOrganicOutcomePair(delivery) && delivery.outcome.outcome === "used").length;
  const rejected = firstPacks.filter((delivery) => isOrganicOutcomePair(delivery) && delivery.outcome.outcome === "rejected").length;
  const firstPacksWithFeedback = firstPacks.filter(isOrganicOutcomePair).length;
  const reasons: string[] = [];
  if (firstPacks.length < CONTINUITY_KILL_CRITERION_FIRST_PACKS) reasons.push(`need ${String(CONTINUITY_KILL_CRITERION_FIRST_PACKS - firstPacks.length)} more eligible deliveries before evaluating automation`);
  else if (firstPacksWithFeedback < CONTINUITY_KILL_CRITERION_FIRST_PACKS) reasons.push(`need ${String(CONTINUITY_KILL_CRITERION_FIRST_PACKS - firstPacksWithFeedback)} more explicit feedback entries in the first 20 before evaluating automation`);
  else {
    if (used * 100 < 20 * firstPacks.length) reasons.push("used rate is below the 20% kill criterion");
    if (rejected * 100 > 30 * firstPacks.length) reasons.push("rejection rate exceeds the 30% kill criterion");
  }
  return {
    automationGate: reasons.length > 0 ? { reasons, status: "hold" } : { reasons: ["outcome threshold passed; proactive delivery remains disabled pending the separate Slice B consent and timing gate"], status: "manual-only" },
    firstPacks: { considered: firstPacks.length, rejected, used },
    improvementGate,
    outcomes,
    totalDeliveries: organicDeliveries.length,
    withOutcome: feedback.length
  };
}

export function computeContinuityEvaluation(state: AttunementState): ContinuityEvaluation {
  const kinds = new Map(state.threads.map((thread) => [thread.id, thread.kind]));
  const forKind = (kind: PersonalThreadKind) => state.deliveries.filter((delivery) => kinds.get(delivery.threadId) === kind);
  const byKindDeliveries = { life: forKind("life"), work: forKind("work") };
  return {
    ...evaluateKind(state.deliveries),
    byKind: { life: evaluateKind(byKindDeliveries.life), work: evaluateKind(byKindDeliveries.work) },
    longitudinalGate: longitudinalGate(byKindDeliveries),
    schemaVersion: 2,
    technicalEvidence: {
      byKind: {
        life: technicalEvidenceSlice(byKindDeliveries.life),
        work: technicalEvidenceSlice(byKindDeliveries.work)
      },
      overall: technicalEvidenceSlice(state.deliveries)
    }
  };
}

function isOrganicOutcomePair(delivery: ContinuityDelivery): delivery is ContinuityDelivery & {
  readonly outcome: NonNullable<ContinuityDelivery["outcome"]>;
} {
  return delivery.evidenceClass === "organic" && delivery.outcome?.evidenceClass === "organic";
}

function technicalEvidenceSlice(deliveries: readonly ContinuityDelivery[]): ContinuityTechnicalEvidenceSlice {
  const classes: readonly ContinuityEvidenceClass[] = ["organic", "controlled", "unclassified"];
  const emptyOutcomes = (): Record<ContinuityOutcome, number> => ({ adjusted: 0, ignored: 0, rejected: 0, used: 0 });
  const deliveryCounts: Record<ContinuityEvidenceClass, number> = { controlled: 0, organic: 0, unclassified: 0 };
  const outcomeCounts: Record<ContinuityEvidenceClass, Record<ContinuityOutcome, number>> = {
    controlled: emptyOutcomes(),
    organic: emptyOutcomes(),
    unclassified: emptyOutcomes()
  };
  for (const delivery of deliveries) {
    deliveryCounts[delivery.evidenceClass] += 1;
    if (delivery.outcome) outcomeCounts[delivery.outcome.evidenceClass][delivery.outcome.outcome] += 1;
  }
  return {
    deliveries: Object.fromEntries(classes.map((value) => [value, deliveryCounts[value]])) as Record<ContinuityEvidenceClass, number>,
    outcomes: Object.fromEntries(classes.map((value) => [value, outcomeCounts[value]])) as Record<ContinuityEvidenceClass, Record<ContinuityOutcome, number>>
  };
}
