import { describe, expect, it } from "vitest";

import { PromptDriftDetector } from "./observability-prompt-drift.js";

const detector = () => new PromptDriftDetector({ deviationThreshold: 2, minSamples: 20, now: () => 1000, windowSize: 200 });

describe("PromptDriftDetector", () => {
  it("flags an input_length anomaly when the second-half mean shifts beyond the threshold", () => {
    const d = detector();
    for (let i = 0; i < 10; i += 1) d.recordInput(90 + (i % 5) * 5); // baseline ~100
    for (let i = 0; i < 10; i += 1) d.recordInput(490 + (i % 5) * 5); // current ~500
    const anomalies = d.evaluate();
    expect(anomalies.map((a) => a.type)).toEqual(["input_length"]);
    expect(anomalies[0]!.deviationFactor).toBeGreaterThan(2);
  });

  it("reports no anomaly for a stable window", () => {
    const d = detector();
    for (let i = 0; i < 20; i += 1) d.recordInput(95 + (i % 5) * 2);
    expect(d.evaluate()).toEqual([]);
  });

  it("reports no anomaly below the minimum sample count", () => {
    const d = detector();
    for (let i = 0; i < 19; i += 1) d.recordInput(i * 100);
    expect(d.evaluate()).toEqual([]);
  });
});
