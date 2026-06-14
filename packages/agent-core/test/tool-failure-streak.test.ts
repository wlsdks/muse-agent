import { describe, expect, it } from "vitest";

import { ToolFailureStreakTracker, TOOL_FAILURE_STREAK_LIMIT } from "../src/index.js";

// Cascade-failure circuit breaker (arXiv:2509.25370): a tool failing N times in a
// row is withheld so it can't burn the whole step budget.

describe("ToolFailureStreakTracker", () => {
  it("trips after LIMIT consecutive failures", () => {
    const t = new ToolFailureStreakTracker();
    t.record("flaky", "failed");
    t.record("flaky", "failed");
    expect(t.tripped("flaky")).toBe(false); // 2 < 3
    t.record("flaky", "failed");
    expect(t.tripped("flaky")).toBe(true); // 3
  });

  it("a success RESETS the streak (recovered tool is not withheld)", () => {
    const t = new ToolFailureStreakTracker();
    t.record("flaky", "failed");
    t.record("flaky", "failed");
    t.record("flaky", "completed"); // reset
    t.record("flaky", "failed");
    expect(t.tripped("flaky")).toBe(false); // only 1 since the reset
  });

  it("counts per-tool independently", () => {
    const t = new ToolFailureStreakTracker();
    t.record("a", "failed");
    t.record("a", "failed");
    t.record("a", "failed");
    t.record("b", "failed");
    expect(t.tripped("a")).toBe(true);
    expect(t.tripped("b")).toBe(false);
  });

  it("a non-completed status other than 'failed' (e.g. blocked) also counts toward the streak", () => {
    const t = new ToolFailureStreakTracker();
    t.record("x", "failed");
    t.record("x", "blocked");
    t.record("x", "failed");
    expect(t.tripped("x")).toBe(true);
  });

  it("exports the default limit", () => {
    expect(TOOL_FAILURE_STREAK_LIMIT).toBe(3);
  });
});
