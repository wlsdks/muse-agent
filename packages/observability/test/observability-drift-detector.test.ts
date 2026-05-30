import { describe, expect, it } from "vitest";

import { PromptDriftDetector } from "../src/observability-detectors.js";

// Direct coverage for the prompt-drift detector (the last untested detector).
// It splits the rolling window into baseline (first half) + current (second
// half) and flags an anomaly when the mean shifts beyond `deviationThreshold`
// standard deviations — so the minSamples gate, the σ math (incl. the flat-
// baseline stddev floor), and the no-false-positive-on-stable cases matter.

const detector = () => new PromptDriftDetector({ deviationThreshold: 2, minSamples: 20, now: () => 1000, windowSize: 200 });

describe("PromptDriftDetector", () => {
  it("flags an input-length drift when the current-half mean shifts far beyond the baseline σ", () => {
    const d = detector();
    for (let i = 0; i < 10; i += 1) d.recordInput(90 + (i % 5) * 5); // baseline ~100
    for (let i = 0; i < 10; i += 1) d.recordInput(490 + (i % 5) * 5); // current ~500
    const anomalies = d.evaluate();
    expect(anomalies.map((a) => a.type)).toEqual(["input_length"]);
    expect(anomalies[0]!.deviationFactor).toBeGreaterThan(2);
  });

  it("does NOT flag a stable distribution (no false positive)", () => {
    const d = detector();
    for (let i = 0; i < 20; i += 1) d.recordInput(95 + (i % 5) * 2);
    expect(d.evaluate()).toEqual([]);
  });

  it("does not evaluate below minSamples (even wildly varying samples)", () => {
    const d = detector();
    for (let i = 0; i < 19; i += 1) d.recordInput(i * 100);
    expect(d.evaluate()).toEqual([]);
  });

  it("an all-equal window is not an anomaly (zero stddev + equal means → no drift)", () => {
    const d = detector();
    for (let i = 0; i < 20; i += 1) d.recordInput(100);
    expect(d.evaluate()).toEqual([]);
  });

  it("a flat baseline that then shifts IS caught via the stddev floor (can't hide a jump behind zero variance)", () => {
    const d = detector();
    for (let i = 0; i < 10; i += 1) d.recordInput(100); // zero-variance baseline
    for (let i = 0; i < 10; i += 1) d.recordInput(300); // clear shift
    expect(d.evaluate().map((a) => a.type)).toEqual(["input_length"]);
  });

  it("ignores non-finite / negative samples and evaluates input + output independently", () => {
    const d = detector();
    d.recordInput(Number.NaN);
    d.recordInput(-5);
    expect(d.stats().sampleCount).toBe(0);
    for (let i = 0; i < 10; i += 1) d.recordOutput(50 + i);
    for (let i = 0; i < 10; i += 1) d.recordOutput(900 + i);
    expect(d.evaluate().map((a) => a.type)).toEqual(["output_length"]);
  });

  it("rejects an invalid windowSize / deviationThreshold / minSamples at construction", () => {
    expect(() => new PromptDriftDetector({ windowSize: 0 })).toThrow();
    expect(() => new PromptDriftDetector({ deviationThreshold: 0 })).toThrow();
    expect(() => new PromptDriftDetector({ minSamples: -1 })).toThrow();
  });
});
