import { describe, expect, it } from "vitest";

import { recordedSpans, recordedTraceEvents } from "./admin-routes.js";

// Direct coverage for the duck-typed trace/span accessors (untested) — defensive
// helpers that probe an UNKNOWN sink for the right method, so a malformed or
// absent sink yields [] instead of throwing. The runId routing is load-bearing:
// a per-run query must use listByRunId when available, else fall back to list().

describe("recordedTraceEvents", () => {
  it("returns [] for a non-object sink", () => {
    expect(recordedTraceEvents(null)).toEqual([]);
    expect(recordedTraceEvents(5)).toEqual([]);
    expect(recordedTraceEvents(undefined)).toEqual([]);
  });

  it("uses listByRunId when a runId is given and the method exists", () => {
    const sink = { list: () => [{ all: 1 }], listByRunId: (id: string) => [{ run: id }] };
    expect(recordedTraceEvents(sink, "r1")).toEqual([{ run: "r1" }]);
  });

  it("falls back to list() when there is no runId, or no listByRunId for the runId", () => {
    const listOnly = { list: () => [{ all: 1 }] };
    expect(recordedTraceEvents(listOnly)).toEqual([{ all: 1 }]); // no runId
    expect(recordedTraceEvents(listOnly, "r1")).toEqual([{ all: 1 }]); // runId but no listByRunId → list()
  });

  it("returns [] when neither method is present", () => {
    expect(recordedTraceEvents({})).toEqual([]);
  });
});

describe("recordedSpans", () => {
  it("calls recordedSpans() when present, else [] for a missing method or non-object", () => {
    expect(recordedSpans({ recordedSpans: () => [{ s: 1 }] })).toEqual([{ s: 1 }]);
    expect(recordedSpans({})).toEqual([]);
    expect(recordedSpans(null)).toEqual([]);
  });
});
