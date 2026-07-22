import { describe, expect, it } from "vitest";

import { analyzeRunOutcomes } from "@muse/proactivity";

describe("analyzeRunOutcomes — run-log failure rate + top failing topics", () => {
  it("tallies outcomes and computes the fail rate over LABELLED runs only", () => {
    const s = analyzeRunOutcomes([
      { grounded: "grounded", message: "what is my rent" },
      { grounded: "grounded", message: "office vpn mtu" },
      { grounded: "abstain", message: "what is my sister's birthday" },
      { grounded: "ungrounded", message: "who is my dentist" },
      { grounded: null, message: "json mode skip" } // not measurable — excluded from the denominator
    ]);
    expect(s.labelled).toBe(4); // the null is excluded
    expect(s.grounded).toBe(2);
    expect(s.abstain).toBe(1);
    expect(s.ungrounded).toBe(1);
    expect(s.failRate).toBeCloseTo(0.5, 5); // (1 abstain + 1 ungrounded) / 4
  });

  it("clusters same-topic failing-run messages, busiest first (success on the topic isn't counted)", () => {
    const s = analyzeRunOutcomes([
      { grounded: "abstain", message: "what is my office VPN MTU?" }, // → "office vpn mtu"
      { grounded: "abstain", message: "tell me my office VPN MTU" }, // → "office vpn mtu" (same key)
      { grounded: "ungrounded", message: "who is my dentist" },
      { grounded: "grounded", message: "office VPN MTU" } // a SUCCESS on the same topic is NOT counted as failing
    ], { maxTopics: 5 });
    const top = s.topFailingTopics;
    expect(top[0]?.count).toBeGreaterThanOrEqual(2); // the two same-phrased vpn-mtu failures cluster
    expect(top[0]?.topic).toContain("vpn");
    expect(top.some((t) => t.topic.includes("dentist"))).toBe(true);
  });

  it("empty / all-null input → zero fail rate, no topics (nothing measurable)", () => {
    expect(analyzeRunOutcomes([])).toMatchObject({ labelled: 0, failRate: 0, topFailingTopics: [] });
    expect(analyzeRunOutcomes([{ grounded: null, message: "x" }])).toMatchObject({ labelled: 0, failRate: 0 });
  });

  it("caps the topic list at maxTopics", () => {
    const entries = Array.from({ length: 8 }, (_unused, i) => ({ grounded: "abstain", message: `distinct topic number ${i.toString()} alpha${i.toString()}` }));
    expect(analyzeRunOutcomes(entries, { maxTopics: 3 }).topFailingTopics).toHaveLength(3);
  });

  it("keeps legacy three-outcome lines separate from six-outcome unique-run measurements", () => {
    const outcomes = ["grounded", "abstain", "ungrounded", "misgrounded", "contested", "error"] as const;
    const entries = outcomes.map((grounded, index) => ({
      fileRunId: `run_${index}`,
      grounded,
      lineIndex: 0,
      message: `topic ${index}`,
      recordedAt: `2026-07-2${index}T00:00:00.000Z`,
      runId: `run_${index}`,
      type: "chat.completed"
    }));
    const summary = analyzeRunOutcomes(entries, { now: new Date("2026-07-27T00:00:00.000Z") });

    expect(summary).toMatchObject({ labelled: 3, gradedRuns: 6, technicalFailures: 5, measurementStatus: "available" });
    expect(summary.failRate).toBeCloseTo(2 / 3, 5);
    expect(summary.measurement?.value).toEqual({ denominator: 6, numerator: 5, unit: "ratio" });
  });

  it("deduplicates a run to its latest canonical event and excludes future or mismatched provenance", () => {
    const base = { fileRunId: "run_a", message: "vpn", runId: "run_a", type: "chat.completed" } as const;
    const summary = analyzeRunOutcomes([
      { ...base, grounded: "ungrounded", lineIndex: 0, recordedAt: "2026-07-20T00:00:00.000Z" },
      { ...base, grounded: "grounded", lineIndex: 1, recordedAt: "2026-07-20T00:00:00.000Z" },
      { ...base, fileRunId: "wrong", grounded: "error", lineIndex: 2, recordedAt: "2026-07-21T00:00:00.000Z" },
      { ...base, grounded: "error", lineIndex: 3, recordedAt: "2026-07-23T00:00:00.000Z" }
    ], { now: new Date("2026-07-22T00:00:00.000Z") });

    expect(summary.gradedRuns).toBe(1);
    expect(summary.technicalFailures).toBe(0);
    expect(summary.measurement?.window).toEqual({ endedAt: "2026-07-20T00:00:00.000Z", startedAt: "2026-07-20T00:00:00.000Z" });
  });
});
