import { describe, expect, it } from "vitest";

import { InMemoryLatencyQuery } from "../src/observability-latency.js";
import type { QueryableTraceEventSink, TraceEventInput } from "../src/index.js";

// Direct coverage for the in-memory latency query (untested module; observability
// is a low test-density package). It backs `muse latency` — the percentile math,
// the [from,to) window, the span-name filter, the duration clamp, and the
// hour-bucketing are all bug-prone, so pin them with a fake event sink.

const ev = (name: string, startMs: number, durMs: number | null): TraceEventInput => ({
  attributes: {},
  name,
  runId: "r",
  spanId: "s",
  stage: "x",
  startedAt: new Date(startMs),
  ...(durMs === null ? {} : { endedAt: new Date(startMs + durMs) }),
});
const sink = (events: readonly TraceEventInput[]): QueryableTraceEventSink => ({
  list: () => events,
  listByRunId: () => events,
  record: async () => undefined,
});
const FROM = new Date(0);
const TO = new Date(1e12);

describe("InMemoryLatencyQuery.summary", () => {
  it("computes avg + linear-interpolated p50/p95/p99 over the matching durations", async () => {
    const q = new InMemoryLatencyQuery(sink([10, 20, 30, 40, 50].map((d, i) => ev("muse.agent.run", 1_000 + i, d))));
    // p95 = 40 + (50-40)*0.8 = 48 (rank 0.95*(5-1)=3.8); p99 rounds to 50.
    expect(await q.summary({ from: FROM, to: TO })).toEqual({ avgMs: 30, count: 5, p50Ms: 30, p95Ms: 48, p99Ms: 50 });
  });

  it("returns all-zero for an empty / no-matching set", async () => {
    expect(await new InMemoryLatencyQuery(sink([])).summary({ from: FROM, to: TO }))
      .toEqual({ avgMs: 0, count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
  });

  it("clamps a negative duration to 0, excludes an un-ended span, and excludes non-prefix spans", async () => {
    const q = new InMemoryLatencyQuery(sink([
      ev("muse.agent.run", 100, -50), // ended before started → clamped to 0, still counted
      ev("muse.agent.run", 200, null), // no endedAt → excluded
      ev("other.span", 300, 999), // outside the default "muse.agent." prefix → excluded
    ]));
    expect(await q.summary({ from: FROM, to: TO })).toMatchObject({ avgMs: 0, count: 1 });
  });

  it("the [from,to) window is half-open and an exact spanName filter overrides the prefix", async () => {
    const events = [ev("muse.agent.run", 100, 10), ev("muse.agent.stream", 200, 20)];
    expect((await new InMemoryLatencyQuery(sink(events)).summary({ from: FROM, spanName: "muse.agent.run", to: TO })).count).toBe(1);
    // window excludes events at/after `to` and before `from`
    expect((await new InMemoryLatencyQuery(sink(events)).summary({ from: new Date(150), to: TO })).count).toBe(1);
    expect((await new InMemoryLatencyQuery(sink(events)).summary({ from: FROM, to: new Date(100) })).count).toBe(0); // 100 is excluded (half-open)
  });
});

describe("InMemoryLatencyQuery.timeSeries", () => {
  it("buckets by the hour (default), orders by bucket start, and averages within each bucket", async () => {
    const hr = 3_600_000;
    const ts = await new InMemoryLatencyQuery(sink([
      ev("muse.agent.run", 0, 10),
      ev("muse.agent.run", 5, 30),
      ev("muse.agent.run", hr + 1, 100),
    ])).timeSeries({ from: FROM, to: TO });
    expect(ts.map((p) => p.count)).toEqual([2, 1]);
    expect(ts.map((p) => p.avgMs)).toEqual([20, 100]);
    expect(ts[0]!.bucketStart.getTime()).toBeLessThan(ts[1]!.bucketStart.getTime()); // sorted ascending
  });

  it("rejects a non-positive / non-finite bucketSizeMs", async () => {
    const q = new InMemoryLatencyQuery(sink([]));
    await expect(q.timeSeries({ bucketSizeMs: 0, from: FROM, to: TO })).rejects.toThrow();
    await expect(q.timeSeries({ bucketSizeMs: Number.NaN, from: FROM, to: TO })).rejects.toThrow();
  });
});
