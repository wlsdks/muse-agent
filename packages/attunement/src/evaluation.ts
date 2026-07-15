import type { AttunementState, ContinuityDelivery, ContinuityOutcome, PersonalThreadKind } from "./types.js";

export const CONTINUITY_KILL_CRITERION_FIRST_PACKS = 20;
export const CONTINUITY_IMPROVEMENT_COHORT_SIZE = 5;

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
}

function feedbackCohort(deliveries: readonly ContinuityDelivery[]): ContinuityFeedbackCohort {
  return {
    rejected: deliveries.filter((delivery) => delivery.outcome?.outcome === "rejected").length,
    used: deliveries.filter((delivery) => delivery.outcome?.outcome === "used").length
  };
}

function evaluateKind(deliveries: readonly ContinuityDelivery[]): ContinuityKindEvaluation {
  const outcomes: Record<ContinuityOutcome, number> = { adjusted: 0, ignored: 0, rejected: 0, used: 0 };
  for (const delivery of deliveries) if (delivery.outcome) outcomes[delivery.outcome.outcome] += 1;
  const firstPacks = [...deliveries].sort((left, right) => left.openedAt.localeCompare(right.openedAt)).slice(0, CONTINUITY_KILL_CRITERION_FIRST_PACKS);
  const feedback = deliveries.filter((delivery) => delivery.outcome).sort((left, right) => left.outcome!.recordedAt.localeCompare(right.outcome!.recordedAt));
  const firstFiveFeedback = feedbackCohort(feedback.slice(0, CONTINUITY_IMPROVEMENT_COHORT_SIZE));
  const nextFiveFeedback = feedbackCohort(feedback.slice(CONTINUITY_IMPROVEMENT_COHORT_SIZE, CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2));
  const improvementGate: ContinuityImprovementGate = feedback.length < CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2
    ? { firstFiveFeedback, nextFiveFeedback, reason: `need ${String(CONTINUITY_IMPROVEMENT_COHORT_SIZE * 2 - feedback.length)} more explicit feedback entries before comparing cohorts`, status: "awaiting-feedback" }
    : nextFiveFeedback.used >= firstFiveFeedback.used && nextFiveFeedback.rejected <= firstFiveFeedback.rejected
      ? { firstFiveFeedback, nextFiveFeedback, reason: nextFiveFeedback.used === firstFiveFeedback.used && nextFiveFeedback.rejected === firstFiveFeedback.rejected ? "the next five feedback outcomes are unchanged from the first five" : "the next five feedback outcomes improved without a higher rejection count", status: nextFiveFeedback.used === firstFiveFeedback.used && nextFiveFeedback.rejected === firstFiveFeedback.rejected ? "unchanged" : "improving" }
      : nextFiveFeedback.used <= firstFiveFeedback.used && nextFiveFeedback.rejected >= firstFiveFeedback.rejected
        ? { firstFiveFeedback, nextFiveFeedback, reason: "the next five feedback outcomes have lower use or higher rejection; fix pack usefulness before automation", status: "regressing" }
        : { firstFiveFeedback, nextFiveFeedback, reason: "the next five feedback outcomes trade higher use for higher rejection, or the reverse; inspect the packs before automation", status: "mixed" };
  const used = firstPacks.filter((delivery) => delivery.outcome?.outcome === "used").length;
  const rejected = firstPacks.filter((delivery) => delivery.outcome?.outcome === "rejected").length;
  const reasons: string[] = [];
  if (firstPacks.length < CONTINUITY_KILL_CRITERION_FIRST_PACKS) reasons.push(`need ${String(CONTINUITY_KILL_CRITERION_FIRST_PACKS - firstPacks.length)} more eligible deliveries before evaluating automation`);
  else {
    if (used * 100 < 20 * firstPacks.length) reasons.push("used rate is below the 20% kill criterion");
    if (rejected * 100 > 30 * firstPacks.length) reasons.push("rejection rate exceeds the 30% kill criterion");
  }
  return {
    automationGate: reasons.length > 0 ? { reasons, status: "hold" } : { reasons: ["outcome threshold passed; proactive delivery remains disabled pending the separate Slice B consent and timing gate"], status: "manual-only" },
    firstPacks: { considered: firstPacks.length, rejected, used },
    improvementGate,
    outcomes,
    totalDeliveries: deliveries.length,
    withOutcome: feedback.length
  };
}

export function computeContinuityEvaluation(state: AttunementState): ContinuityEvaluation {
  const kinds = new Map(state.threads.map((thread) => [thread.id, thread.kind]));
  const forKind = (kind: PersonalThreadKind) => state.deliveries.filter((delivery) => kinds.get(delivery.threadId) === kind);
  return { ...evaluateKind(state.deliveries), byKind: { life: evaluateKind(forKind("life")), work: evaluateKind(forKind("work")) } };
}
