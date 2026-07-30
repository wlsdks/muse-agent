import { describe, expect, it } from "vitest";

import {
  compareExperienceLearningReplay,
  proposeExperienceLearningCandidate,
  type ExperienceLearningCandidate,
  type ExperienceReplayCase
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
    scope: { kind: "thread-timing", threadId: "thread-1" },
    sourceRun: {
      behaviorDigest: digest("b"),
      completedAt: "2026-07-29T03:00:00.000Z",
      evidenceClass: "controlled",
      runId: "run-1"
    }
  })!;
}

function replayCase(
  caseId: string,
  baselinePassed: boolean,
  challengerPassed: boolean
): ExperienceReplayCase {
  return {
    baseline: { evidenceHash: digest("c"), passed: baselinePassed },
    caseId,
    challenger: { evidenceHash: digest("d"), passed: challengerPassed }
  };
}

describe("compareExperienceLearningReplay", () => {
  it("recommends review only for strict gain with zero regressions and never applies promotion", () => {
    const result = compareExperienceLearningReplay(candidate(), [
      replayCase("case-b", true, true),
      replayCase("case-a", false, true)
    ]);

    expect(result).toMatchObject({
      aggregate: {
        baselinePassed: 1,
        challengerPassed: 2,
        improvements: 1,
        regressions: 0,
        ties: 1,
        total: 2
      },
      caseIds: ["case-a", "case-b"],
      promotionApplied: false,
      recommendation: "eligible-for-review",
      replayStatus: "frozen"
    });
    expect(result?.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["all ties", [replayCase("case-1", true, true)]],
    ["a regression despite a gain", [
      replayCase("case-1", false, true),
      replayCase("case-2", true, false)
    ]]
  ])("holds %s", (_label, cases) => {
    expect(compareExperienceLearningReplay(candidate(), cases)?.recommendation).toBe("hold");
  });

  it("binds the frozen set independent of caller order and changes on evidence drift", () => {
    const first = replayCase("case-1", false, true);
    const second = replayCase("case-2", true, true);
    const baseline = compareExperienceLearningReplay(candidate(), [first, second])!;
    const reordered = compareExperienceLearningReplay(candidate(), [second, first])!;
    const drifted = compareExperienceLearningReplay(candidate(), [
      first,
      { ...second, challenger: { ...second.challenger, evidenceHash: digest("e") } }
    ])!;

    expect(reordered.inputHash).toBe(baseline.inputHash);
    expect(drifted.inputHash).not.toBe(baseline.inputHash);
  });

  it("fails closed on duplicate IDs, invalid evidence, or empty cases", () => {
    const duplicate = replayCase("case-1", false, true);
    expect(compareExperienceLearningReplay(candidate(), [duplicate, duplicate])).toBeUndefined();
    expect(compareExperienceLearningReplay(candidate(), [{
      ...duplicate,
      challenger: { evidenceHash: "not-a-hash", passed: true }
    }])).toBeUndefined();
    expect(compareExperienceLearningReplay(candidate(), [])).toBeUndefined();
  });
});
