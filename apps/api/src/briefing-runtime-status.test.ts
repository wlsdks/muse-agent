import { describe, expect, it } from "vitest";

import { createBriefingRuntimeStatusStore } from "./briefing-runtime-status.js";

describe("createBriefingRuntimeStatusStore", () => {
  it("starts empty and keeps only the latest bounded observation", () => {
    const store = createBriefingRuntimeStatusStore();

    expect(store.get()).toBeNull();
    store.record({
      decision: "error",
      deliveredCount: -4,
      errorCount: 10_000,
      imminentCount: Number.POSITIVE_INFINITY,
      observedAtIso: "2026-08-08T01:02:03.000Z"
    });

    expect(store.get()).toEqual({
      lastDecision: "error",
      lastDeliveredCount: 0,
      lastErrorCount: 9_999,
      lastImminentCount: 0,
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastRoute: {
        destination: null,
        localOnly: false,
        providerId: null,
        reason: "paired-route-inspection-unavailable",
        source: null,
        status: "unconfigured"
      }
    });
  });

  it("sanitizes a route and never retains raw provider or error fields", () => {
    const store = createBriefingRuntimeStatusStore();
    store.record({
      decision: "route-unavailable",
      lastRoute: {
        destination: null,
        localOnly: true,
        providerId: null,
        reason: "remote-route-blocked-by-local-only",
        source: "explicit-config",
        status: "blocked-local-only",
        provider: { credential: "secret" },
        rawError: "private detail"
      } as never,
      observedAtIso: "2026-08-08T01:02:03.000Z"
    });

    expect(store.get()?.lastRoute).toEqual({
      destination: null,
      localOnly: true,
      providerId: null,
      reason: "remote-route-blocked-by-local-only",
      source: "explicit-config",
      status: "blocked-local-only"
    });
    expect(JSON.stringify(store.get())).not.toContain("secret");
    expect(JSON.stringify(store.get())).not.toContain("private detail");
  });

  it("preserves the last route across a terminal observation without route data", () => {
    const store = createBriefingRuntimeStatusStore();
    store.record({
      decision: "delivered",
      deliveredCount: 1,
      lastRoute: {
        destination: "owner-a",
        localOnly: false,
        providerId: "telegram",
        reason: null,
        source: "explicit-config",
        status: "resolved"
      },
      observedAtIso: "2026-08-08T01:02:03.000Z"
    });
    store.record({ decision: "quiet-hours", observedAtIso: "2026-08-08T01:03:03.000Z" });

    expect(store.get()).toMatchObject({
      lastDecision: "quiet-hours",
      lastObservedAtIso: "2026-08-08T01:03:03.000Z",
      lastRoute: { destination: "owner-a", providerId: "telegram" }
    });
  });
});
