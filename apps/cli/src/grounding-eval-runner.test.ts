import type { GroundingEvalResult } from "@muse/agent-core";
import { describe, expect, it } from "vitest";
import { GROUNDING_THRESHOLDS, renderGroundingEvalReport } from "./grounding-eval-runner.js";

function result(overrides: Partial<GroundingEvalResult>): GroundingEvalResult {
  return {
    answerable: 12,
    caught: 13,
    drift: 5,
    falseRefusalRate: 0,
    falseRefusals: 0,
    faithfulnessRate: 1,
    guardable: 13,
    outcomes: [],
    refuse: 8,
    total: 25,
    ...overrides
  };
}

describe("renderGroundingEvalReport", () => {
  it("passes when both rates clear the threshold and prints both", () => {
    const report = renderGroundingEvalReport(
      result({ caught: 12, falseRefusalRate: 0.08, falseRefusals: 1, faithfulnessRate: 0.92 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("ok");
    expect(report.text).toContain("faithfulness   0.92");
    expect(report.text).toContain("false-refusal  0.08");
    expect(report.text).toContain("25 cases (12 answerable, 8 must-refuse, 5 drift)");
  });

  it("fails when faithfulness drops below the floor", () => {
    const report = renderGroundingEvalReport(
      result({ caught: 9, faithfulnessRate: 0.69 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("fail");
    expect(report.text).toContain("✗ below 84%");
  });

  it("fails when false-refusal rises above the ceiling", () => {
    const report = renderGroundingEvalReport(
      result({ falseRefusalRate: 0.5, falseRefusals: 6 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("fail");
    expect(report.text).toContain("✗ above 25%");
  });

  it("lists the flagged cases so a regression is actionable", () => {
    const report = renderGroundingEvalReport(
      result({
        caught: 12,
        faithfulnessRate: 0.92,
        outcomes: [
          { detail: "retrieval=confident", kind: "refuse", note: "no spending log", passed: false, query: "groceries last month?" },
          { detail: "verdict=grounded", kind: "answerable", passed: true, query: "rent?" }
        ]
      }),
      GROUNDING_THRESHOLDS
    );
    expect(report.text).toContain("flagged cases:");
    expect(report.text).toContain('[refuse] "groceries last month?" — retrieval=confident (no spending log)');
    expect(report.text).not.toContain('"rent?"'); // a passing case is not flagged
  });

  it("the shipped floor sits one miss below the measured 0.92 baseline", () => {
    // 11/13 caught = 0.846 must still pass; 10/13 = 0.769 must fail — proving the
    // floor is a regression detector with headroom, not the current quality.
    expect(GROUNDING_THRESHOLDS.minFaithfulness).toBeLessThanOrEqual(11 / 13);
    expect(GROUNDING_THRESHOLDS.minFaithfulness).toBeGreaterThan(10 / 13);
  });
});
