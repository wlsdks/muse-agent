import { describe, expect, it } from "vitest";

import { createProactiveRuntimeStatusStore } from "../src/proactive-runtime-status.js";

describe("createProactiveRuntimeStatusStore", () => {
  it("starts empty and keeps only bounded, non-negative integer metadata", () => {
    const store = createProactiveRuntimeStatusStore();
    expect(store.get()).toBeNull();

    store.record({
      decision: "error",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      imminentCount: Number.POSITIVE_INFINITY,
      firedCount: -4.8,
      suppressedCount: 10_000.9,
      errorCount: Number.NaN,
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z"
    });

    expect(store.get()).toEqual({
      lastDecision: "error",
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastRoute: {
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      },
      lastImminentCount: 0,
      lastFiredCount: 0,
      lastSuppressedCount: 9_999,
      lastErrorCount: 0,
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z"
    });
  });

  it("replaces the observation and clears an expired-session field when omitted", () => {
    const store = createProactiveRuntimeStatusStore();
    store.record({
      decision: "session-locked",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z"
    });
    store.record({ decision: "no-imminent", observedAtIso: "2026-08-08T01:13:03.000Z" });

    expect(store.get()).toEqual({
      lastDecision: "no-imminent",
      lastObservedAtIso: "2026-08-08T01:13:03.000Z",
      lastRoute: {
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      },
      lastImminentCount: 0,
      lastFiredCount: 0,
      lastSuppressedCount: 0,
      lastErrorCount: 0
    });
  });
});
