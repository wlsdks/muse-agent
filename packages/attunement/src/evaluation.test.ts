import { describe, expect, it } from "vitest";

import { baselinePolicy, computeContinuityEvaluation, ContinuityEvaluationError, type AttunementState, type ContinuityDelivery, type PersonalThreadKind } from "./index.js";

function delivery(kind: PersonalThreadKind, index: number, day: 16 | 17): ContinuityDelivery {
  return {
    evidenceClass: "organic",
    evidenceRefs: [],
    id: `delivery_${kind}_${index.toString().padStart(2, "0")}`,
    openedAt: `2026-07-${day.toString()}T09:00:00.000Z`,
    outcome: {
      evidenceClass: "organic",
      outcome: "used",
      policyVersion: index,
      recordedAt: `2026-07-${day.toString()}T10:${index.toString().padStart(2, "0")}:00.000Z`
    },
    policyVersion: index,
    threadId: `thread_${kind}`
  };
}

function state(deliveries: readonly ContinuityDelivery[]): AttunementState {
  return {
    deliveries,
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 4,
    threads: (["life", "work"] as const).map((kind) => ({
      createdAt: "2026-07-16T00:00:00.000Z",
      id: `thread_${kind}`,
      kind,
      links: [],
      policy: baselinePolicy(),
      title: `${kind} thread`
    })),
    undoResetReceipts: []
  };
}

