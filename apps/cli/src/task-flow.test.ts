import { describe, expect, it } from "vitest";

import { analyzeTaskFlow, formatTaskFlow } from "./task-flow.js";

const NOW = new Date("2026-06-05T12:00:00.000Z");
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("analyzeTaskFlow — Little's Law queue accounting", () => {
  it("counts arrivals + departures inside the window and flags a growing backlog", () => {
    const tasks = [
      { createdAt: daysAgo(2), status: "open" as const },
      { createdAt: daysAgo(3), status: "open" as const },
      { createdAt: daysAgo(1), status: "open" as const },
      { completedAt: daysAgo(1), createdAt: daysAgo(5), status: "done" as const }
    ];
    const stats = analyzeTaskFlow(tasks, NOW, 7);
    expect(stats.created).toBe(4); // all 4 created within 7 days
    expect(stats.completed).toBe(1);
    expect(stats.net).toBe(3);
    expect(stats.trend).toBe("growing");
    expect(stats.openNow).toBe(3);
  });

  it("computes the average lead time W of tasks completed in the window", () => {
    const tasks = [
      { completedAt: daysAgo(1), createdAt: daysAgo(5), status: "done" as const }, // 4 days
      { completedAt: daysAgo(2), createdAt: daysAgo(8), status: "done" as const }  // 6 days
    ];
    expect(analyzeTaskFlow(tasks, NOW, 7).avgLeadDays).toBeCloseTo(5, 5); // (4+6)/2
  });

  it("excludes events OUTSIDE the window (old creations, old completions)", () => {
    const tasks = [
      { createdAt: daysAgo(20), status: "open" as const },                          // created too long ago
      { completedAt: daysAgo(20), createdAt: daysAgo(25), status: "done" as const }  // completed too long ago
    ];
    const stats = analyzeTaskFlow(tasks, NOW, 7);
    expect(stats.created).toBe(0);
    expect(stats.completed).toBe(0);
    expect(stats.openNow).toBe(1); // openNow is current state, not window-bound
    expect(stats.avgLeadDays).toBeUndefined();
  });

  it("a shrinking backlog (more done than created in window) reads 'shrinking'", () => {
    const tasks = [
      { completedAt: daysAgo(1), createdAt: daysAgo(10), status: "done" as const },
      { completedAt: daysAgo(2), createdAt: daysAgo(10), status: "done" as const },
      { createdAt: daysAgo(1), status: "open" as const }
    ];
    expect(analyzeTaskFlow(tasks, NOW, 7).trend).toBe("shrinking"); // 1 created, 2 completed
  });

  it("steady when arrivals equal departures; clamps a non-finite/zero window to >=1", () => {
    expect(analyzeTaskFlow([], NOW, 7).trend).toBe("steady");
    expect(analyzeTaskFlow([], NOW, Number.NaN).windowDays).toBe(7);
    expect(analyzeTaskFlow([], NOW, 0).windowDays).toBe(1);
  });

  it("skips an unparseable timestamp without crashing", () => {
    const tasks = [{ createdAt: "not-a-date", status: "open" as const }];
    const stats = analyzeTaskFlow(tasks, NOW, 7);
    expect(stats.created).toBe(0);
    expect(stats.openNow).toBe(1);
  });
});

describe("formatTaskFlow", () => {
  it("renders the growing-backlog warning with the Little's-Law ratio", () => {
    const out = formatTaskFlow({ avgLeadDays: 4, completed: 2, created: 6, net: 4, openNow: 9, trend: "growing", windowDays: 7 });
    expect(out).toContain("backlog GROWING");
    expect(out).toContain("3×"); // 6/2
    expect(out).toContain("Little's Law");
    expect(out).toContain("Avg time to done: 4 days");
  });

  it("renders the shrinking message and omits lead time when none completed", () => {
    const out = formatTaskFlow({ completed: 0, created: 0, net: 0, openNow: 0, trend: "steady", windowDays: 14 });
    expect(out).toContain("holding steady");
    expect(out).not.toContain("lead time");
  });
});
