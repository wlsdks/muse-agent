import type { AgentRunRecord } from "@muse/runtime-state";
import { describe, expect, it } from "vitest";

import type { CompatibilityRouteOptions } from "./compat-routes.js";
import {
  debugReplayResponse,
  getDebugReplayCapture,
  listDebugReplayCaptures,
  opsMetricSnapshots,
  saveDebugReplayCapture
} from "./compat-routes.js";

// Direct coverage for the debug-replay capture helpers + opsMetricSnapshots
// (untested). debugReplayResponse maps a run into a replay envelope (30-day
// expiry, RUN_FAILED on failure, anonymous user fallback); the save/list/get
// trio delegates to a configured store else falls back; opsMetricSnapshots
// shapes recorded metric events.

const run = (over: Partial<AgentRunRecord> = {}): AgentRunRecord =>
  ({ createdAt: new Date("2026-05-01T00:00:00Z"), error: null, id: "r1", input: "hi", model: "qwen", status: "completed", userId: "u1", ...over }) as unknown as AgentRunRecord;
const opts = (o: Partial<CompatibilityRouteOptions> = {}): CompatibilityRouteOptions => o as CompatibilityRouteOptions;

describe("debugReplayResponse", () => {
  it("maps a completed run with a 30-day expiry and the captured prompt", () => {
    expect(debugReplayResponse(run())).toMatchObject({
      capturedAt: "2026-05-01T00:00:00.000Z",
      errorCode: null,
      errorMessage: null,
      expiresAt: "2026-05-31T00:00:00.000Z", // createdAt + 30 days
      id: "r1",
      modelId: "qwen",
      userHash: "u1",
      userPrompt: "hi"
    });
  });

  it("sets RUN_FAILED + the error message for a failed run, and 'anonymous' when no user", () => {
    const failed = debugReplayResponse(run({ error: "boom", status: "failed" }));
    expect(failed).toMatchObject({ errorCode: "RUN_FAILED", errorMessage: "boom" });
    expect(debugReplayResponse(run({ userId: undefined })).userHash).toBe("anonymous");
  });
});

describe("opsMetricSnapshots", () => {
  it("shapes each recorded event (name from event.name, else 'unknown') and is empty without observability", () => {
    const snapshots = opsMetricSnapshots(opts({
      admin: { observability: { metrics: { recordedEvents: () => [{ name: "latency" }, { type: "x" }] } } } as unknown as CompatibilityRouteOptions["admin"]
    }));
    expect(snapshots.map((s) => s.name)).toEqual(["latency", "unknown"]);
    expect(snapshots[0]).toMatchObject({ measurements: { count: 1 }, meterCount: 1, series: [] });
    expect(opsMetricSnapshots(opts({}))).toEqual([]);
  });
});

describe("debug-replay capture store delegation", () => {
  const store = {
    getDebugReplayCapture: async (id: string) => (id === "x" ? { id: "x" } : undefined),
    listDebugReplayCaptures: async (limit: number) => [{ id: "a" }].slice(0, limit),
    saveDebugReplayCapture: async (record: Record<string, unknown>) => ({ ...record, saved: true })
  } as unknown as CompatibilityRouteOptions["debugReplayCaptureStore"];

  it("delegates to the configured store and falls back cleanly when absent", async () => {
    expect(await saveDebugReplayCapture(opts({ debugReplayCaptureStore: store }), { id: "r1" })).toEqual({ id: "r1", saved: true });
    expect(await saveDebugReplayCapture(opts({}), { id: "r1" })).toEqual({ id: "r1" }); // fallback = passthrough

    expect(await listDebugReplayCaptures(opts({ debugReplayCaptureStore: store }), 1)).toEqual([{ id: "a" }]);
    expect(await listDebugReplayCaptures(opts({}), 5)).toEqual([]); // fallback = empty

    expect(await getDebugReplayCapture(opts({ debugReplayCaptureStore: store }), "x")).toEqual({ id: "x" });
    expect(await getDebugReplayCapture(opts({}), "x")).toBeUndefined(); // fallback = undefined
  });
});