describe("computeContinuityEvaluation longitudinal evidence", () => {
  it("fixes the denominator to the first 20 organic deliveries and counts only organic outcome pairs", () => {
    const firstWindow = Array.from({ length: 20 }, (_, index) => ({
      ...delivery("work", index, 16),
      outcome: index < 10
        ? { ...delivery("work", index, 16).outcome!, evidenceClass: "controlled" as const }
        : undefined
    }));
    const laterOrganicPairs = Array.from({ length: 20 }, (_, index) => ({
      ...delivery("work", index + 20, 17),
      id: `delivery_later_${index.toString().padStart(2, "0")}`
    }));
    const technical = {
      ...delivery("life", 9, 17),
      evidenceClass: "controlled" as const,
      id: "delivery_controlled",
      outcome: { ...delivery("life", 9, 17).outcome!, evidenceClass: "organic" as const }
    };

    const evaluation = computeContinuityEvaluation(state([...firstWindow, ...laterOrganicPairs, technical]));

    expect(evaluation.firstPacks).toEqual({ considered: 20, rejected: 0, used: 0 });
    expect(evaluation.automationGate).toEqual({
      reasons: ["need 20 more explicit feedback entries in the first 20 before evaluating automation"],
      status: "hold"
    });
    expect(evaluation.withOutcome).toBe(20);
    expect(evaluation.longitudinalGate.byKind.work).toMatchObject({ distinctUtcDates: 1, explicitFeedback: 20 });
    expect(evaluation.technicalEvidence.overall).toMatchObject({
      deliveries: { controlled: 1, organic: 40, unclassified: 0 },
      outcomes: {
        controlled: { adjusted: 0, ignored: 0, rejected: 0, used: 10 },
        organic: { adjusted: 0, ignored: 0, rejected: 0, used: 21 },
        unclassified: { adjusted: 0, ignored: 0, rejected: 0, used: 0 }
      }
    });
  });

  it("reports empty life and work coverage without implying readiness", () => {
    const evaluation = computeContinuityEvaluation(state([]));

    expect(evaluation.longitudinalGate.status).toBe("collecting");
    expect(evaluation.longitudinalGate.byKind).toEqual({
      life: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 },
      work: { distinctUtcDates: 0, distinctUtcDatesTarget: 2, explicitFeedback: 0, explicitFeedbackTarget: 10, remainingDates: 2, remainingFeedback: 10 }
    });
  });

  it("keeps collecting until life and work each have two five-feedback cohorts across dates", () => {
    const life = Array.from({ length: 6 }, (_, index) => delivery("life", index, index < 3 ? 16 : 17));
    const work = Array.from({ length: 10 }, (_, index) => delivery("work", index, index < 5 ? 16 : 17));

    const evaluation = computeContinuityEvaluation(state([...life, ...work]));

    expect(evaluation.longitudinalGate).toEqual({
      byKind: {
        life: {
          distinctUtcDates: 2,
          distinctUtcDatesTarget: 2,
          explicitFeedback: 6,
          explicitFeedbackTarget: 10,
          remainingDates: 0,
          remainingFeedback: 4
        },
        work: {
          distinctUtcDates: 2,
          distinctUtcDatesTarget: 2,
          explicitFeedback: 10,
          explicitFeedbackTarget: 10,
          remainingDates: 0,
          remainingFeedback: 0
        }
      },
      reasons: ["life needs 4 more explicit feedback entries before a first-five/next-five comparison"],
      status: "collecting"
    });
  });

  it("holds the first-20 gate until every delivery in the window has explicit feedback", () => {
    const deliveries = Array.from({ length: 20 }, (_, index) => {
      const current = delivery("work", index, 17);
      return index < 4 ? current : { ...current, outcome: undefined };
    });

    const evaluation = computeContinuityEvaluation(state(deliveries));

    expect(evaluation.automationGate).toEqual({
      reasons: ["need 16 more explicit feedback entries in the first 20 before evaluating automation"],
      status: "hold"
    });
  });

  it("uses the delivery id to make an equal-time first-20 window independent of insertion order", () => {
    const deliveries = Array.from({ length: 21 }, (_, index) => {
      const id = `delivery_${String.fromCharCode(97 + index)}`;
      const current = delivery("work", index, 17);
      return {
        ...current,
        id,
        openedAt: "2026-07-17T09:00:00.000Z",
        outcome: { ...current.outcome!, outcome: index === 20 ? "rejected" as const : "used" as const }
      };
    }).reverse();

    const evaluation = computeContinuityEvaluation(state(deliveries));

    expect(evaluation.firstPacks).toEqual({ considered: 20, rejected: 0, used: 20 });
  });

  it("fails closed instead of ordering a feedback cohort with a malformed recorded timestamp", () => {
    const current = delivery("work", 0, 17);
    const malformed = { ...current, outcome: { ...current.outcome!, recordedAt: "not-a-timestamp" } };

    expect(() => computeContinuityEvaluation(state([malformed])))
      .toThrow(new ContinuityEvaluationError(`delivery '${malformed.id}' has an invalid recordedAt timestamp`));
  });

  it("requires human audit even after both kinds reach the numeric collection targets", () => {
    const life = Array.from({ length: 10 }, (_, index) => delivery("life", index, index < 5 ? 16 : 17));
    const work = Array.from({ length: 10 }, (_, index) => delivery("work", index, index < 5 ? 16 : 17));

    const evaluation = computeContinuityEvaluation(state([...life, ...work]));

    expect(evaluation.longitudinalGate).toMatchObject({
      reasons: ["numeric coverage is complete; human audit is still required for natural timing, distinct domains, comparability, and strict action receipts"],
      status: "audit-required"
    });
    expect(JSON.stringify(evaluation.longitudinalGate)).not.toMatch(/ready|pass|promot/iu);
  });

  it("does not count an unreviewed open on another date as longitudinal evidence", () => {
    const lifeFeedback = Array.from({ length: 10 }, (_, index) => delivery("life", index, 17));
    const pending = { ...delivery("life", 10, 17), id: "delivery_life_pending", openedAt: "2026-07-18T09:00:00.000Z", outcome: undefined };
    const work = Array.from({ length: 10 }, (_, index) => delivery("work", index, index < 5 ? 16 : 17));

    const coverage = computeContinuityEvaluation(state([...lifeFeedback, pending, ...work])).longitudinalGate.byKind.life;

    expect(coverage).toMatchObject({ distinctUtcDates: 1, explicitFeedback: 10, remainingDates: 1, remainingFeedback: 0 });
  });

  it("normalizes offset timestamps to their actual UTC date instead of slicing text", () => {
    const life = Array.from({ length: 10 }, (_, index) => ({
      ...delivery("life", index, 17),
      openedAt: index < 5 ? "2026-07-17T00:30:00+09:00" : "2026-07-16T15:30:00.000Z"
    }));
    const work = Array.from({ length: 10 }, (_, index) => delivery("work", index, index < 5 ? 16 : 17));

    const coverage = computeContinuityEvaluation(state([...life, ...work])).longitudinalGate.byKind.life;

    expect(coverage).toMatchObject({ distinctUtcDates: 1, remainingDates: 1 });
  });

  it("fails closed on a malformed opened timestamp", () => {
    const malformed = { ...delivery("life", 0, 17), openedAt: "not-a-timestamp" };

    expect(() => computeContinuityEvaluation(state([malformed])))
      .toThrow(new ContinuityEvaluationError(`delivery '${malformed.id}' has an invalid openedAt timestamp`));
  });

  it("uses delivery id to make equal-recorded-time feedback cohorts independent of insertion order", () => {
    const deliveries = Array.from({ length: 10 }, (_, index) => {
      const current = delivery("work", index, 17);
      return {
        ...current,
        id: `delivery_${String.fromCharCode(97 + index)}`,
        outcome: {
          ...current.outcome!,
          outcome: index < 5 ? "used" as const : "rejected" as const,
          recordedAt: "2026-07-17T10:00:00.000Z"
        }
      };
    }).reverse();

    const gate = computeContinuityEvaluation(state(deliveries)).byKind.work.improvementGate;

    expect(gate).toMatchObject({
      firstFiveFeedback: { rejected: 0, used: 5 },
      nextFiveFeedback: { rejected: 5, used: 0 },
      status: "regressing"
    });
  });
});
