import type { AgentRunRecord } from "@muse/runtime-state";
import type { LatencyPoint, LatencySummary } from "@muse/observability";
import { describe, expect, it } from "vitest";

import {
  latencySummary,
  latencySummaryFromQuery,
  latencyTimeseries,
  latencyTimeseriesFromQuery
} from "./compat-run-aggregations.js";

// Direct coverage for the latency aggregations (the run-aggregation slice covered
// the tool/failure rollups; the latency percentiles + the query mappers were
// not). The percentile index math (p50/p95/p99) is the SLO-observability signal.

// createdAt = now so the runs fall inside any positive-day window; the latency
// (completedAt - startedAt) is fixed, so the percentile output is deterministic.
const NOW = Date.now();
const run = (latencyMs: number): AgentRunRecord =>
  ({ completedAt: new Date(NOW + latencyMs), createdAt: new Date(NOW), startedAt: new Date(NOW) }) as unknown as AgentRunRecord;

describe("latencySummary", () => {
  it("computes p50/p95/p99 by the floor((n-1)*p) index over the in-window latencies", () => {
    const runs = [run(100), run(200), run(300), run(400), run(500)];
    expect(latencySummary(runs, 7)).toEqual({ count: 5, p50Ms: 300, p95Ms: 400, p99Ms: 400 });
  });

  it("excludes runs outside the window and filters runs missing a start/complete timestamp", () => {
    const old = [{ completedAt: new Date(NOW + 999), createdAt: new Date(NOW - 100 * 86_400_000), startedAt: new Date(NOW) }] as unknown as AgentRunRecord[];
    expect(latencySummary(old, 7)).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }); // 100 days ago, 7-day window

    const partial = [run(100), { createdAt: new Date(NOW), startedAt: null, completedAt: null } as unknown as AgentRunRecord];
    expect(latencySummary(partial, 7).count).toBe(1); // the timestamp-less run drops out of the latencies
  });
});

describe("latencyTimeseries", () => {
  it("buckets in-window runs by day with the average latency + count", () => {
    const [point] = latencyTimeseries([run(100), run(300), run(500)], 7);
    expect(point).toMatchObject({ avgLatencyMs: 300, count: 3 }); // (100+300+500)/3
    expect(typeof point?.date).toBe("string");
  });
});

describe("latencySummaryFromQuery / latencyTimeseriesFromQuery", () => {
  it("latencySummaryFromQuery passes the precomputed percentiles through", () => {
    const summary = { count: 10, p50Ms: 100, p95Ms: 500, p99Ms: 900 } as unknown as LatencySummary;
    expect(latencySummaryFromQuery(summary)).toEqual({ count: 10, p50Ms: 100, p95Ms: 500, p99Ms: 900 });
  });

  it("latencyTimeseriesFromQuery maps query points to { date, avgLatencyMs, count }", () => {
    const points = [{ avgMs: 150, bucketStart: new Date("2026-05-30T00:00:00Z"), count: 3 }] as unknown as LatencyPoint[];
    expect(latencyTimeseriesFromQuery(points)).toEqual([{ avgLatencyMs: 150, count: 3, date: "2026-05-30" }]);
  });
});
