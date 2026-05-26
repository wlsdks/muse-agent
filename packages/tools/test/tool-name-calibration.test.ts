import { describe, expect, it } from "vitest";

import {
  extractCandidateNames,
  formatCalibrationReport,
  normalizeToolName,
  recommendRename,
  tallyPeakedness,
  type CalibrationResult
} from "../src/tool-name-calibration.js";

describe("normalizeToolName", () => {
  it("lowercases and underscores spaces/hyphens", () => {
    expect(normalizeToolName("Get Current Time")).toBe("get_current_time");
    expect(normalizeToolName("what-is-the-time")).toBe("what_is_the_time");
  });

  it("strips surrounding quotes/backticks and trailing punctuation", () => {
    expect(normalizeToolName("`fetch_now`.")).toBe("fetch_now");
    expect(normalizeToolName("'Time_Now'")).toBe("time_now");
  });

  it("collapses repeated underscores and trims edge underscores", () => {
    expect(normalizeToolName("__time__now__")).toBe("time_now");
  });

  it("treats a dotted name as snake_case", () => {
    expect(normalizeToolName("time.now")).toBe("time_now");
  });

  it("returns empty string for unusable input", () => {
    expect(normalizeToolName("")).toBe("");
    expect(normalizeToolName("123abc")).toBe("");
    expect(normalizeToolName("!!!")).toBe("");
  });
});

describe("extractCandidateNames", () => {
  it("extracts a backticked verb_noun from prose", () => {
    expect(extractCandidateNames("I'd name it `get_current_time`.")).toEqual(["get_current_time"]);
  });

  it("extracts multiple multi-part names in order, deduped", () => {
    expect(extractCandidateNames("Maybe current_time or time_now")).toEqual(["current_time", "time_now"]);
  });

  it("falls back to a single bare token reply", () => {
    expect(extractCandidateNames("clock")).toEqual(["clock"]);
  });

  it("returns [] when the reply is prose with no name-like token", () => {
    expect(extractCandidateNames("no idea")).toEqual([]);
    expect(extractCandidateNames("")).toEqual([]);
  });
});

describe("tallyPeakedness", () => {
  it("counts and shares the dominant name first", () => {
    const rows = tallyPeakedness(["time_now", "time_now", "clock_now"]);
    expect(rows).toEqual([
      { name: "time_now", count: 2, share: 2 / 3 },
      { name: "clock_now", count: 1, share: 1 / 3 }
    ]);
  });

  it("drops invalid/empty samples and divides by valid count", () => {
    const rows = tallyPeakedness(["", "time_now", "!!!", "time_now"]);
    expect(rows).toEqual([{ name: "time_now", count: 2, share: 1 }]);
  });

  it("returns [] when there are no valid samples", () => {
    expect(tallyPeakedness(["", "!!!"])).toEqual([]);
  });
});

describe("recommendRename", () => {
  const base = { current: "current_clock_value", baselineRate: 0.4, margin: 0.1 };

  it("recommends a candidate that beats baseline by the margin", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "time_now", rate: 0.95, siblingRegression: false, collidesWithSibling: false }]
    });
    expect(d).toEqual({ recommend: true, from: "current_clock_value", to: "time_now", reason: expect.stringContaining("0.95") });
  });

  it("does not recommend when the lift is below the margin", () => {
    const d = recommendRename({
      current: "time_now",
      baselineRate: 0.8,
      margin: 0.1,
      candidates: [{ name: "clock_now", rate: 0.85, siblingRegression: false, collidesWithSibling: false }]
    });
    expect(d.recommend).toBe(false);
    expect(d.to).toBeUndefined();
    expect(d.reason).toContain("margin");
  });

  it("rejects a candidate that collides with a sibling", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "time_diff", rate: 0.99, siblingRegression: false, collidesWithSibling: true }]
    });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("collision");
  });

  it("rejects a candidate that regresses a sibling", () => {
    const d = recommendRename({
      ...base,
      candidates: [{ name: "now_clock", rate: 0.95, siblingRegression: true, collidesWithSibling: false }]
    });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("regress");
  });

  it("picks the highest-rate qualifying candidate", () => {
    const d = recommendRename({
      ...base,
      candidates: [
        { name: "time_now", rate: 0.7, siblingRegression: false, collidesWithSibling: false },
        { name: "clock_reading", rate: 0.9, siblingRegression: false, collidesWithSibling: false }
      ]
    });
    expect(d.to).toBe("clock_reading");
  });

  it("reports no valid candidate when the candidate list is empty", () => {
    const d = recommendRename({ ...base, candidates: [] });
    expect(d.recommend).toBe(false);
    expect(d.reason).toContain("no valid candidate");
  });
});

describe("formatCalibrationReport", () => {
  const result: CalibrationResult = {
    tool: "time_now",
    job: "return the current wall-clock time",
    peakedness: [{ name: "time_now", count: 8, share: 0.8 }],
    baselineRate: 0.9,
    candidates: [{ name: "current_time", rate: 0.92, siblingRegression: false, collidesWithSibling: false }],
    decision: { recommend: false, from: "time_now", reason: "no candidate beats baseline 0.90 by margin 0.10" }
  };

  it("returns the json passthrough unchanged", () => {
    expect(formatCalibrationReport([result]).json).toEqual([result]);
  });

  it("renders the tool name, peakedness leader and decision in the text", () => {
    const { text } = formatCalibrationReport([result]);
    expect(text).toContain("time_now");
    expect(text).toContain("80%");
    expect(text).toContain("no candidate beats baseline");
  });
});
