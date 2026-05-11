import { describe, expect, it } from "vitest";

import { InMemoryTelemetryAggregator } from "../src/telemetry-aggregator.js";

describe("InMemoryTelemetryAggregator (phase A)", () => {
  function evt(overrides: Partial<Parameters<InMemoryTelemetryAggregator["record"]>[0]> = {}) {
    return {
      contextCounters: {},
      contextFlags: {},
      model: "diagnostic/smoke",
      providerId: "diagnostic",
      recordedAtMs: 1_000,
      runId: "r-1",
      ...overrides
    };
  }

  it("records events and exposes them via recent()", () => {
    const agg = new InMemoryTelemetryAggregator({ now: () => 2_000 });
    agg.record(evt({ recordedAtMs: 1_000, runId: "r-1" }));
    agg.record(evt({ recordedAtMs: 1_500, runId: "r-2" }));
    const recent = agg.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[1]?.runId).toBe("r-2");
  });

  it("trims to capacity (oldest dropped first)", () => {
    const agg = new InMemoryTelemetryAggregator({ capacity: 2, now: () => 2_000 });
    agg.record(evt({ runId: "r-1" }));
    agg.record(evt({ runId: "r-2" }));
    agg.record(evt({ runId: "r-3" }));
    const recent = agg.recent(5);
    expect(recent.map((event) => event.runId)).toEqual(["r-2", "r-3"]);
  });

  it("summarises flag counts + counter averages + token totals in the window", () => {
    const now = 10_000;
    const agg = new InMemoryTelemetryAggregator({ now: () => now });
    agg.record(evt({
      cachedInputTokens: 100,
      contextCounters: { inboxContextMessageCount: 3 },
      contextFlags: { activeContextApplied: true, inboxContextApplied: true },
      inputTokens: 1_000,
      outputTokens: 200,
      recordedAtMs: now - 1_000,
      runId: "r-a"
    }));
    agg.record(evt({
      cachedInputTokens: 50,
      contextCounters: { inboxContextMessageCount: 5 },
      contextFlags: { activeContextApplied: true, inboxContextFailed: true },
      inputTokens: 500,
      outputTokens: 80,
      recordedAtMs: now - 500,
      runId: "r-b"
    }));
    // Outside the default 7-day window — still in by default.
    const summary = agg.summary();
    expect(summary.totalRuns).toBe(2);
    expect(summary.flagCounts).toMatchObject({
      activeContextApplied: 2,
      inboxContextApplied: 1,
      inboxContextFailed: 1
    });
    expect(summary.counterAverages["inboxContextMessageCount"]).toBe(4);
    expect(summary.tokenTotals).toEqual({ cachedInput: 150, input: 1_500, output: 280 });
  });

  it("excludes events outside the sinceMs window", () => {
    const now = 10_000;
    const agg = new InMemoryTelemetryAggregator({ now: () => now });
    agg.record(evt({ recordedAtMs: 1_000, runId: "old" }));
    agg.record(evt({ recordedAtMs: 9_500, runId: "fresh" }));
    const summary = agg.summary({ sinceMs: 9_000 });
    expect(summary.totalRuns).toBe(1);
  });

  it("recent(0) returns empty (slice(-0) was a footgun before iter 26)", () => {
    // Before iter 26, `Math.max(0, Math.trunc(0)) === 0` followed by
    // `events.slice(-0) === events.slice(0)` returned the ENTIRE
    // event list when the caller asked for 0 — a silent footgun for
    // any UI that conditionally requested "the last N where N might
    // be 0". The fix branches explicitly on bound ≤ 0.
    const agg = new InMemoryTelemetryAggregator({ now: () => 2_000 });
    agg.record(evt({ runId: "r-1" }));
    agg.record(evt({ runId: "r-2" }));
    expect(agg.recent(0)).toEqual([]);
    expect(agg.recent(-5)).toEqual([]);
    expect(agg.recent(Number.NaN)).toEqual([]);
  });

  it("recent({ sinceMs }) filters to events at or after the threshold (iter 26)", () => {
    // The new options-object overload makes `recent` symmetric with
    // `summary({ sinceMs })`: ops can ask "show me raw events from
    // the last hour" without re-filtering by hand.
    const agg = new InMemoryTelemetryAggregator({ now: () => 10_000 });
    agg.record(evt({ recordedAtMs: 1_000, runId: "old" }));
    agg.record(evt({ recordedAtMs: 5_000, runId: "mid" }));
    agg.record(evt({ recordedAtMs: 9_500, runId: "fresh" }));
    const recent = agg.recent({ sinceMs: 5_000 });
    expect(recent.map((e) => e.runId)).toEqual(["mid", "fresh"]);
    // limit + sinceMs combine: filter first, then last-N.
    const lastOne = agg.recent({ limit: 1, sinceMs: 5_000 });
    expect(lastOne.map((e) => e.runId)).toEqual(["fresh"]);
  });

  it("recent({}) with no limit returns every retained event", () => {
    const agg = new InMemoryTelemetryAggregator({ now: () => 1_000 });
    agg.record(evt({ runId: "r-1" }));
    agg.record(evt({ runId: "r-2" }));
    expect(agg.recent({}).map((e) => e.runId)).toEqual(["r-1", "r-2"]);
  });

  it("aggregates budget tokens", () => {
    const now = 10_000;
    const agg = new InMemoryTelemetryAggregator({ now: () => now });
    agg.record(evt({
      budgetTokens: { "section.active-context": 30, total: 500 },
      recordedAtMs: now - 100,
      runId: "r-1"
    }));
    agg.record(evt({
      budgetTokens: { "section.active-context": 50, total: 700 },
      recordedAtMs: now - 50,
      runId: "r-2"
    }));
    const summary = agg.summary();
    expect(summary.budgetAverages["total"]).toBe(600);
    expect(summary.budgetAverages["section.active-context"]).toBe(40);
  });
});
