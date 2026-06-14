import { describe, expect, it } from "vitest";

import { SloAlertEvaluator } from "./observability-slo-alert.js";

const opts = {
  cooldownSeconds: 0,
  errorRateThreshold: 0.5,
  latencyThresholdMs: 100,
  minSamples: 1,
  windowSeconds: 60,
  now: () => 1000
};

describe("SloAlertEvaluator", () => {
  it("raises a latency violation when p95 latency exceeds the threshold", () => {
    const slo = new SloAlertEvaluator(opts);
    for (let i = 0; i < 5; i += 1) slo.recordLatency(500);
    slo.recordResult(true);
    expect(slo.evaluate().some((v) => v.type === "latency")).toBe(true);
  });

  it("raises no latency violation when latencies are under the threshold", () => {
    const slo = new SloAlertEvaluator(opts);
    for (let i = 0; i < 5; i += 1) slo.recordLatency(40);
    slo.recordResult(true);
    expect(slo.evaluate().some((v) => v.type === "latency")).toBe(false);
  });

  it("raises an error_rate violation when the failure rate exceeds the threshold", () => {
    const slo = new SloAlertEvaluator(opts);
    slo.recordResult(false);
    slo.recordResult(false);
    expect(slo.evaluate().some((v) => v.type === "error_rate")).toBe(true);
  });
});
