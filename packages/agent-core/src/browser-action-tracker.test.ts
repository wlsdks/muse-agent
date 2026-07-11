import { describe, expect, it } from "vitest";

import { createBrowserActionTracker } from "./browser-action-tracker.js";

describe("createBrowserActionTracker — bounds a task's browser actions", () => {
  it("allows and labels the 1st/2nd/3rd action of a cap-3 tracker, refuses the 4th, and used() never advances past the cap", () => {
    const tracker = createBrowserActionTracker(3);

    const first = tracker.tryConsume();
    expect(first).toMatchObject({ allowed: true, label: "actions_used 1/3" });
    expect(tracker.used()).toBe(1);

    const second = tracker.tryConsume();
    expect(second).toMatchObject({ allowed: true, label: "actions_used 2/3" });
    expect(tracker.used()).toBe(2);

    const third = tracker.tryConsume();
    expect(third).toMatchObject({ allowed: true, label: "actions_used 3/3" });
    expect(tracker.used()).toBe(3);

    const fourth = tracker.tryConsume();
    expect(fourth.allowed).toBe(false);
    expect(fourth.refusal).toBeTruthy();
    expect(String(fourth.refusal)).toMatch(/cap|budget|exhaust/i);
    expect(tracker.used()).toBe(3);

    // Repeated refusals never advance the counter either.
    const fifth = tracker.tryConsume();
    expect(fifth.allowed).toBe(false);
    expect(tracker.used()).toBe(3);
  });

  it("carries a near-cap warning on the (max-1)th consume — 2nd of 3", () => {
    const tracker = createBrowserActionTracker(3);
    tracker.tryConsume();
    const second = tracker.tryConsume();
    expect(second.allowed).toBe(true);
    expect(second.warning).toBeTruthy();
  });

  it("the 1st of 3 (not near cap yet) carries no warning", () => {
    const tracker = createBrowserActionTracker(3);
    const first = tracker.tryConsume();
    expect(first.allowed).toBe(true);
    expect(first.warning).toBeUndefined();
  });

  it("a cap of 1 allows exactly one action then refuses every subsequent call", () => {
    const tracker = createBrowserActionTracker(1);
    const only = tracker.tryConsume();
    expect(only).toMatchObject({ allowed: true, label: "actions_used 1/1" });
    const next = tracker.tryConsume();
    expect(next.allowed).toBe(false);
    expect(tracker.used()).toBe(1);
  });
});
