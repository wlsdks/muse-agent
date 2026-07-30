import { describe, expect, it } from "vitest";

import {
  buildExperienceLearningReplayBundle,
  createExperienceReplayEvidenceReceipt,
  parseExperienceReplayEvidenceCases,
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate
} from "./index.js";

const digest = (character: string) => character.repeat(64);

function candidate(): ExperienceLearningCandidate {
  return proposeExperienceLearningCandidate({
    activeBehaviorDigest: digest("a"),
    expectedBenefit: "Reduce interruptions.",
    expiresAt: "2026-08-01T00:00:00.000Z",
    experienceId: "experience-1",
    outcome: {
      authority: "owner-explicit",
      outcome: "rejected",
      outcomeId: "outcome-1",
      recordedAt: "2026-07-29T03:05:00.000Z",
      runId: "run-1"
    },
    proposedAt: "2026-07-29T03:06:00.000Z",
    proposedBehavior: "Offer only during an explicit review window.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: { kind: "thread-timing", threadId: "thread-1" },
    sourceRun: {
      behaviorDigest: digest("b"),
      completedAt: "2026-07-29T03:00:00.000Z",
      evidenceClass: "controlled",
      runId: "run-1"
    }
  })!;
}

function receipt(caseId: string, variant: "baseline" | "challenger", passed: boolean) {
  return createExperienceReplayEvidenceReceipt({
    caseId,
    evaluator: { id: "continuity-terminal-grader", version: "1.2.0" },
    inputHash: digest("f"),
    observedAt: "2026-07-29T04:00:00.000Z",
    passed,
    variant
  })!;
}

function evidenceCase(caseId = "case-1") {
  return {
    baseline: receipt(caseId, "baseline", false),
    caseId,
    challenger: receipt(caseId, "challenger", true)
  };
}

describe("experience replay evidence", () => {
  it("content-binds evaluator, frozen input, observation time, and result", () => {
    const original = receipt("case-1", "baseline", false);
    const same = receipt("case-1", "baseline", false);
    const drifted = createExperienceReplayEvidenceReceipt({
      caseId: "case-1",
      evaluator: { id: "continuity-terminal-grader", version: "1.2.1" },
      inputHash: digest("f"),
      observedAt: "2026-07-29T04:00:00.000Z",
      passed: false,
      variant: "baseline"
    });

    expect(same.evidenceHash).toBe(original.evidenceHash);
    expect(drifted?.evidenceHash).not.toBe(original.evidenceHash);
  });

  it("builds an immutable bundle without applying promotion", () => {
    const bundle = buildExperienceLearningReplayBundle(candidate(), [evidenceCase()]);

    expect(bundle).toMatchObject({
      candidateId: candidate().candidateId,
      replay: {
        promotionApplied: false,
        recommendation: "eligible-for-review"
      },
      status: "frozen"
    });
    expect(bundle?.bundleId).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(bundle?.cases)).toBe(true);
  });

  it("fails closed on unknown fields, accessors, drifted hashes, and incomparable pairs", () => {
    const valid = evidenceCase();
    expect(parseExperienceReplayEvidenceCases([{ ...valid, unexpected: true }])).toBeUndefined();
    expect(parseExperienceReplayEvidenceCases([{
      ...valid,
      baseline: { ...valid.baseline, evidenceHash: digest("0") }
    }])).toBeUndefined();
    expect(parseExperienceReplayEvidenceCases([{
      ...valid,
      challenger: {
        ...valid.challenger,
        inputHash: digest("e")
      }
    }])).toBeUndefined();
    const accessor = Object.defineProperty({}, "caseId", {
      enumerable: true,
      get: () => "case-1"
    });
    Object.assign(accessor, { baseline: valid.baseline, challenger: valid.challenger });
    expect(parseExperienceReplayEvidenceCases([accessor])).toBeUndefined();
  });

  it("rejects sparse arrays, duplicate case IDs, and non-canonical timestamps", () => {
    const sparse = new Array<ReturnType<typeof evidenceCase>>(3);
    sparse[0] = evidenceCase();
    sparse[2] = evidenceCase("case-2");
    expect(parseExperienceReplayEvidenceCases(sparse)).toBeUndefined();
    expect(parseExperienceReplayEvidenceCases([evidenceCase(), evidenceCase()])).toBeUndefined();
    expect(createExperienceReplayEvidenceReceipt({
      caseId: "case-1",
      evaluator: { id: "grader", version: "1" },
      inputHash: digest("f"),
      observedAt: "2026-07-29T04:00:00Z",
      passed: true,
      variant: "challenger"
    })).toBeUndefined();
  });

  it("rejects accessors and unknown own fields on the intake array without executing them", () => {
    let getterRan = false;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        getterRan = true;
        return evidenceCase();
      }
    });
    Object.defineProperty(accessorArray, "length", { value: 1 });
    expect(parseExperienceReplayEvidenceCases(accessorArray)).toBeUndefined();
    expect(getterRan).toBe(false);

    const extraFieldArray = [evidenceCase()];
    Object.defineProperty(extraFieldArray, "hidden", { value: true });
    expect(parseExperienceReplayEvidenceCases(extraFieldArray)).toBeUndefined();
    const symbolFieldArray = [evidenceCase()];
    Object.defineProperty(symbolFieldArray, Symbol("hidden"), { value: true });
    expect(parseExperienceReplayEvidenceCases(symbolFieldArray)).toBeUndefined();

    let inheritedIteratorRan = false;
    class HostileArray extends Array<unknown> {
      override *[Symbol.iterator](): ArrayIterator<unknown> {
        inheritedIteratorRan = true;
        yield evidenceCase();
      }
    }
    const subclass = new HostileArray();
    subclass.push(evidenceCase());
    expect(parseExperienceReplayEvidenceCases(subclass)).toBeUndefined();
    expect(inheritedIteratorRan).toBe(false);
  });

  it("rejects runtime-coerced identifiers in the public receipt creator", () => {
    expect(createExperienceReplayEvidenceReceipt({
      caseId: 1 as unknown as string,
      evaluator: { id: 2 as unknown as string, version: "1" },
      inputHash: digest("f"),
      observedAt: "2026-07-29T04:00:00.000Z",
      passed: true,
      variant: "challenger"
    })).toBeUndefined();
  });
});
