import { describe, expect, it } from "vitest";

import { createMuseObservabilitySnapshotProvider } from "../src/observability-muse-snapshot.js";
import { MonthlyBudgetTracker, PromptDriftDetector, SloAlertEvaluator } from "../src/observability-detectors.js";
import type { LatencyQuery } from "../src/observability-latency.js";

// Direct coverage for the observability snapshot provider (untested module). It
// aggregates every detector/query into one status snapshot, and each section is
// FAIL-OPEN (a throwing dependency is logged + omitted, never breaks the whole
// snapshot). That robustness + the window math are the load-bearing behaviors.

const NOW = new Date("2026-05-15T00:00:00Z");
const now = () => NOW;
const okLatency: LatencyQuery = {
  summary: async () => ({ avgMs: 10, count: 1, p50Ms: 10, p95Ms: 10, p99Ms: 10 }),
  timeSeries: async () => [],
};
const sectionKeys = (snap: object) => Object.keys(snap).filter((k) => !["generatedAt", "windowEnd", "windowStart"].includes(k)).sort();

describe("createMuseObservabilitySnapshotProvider", () => {
  it("computes the [now - windowDays, now] window and includes NO sections when no deps are wired", async () => {
    const snap = await createMuseObservabilitySnapshotProvider({ now, windowDays: 7 }).snapshot();
    expect(snap.windowEnd).toEqual(NOW);
    expect((snap.windowEnd.getTime() - snap.windowStart.getTime()) / 86_400_000).toBe(7);
    expect(sectionKeys(snap)).toEqual([]);
  });

  it("includes a section for each wired dependency", async () => {
    const snap = await createMuseObservabilitySnapshotProvider({
      budgetTracker: new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now }),
      driftDetector: new PromptDriftDetector({ now: () => 1_000 }),
      latencyQuery: okLatency,
      now,
      sloEvaluator: new SloAlertEvaluator({ cooldownSeconds: 0, errorRateThreshold: 0.2, latencyThresholdMs: 100, minSamples: 1, now: () => 1_000, windowSeconds: 60 }),
    }).snapshot();
    expect(sectionKeys(snap)).toEqual(["budget", "drift", "latency", "slo"]);
  });

  it("is FAIL-OPEN: a throwing dependency is logged and its section omitted, while the rest of the snapshot still renders", async () => {
    const logs: string[] = [];
    const failLatency: LatencyQuery = {
      summary: async () => { throw new Error("trace DB down"); },
      timeSeries: async () => [],
    };
    const snap = await createMuseObservabilitySnapshotProvider({
      budgetTracker: new MonthlyBudgetTracker({ monthlyLimitUsd: 100, now }),
      latencyQuery: failLatency,
      logger: (m) => logs.push(m),
      now,
    }).snapshot();
    expect(snap.latency).toBeUndefined(); // the broken section dropped out
    expect(snap.budget).toBeDefined(); // the healthy one still rendered
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("latencyQuery");
  });

  it("clamps a non-positive windowDays to a minimum of 1 day", async () => {
    const snap = await createMuseObservabilitySnapshotProvider({ now, windowDays: 0 }).snapshot();
    expect((snap.windowEnd.getTime() - snap.windowStart.getTime()) / 86_400_000).toBe(1);
  });
});
