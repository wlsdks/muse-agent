import { describe, expect, it } from "vitest";

import { createProactiveRuntimeStatusStore } from "../src/proactive-runtime-status.js";

describe("createProactiveRuntimeStatusStore", () => {
  it("starts empty and keeps only bounded, non-negative integer metadata", () => {
    const store = createProactiveRuntimeStatusStore();
    expect(store.get()).toBeNull();

    store.record({
      availability: "observed",
      decision: "error",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      imminentCount: Number.POSITIVE_INFINITY,
      firedCount: -4.8,
      suppressedCount: 10_000.9,
      errorCount: Number.NaN,
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z",
      phase: "tick"
    });

    expect(store.get()).toEqual({
      availability: "observed",
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
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z",
      phase: "tick"
    });
  });

  it("replaces the observation and clears an expired-session field when omitted", () => {
    const store = createProactiveRuntimeStatusStore();
    store.record({
      availability: "observed",
      decision: "session-locked",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      sessionLockedUntilIso: "2026-08-08T01:12:03.000Z",
      phase: "tick"
    });
    store.record({ availability: "observed", decision: "no-imminent", observedAtIso: "2026-08-08T01:13:03.000Z", phase: "tick" });

    expect(store.get()).toEqual({
      availability: "observed",
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
      lastErrorCount: 0,
      phase: "tick"
    });
  });
});
