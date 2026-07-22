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
    schemaVersion: 11,
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
  const now = { now: () => Date.parse("2026-07-22T00:00:00.000Z") };

  it("emits personal metrics only for a complete first-20 organic pair window", () => {
    const complete = Array.from({ length: 20 }, (_, index) => delivery("work", index, index < 10 ? 16 : 17));
    const evaluation = computeContinuityEvaluation(state(complete), now);
    const personal = evaluation.byKind.work.measurements.filter((metric) => metric.claim === "personal-effectiveness");

    expect(evaluation.schemaVersion).toBe(3);
    expect(evaluation.byKind.work.measurementStatus).toBe("available");
    expect(personal.map((metric) => metric.id)).toEqual([
      "continuity.first-20.used.work",
      "continuity.first-20.rejected.work"
    ]);
    expect(personal[0]?.value).toEqual({ denominator: 20, numerator: 20, unit: "ratio" });
    expect(personal[0]?.freshness).toMatchObject({ evaluatedAt: "2026-07-22T00:00:00.000Z", status: "fresh" });
  });

  it("never turns controlled, unclassified, mixed, missing-feedback, or factual receipts into personal claims", () => {
    const organic = Array.from({ length: 20 }, (_, index) => delivery("work", index, 17));
    const controlled = organic.map((item) => ({ ...item, evidenceClass: "controlled" as const }));
    const unclassified = organic.map((item) => ({ ...item, evidenceClass: "unclassified" as const }));
    const mixed = organic.map((item, index) => index === 19
      ? { ...item, outcome: { ...item.outcome!, evidenceClass: "controlled" as const } }
      : item);
    const missing = organic.map((item, index) => index === 19 ? { ...item, outcome: undefined } : item);
    const receipt = {
      artifactId: "task_1", completedAt: "2026-07-17T12:00:00.000Z", deliveryId: "delivery_work_00",
      doneStateFingerprint: "done", eventId: "event_1", evidenceClass: "organic" as const, id: "receipt_1",
      linkedAt: "2026-07-17T08:00:00.000Z", openStateFingerprint: "open", providerId: "local" as const,
      recordedAt: "2026-07-17T12:00:00.000Z", role: "next-step" as const, runId: "run_1",
      threadId: "thread_work", transition: "open-to-done" as const
    };
    const personal = (deliveries: readonly ContinuityDelivery[], withReceipt = false) => computeContinuityEvaluation({
      ...state(deliveries),
      interactionReceipts: withReceipt ? [receipt] : []
    }, now).measurements.filter((metric) => metric.claim !== "technical-diagnostic");

    expect(personal(controlled)).toEqual([]);
    expect(personal(unclassified)).toEqual([]);
    expect(personal(mixed)).toEqual([]);
    expect(personal(missing)).toEqual([]);
    expect(personal([], true)).toEqual([]);
  });

  it.each(["controlled", "unclassified"] as const)("fails closed on malformed %s technical timestamps", (evidenceClass) => {
    const current = delivery("work", 0, 17);
    const malformedOpened = { ...current, evidenceClass, openedAt: "not-a-timestamp" };
    const malformedOutcome = {
      ...current,
      outcome: { ...current.outcome!, evidenceClass, recordedAt: "not-a-timestamp" }
    };

    expect(() => computeContinuityEvaluation(state([malformedOpened]), now))
      .toThrow(new ContinuityEvaluationError(`delivery '${malformedOpened.id}' has an invalid openedAt timestamp`));
    expect(() => computeContinuityEvaluation(state([malformedOutcome]), now))
      .toThrow(new ContinuityEvaluationError(`delivery '${malformedOutcome.id}' has an invalid recordedAt timestamp`));
  });

  it.each(["controlled", "unclassified"] as const)("emits the exact technical metric list and denominators for %s-only delivery provenance", (evidenceClass) => {
    const current = { ...delivery("work", 0, 17), evidenceClass };
    const evaluation = computeContinuityEvaluation(state([current]), now);

    expect(evaluation.measurements.map((metric) => metric.id)).toEqual([
      "continuity.technical.delivery.organic.overall",
      "continuity.technical.delivery.controlled.overall",
      "continuity.technical.delivery.unclassified.overall",
      "continuity.technical.outcome.organic.overall",
      "continuity.technical.outcome.controlled.overall",
      "continuity.technical.outcome.unclassified.overall"
    ]);
    expect(evaluation.measurements.find((metric) => metric.id === `continuity.technical.delivery.${evidenceClass}.overall`)?.value)
      .toEqual({ denominator: 1, numerator: 1, unit: "count-of-total" });
    expect(evaluation.measurements.find((metric) => metric.id === "continuity.technical.outcome.organic.overall")?.value)
      .toEqual({ denominator: 1, numerator: 1, unit: "count-of-total" });
    expect(evaluation.measurements.filter((metric) => metric.claim !== "technical-diagnostic")).toEqual([]);
  });

  it("keeps a mixed outcome technical and a factual-receipt-only state measurement-empty", () => {
    const current = delivery("work", 0, 17);
    const mixed = { ...current, outcome: { ...current.outcome!, evidenceClass: "controlled" as const } };
    const mixedEvaluation = computeContinuityEvaluation(state([mixed]), now);
    const receiptOnly = state([]);
    const receipt = {
      artifactId: "task_1", completedAt: "2026-07-17T12:00:00.000Z", deliveryId: current.id,
      doneStateFingerprint: "done", eventId: "event_1", evidenceClass: "organic" as const, id: "receipt_1",
      linkedAt: "2026-07-17T08:00:00.000Z", openStateFingerprint: "open", providerId: "local" as const,
      recordedAt: "2026-07-17T12:00:00.000Z", role: "next-step" as const, runId: "run_1",
      threadId: "thread_work", transition: "open-to-done" as const
    };

    expect(mixedEvaluation.measurements.find((metric) => metric.id === "continuity.technical.outcome.controlled.overall")?.value)
      .toEqual({ denominator: 1, numerator: 1, unit: "count-of-total" });
    expect(mixedEvaluation.measurements.filter((metric) => metric.claim !== "technical-diagnostic")).toEqual([]);
    expect(computeContinuityEvaluation({ ...receiptOnly, interactionReceipts: [receipt] }, now).measurements).toEqual([]);
  });

  it("marks the Attunement 30-day freshness boundary exactly", () => {
    const current = { ...delivery("work", 0, 17), evidenceClass: "controlled" as const, outcome: undefined };
    const asOf = Date.parse(current.openedAt);
    const metricAt = (nowMs: number) => computeContinuityEvaluation(state([current]), { now: () => nowMs }).measurements
      .find((metric) => metric.id === "continuity.technical.delivery.controlled.overall");

    expect(metricAt(asOf + 2_592_000_000)?.freshness.status).toBe("fresh");
    expect(metricAt(asOf + 2_592_000_001)?.freshness.status).toBe("stale");
  });
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
