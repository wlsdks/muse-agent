import { describe, expect, it } from "vitest";

import { createFollowupRuntimeStatusStore } from "./followup-runtime-status.js";

describe("createFollowupRuntimeStatusStore", () => {
  it("keeps only the latest bounded metadata and no sensitive runtime fields", () => {
    const store = createFollowupRuntimeStatusStore();
    store.record({
      decision: "error",
      observedAtIso: "2026-08-08T01:02:03.000Z",
      dueCount: 10_000,
      deliveredCount: -4,
      firedCount: Number.POSITIVE_INFINITY,
      errorCount: Number.NaN
    });

    expect(store.get()).toEqual({
      lastDecision: "error",
      lastObservedAtIso: "2026-08-08T01:02:03.000Z",
      lastDueCount: 9_999,
      lastDeliveredCount: 0,
      lastFiredCount: 0,
      lastErrorCount: 0
    });
    expect(JSON.stringify(store.get())).not.toContain("follow-up summary");
    expect(JSON.stringify(store.get())).not.toContain("raw error");
    expect(JSON.stringify(store.get())).not.toContain("provider-id");
    expect(JSON.stringify(store.get())).not.toContain("destination");
    expect(JSON.stringify(store.get())).not.toContain("credential");
    expect(JSON.stringify(store.get())).not.toContain("file-path");
  });

  it("replaces the latest observation without retaining history", () => {
    const store = createFollowupRuntimeStatusStore();
    store.record({ decision: "no-due", observedAtIso: "2026-08-08T01:00:00.000Z" });
    store.record({ decision: "completed", observedAtIso: "2026-08-08T01:01:00.000Z", dueCount: 1 });

    expect(store.get()).toEqual({
      lastDecision: "completed",
      lastObservedAtIso: "2026-08-08T01:01:00.000Z",
      lastDueCount: 1,
      lastDeliveredCount: 0,
      lastFiredCount: 0,
      lastErrorCount: 0
    });
  });
});
