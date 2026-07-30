import { describe, expect, it } from "vitest";

import { continuityOutcomeId } from "./outcome-id.js";
import {
  projectExperienceLearningSource
} from "./experience-learning-source.js";
import type { ContinuityDelivery } from "./types.js";

function delivery(evidenceClass: "controlled" | "organic" = "controlled"): ContinuityDelivery {
  const base = {
    evidenceClass,
    evidenceRefs: [],
    id: "delivery-1",
    openedAt: "2026-07-29T03:00:00.000Z",
    policyDigest: "a".repeat(64),
    policyVersion: 1,
    runId: "run-1",
    threadId: "thread-1"
  } satisfies ContinuityDelivery;
  const recordedAt = "2026-07-29T03:05:00.000Z";
  const outcome = "adjusted" as const;
  return {
    ...base,
    outcome: {
      authority: "owner-explicit",
      evidenceClass,
      id: continuityOutcomeId({
        deliveryId: base.id,
        evidenceClass,
        outcome,
        recordedAt,
        runId: base.runId
      }),
      outcome,
      policyVersion: 2,
      recordedAt
    }
  };
}

describe("projectExperienceLearningSource", () => {
  it.each([
    ["controlled", "controlled"],
    ["organic", "organic-production"]
  ] as const)("projects exact %s evidence without mutation", (inputClass, sourceClass) => {
    const input = delivery(inputClass);
    const before = JSON.stringify(input);
    const result = projectExperienceLearningSource(input);

    expect(result).toMatchObject({
      outcome: {
        authority: "owner-explicit",
        outcome: "adjusted",
        runId: "run-1"
      },
      sourceRun: {
        behaviorDigest: "a".repeat(64),
        completedAt: input.openedAt,
        evidenceClass: sourceClass,
        runId: "run-1"
      },
      status: "eligible"
    });
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "eligible") {
      expect(Object.isFrozen(result.outcome)).toBe(true);
      expect(Object.isFrozen(result.sourceRun)).toBe(true);
    }
  });

  it.each([
    ["legacy policy", { policyDigest: undefined }, "missing-policy-provenance"],
    ["missing run", { runId: undefined }, "missing-run-id"],
    ["missing outcome", { outcome: undefined }, "missing-explicit-outcome"],
    ["unclassified delivery", { evidenceClass: "unclassified" }, "unclassified-evidence"],
    ["mixed evidence", {
      evidenceClass: "organic",
      outcome: { ...delivery().outcome!, evidenceClass: "controlled" }
    }, "evidence-class-mismatch"],
    ["outcome before run", {
      outcome: {
        ...delivery().outcome!,
        recordedAt: "2026-07-29T02:59:59.000Z"
      }
    }, "invalid-temporal-order"]
  ] as const)("holds %s", (_label, patch, reason) => {
    expect(projectExperienceLearningSource({
      ...delivery(),
      ...patch
    } as ContinuityDelivery)).toEqual({ reason, status: "held" });
  });

  it("holds a fully shaped but tampered owner outcome receipt", () => {
    const input = delivery();
    expect(projectExperienceLearningSource({
      ...input,
      outcome: { ...input.outcome!, id: `continuity_outcome_${"f".repeat(64)}` }
    })).toEqual({
      reason: "missing-explicit-outcome",
      status: "held"
    });
  });

  it.each([
    ["unknown evidence class", "synthetic", "adjusted"],
    ["unknown outcome", "controlled", "model-approved"]
  ] as const)("holds an exact-ID forgery with %s", (_label, evidenceClass, outcome) => {
    const input = delivery();
    const forged = {
      ...input,
      evidenceClass,
      outcome: {
        ...input.outcome!,
        evidenceClass,
        id: continuityOutcomeId({
          deliveryId: input.id,
          evidenceClass: evidenceClass as never,
          outcome: outcome as never,
          recordedAt: input.outcome!.recordedAt,
          runId: input.runId
        }),
        outcome
      }
    } as unknown as ContinuityDelivery;

    expect(projectExperienceLearningSource(forged)).toEqual({
      reason: "invalid-input",
      status: "held"
    });
  });
});
