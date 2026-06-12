import { describe, expect, it } from "vitest";

import { analyzeRunOutcomes } from "./run-outcome-analysis.js";

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
});
