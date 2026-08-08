import { describe, expect, it } from "vitest";

import { createReminderRuntimeStatusStore } from "./reminder-runtime-status.js";

describe("createReminderRuntimeStatusStore", () => {
  it("starts empty and stores only bounded runtime metadata", () => {
    const store = createReminderRuntimeStatusStore();
    expect(store.get()).toBeNull();

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
    expect(JSON.stringify(store.get())).not.toContain("raw error");
    expect(JSON.stringify(store.get())).not.toContain("reminder text");
    expect(JSON.stringify(store.get())).not.toContain("provider-id");
    expect(JSON.stringify(store.get())).not.toContain("credential");
    expect(JSON.stringify(store.get())).not.toContain("file-path");
  });

  it("replaces the latest observation without keeping runtime history", () => {
    const store = createReminderRuntimeStatusStore();
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
