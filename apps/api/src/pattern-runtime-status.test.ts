import { describe, expect, it } from "vitest";

import {
  createPatternRuntimeStatusStore,
  recordPatternRuntimeNotConfigured
} from "./pattern-runtime-status.js";

describe("pattern runtime status store", () => {
  it("keeps only bounded allowlisted metadata", () => {
    const store = createPatternRuntimeStatusStore();
    store.record({
      decision: "fired",
      observedAtIso: "2026-08-09T00:00:00.000Z",
      fireableCount: 10_000,
      deliveredCount: -1,
      firedCount: Number.POSITIVE_INFINITY,
      errorCount: 4.9
    });

    expect(store.get()).toEqual({
      lastDecision: "fired",
      lastObservedAtIso: "2026-08-09T00:00:00.000Z",
      lastFireableCount: 9_999,
      lastDeliveredCount: 0,
      lastFiredCount: 0,
      lastErrorCount: 4
    });
    expect(JSON.stringify(store.get())).not.toMatch(/pattern|suggestion|provider|destination|error text|credential|path/u);
  });

  it("replaces the previous observation instead of accumulating history", () => {
    const store = createPatternRuntimeStatusStore();
    store.record({ decision: "completed", observedAtIso: "2026-08-09T00:00:00.000Z", fireableCount: 3 });
    store.record({ decision: "no-fireable", observedAtIso: "2026-08-09T00:01:00.000Z" });

    expect(store.get()).toEqual({
      lastDecision: "no-fireable",
      lastObservedAtIso: "2026-08-09T00:01:00.000Z",
      lastFireableCount: 0,
      lastDeliveredCount: 0,
      lastFiredCount: 0,
      lastErrorCount: 0
    });
  });

  it("isolates a failing status writer and records the global not-configured state safely", () => {
    const calls: string[] = [];
    const failing = {
      get: () => null,
      record: () => {
        calls.push("attempted");
        throw new Error("status store failed");
      }
    };

    expect(() => recordPatternRuntimeNotConfigured(failing)).not.toThrow();
    expect(calls).toEqual(["attempted"]);
  });
});
