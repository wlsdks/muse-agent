import { describe, expect, it } from "vitest";

import {
  InMemoryAgentMetrics,
  NoOpAgentMetrics,
  createDerivedAgentMetrics,
  createSloFeedingAgentMetrics,
} from "../src/observability-agent-metrics.js";
import { PromptDriftDetector, SloAlertEvaluator } from "../src/observability-detectors.js";

// Direct coverage for the agent-metrics recorders + the derived fan-out
// (untested module). The fan-out is the WIRING that feeds the SLO + drift
// detectors from the runtime's metric events — a bug there silently starves the
// detectors of data, so pin it against REAL detector instances.

describe("InMemoryAgentMetrics", () => {
  it("records each metric type and returns a defensive copy of the events", () => {
    const m = new InMemoryAgentMetrics();
    m.recordAgentRun({ durationMs: 50, runId: "r", status: "completed" } as never);
    m.recordTokenUsage({ inputTokens: 10, outputTokens: 20 });
    m.recordGuardRejection("input", "pii");
    expect(m.recordedEvents().map((e) => e.type)).toEqual(["agent_run", "token_usage", "guard_rejection"]);
    // mutating the returned snapshot must not corrupt internal state
    const snapshot = m.recordedEvents();
    (snapshot[0]!.payload as { durationMs?: number }).durationMs = 999;
    expect((m.recordedEvents()[0]!.payload as { durationMs?: number }).durationMs).toBe(50);
  });

  it("bounds memory: the oldest events are evicted past maxEntries (FIFO)", () => {
    const m = new InMemoryAgentMetrics({ maxEntries: 2 });
    for (let i = 0; i < 5; i += 1) m.recordGuardRejection("s", `r${i.toString()}`);
    const events = m.recordedEvents();
    expect(events).toHaveLength(2);
    expect((events[1]!.payload as { reason: string }).reason).toBe("r4"); // newest kept
  });
});

describe("NoOpAgentMetrics", () => {
  it("accepts every metric call without throwing or recording", () => {
    const m = new NoOpAgentMetrics();
    expect(() => {
      m.recordAgentRun({ durationMs: 1, runId: "r", status: "failed" } as never);
      m.recordTokenUsage({ inputTokens: 1, outputTokens: 1 });
      m.recordGuardRejection("s", "r");
      m.recordOutputGuardAction("s", "masked" as never, "r");
    }).not.toThrow();
  });
});

describe("createDerivedAgentMetrics — the detector fan-out", () => {
  it("feeds recordAgentRun → SLO latency+result and recordTokenUsage → drift input/output, while still forwarding to inner", () => {
    const slo = new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 0.2, latencyThresholdMs: 100, minSamples: 1, now: () => 1000, windowSeconds: 60 });
    const drift = new PromptDriftDetector({ minSamples: 1, now: () => 1000 });
    const inner = new InMemoryAgentMetrics();
    const m = createDerivedAgentMetrics({ drift, inner, slo });

    m.recordAgentRun({ durationMs: 50, runId: "r", status: "completed" } as never);
    m.recordTokenUsage({ inputTokens: 100, outputTokens: 200 });

    expect(slo.snapshot()).toMatchObject({ latencySamples: 1, resultSamples: 1 });
    expect(drift.stats()).toMatchObject({ outputMean: 200, sampleCount: 1 });
    expect(inner.recordedEvents().map((e) => e.type)).toEqual(["agent_run", "token_usage"]); // inner still sees everything
  });

  it("createSloFeedingAgentMetrics feeds only the SLO (latency + result) and forwards the rest", () => {
    const slo = new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 0.2, latencyThresholdMs: 100, minSamples: 1, now: () => 1000, windowSeconds: 60 });
    const m = createSloFeedingAgentMetrics(slo, new InMemoryAgentMetrics());
    m.recordAgentRun({ durationMs: 10, runId: "r", status: "failed" } as never);
    expect(slo.snapshot()).toMatchObject({ latencySamples: 1, resultSamples: 1 });
    expect(slo.snapshot().errorRate).toBe(1); // the one run failed
  });
});
