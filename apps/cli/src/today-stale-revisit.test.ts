import { describe, expect, it } from "vitest";

import { formatEpisodeRevisitLine, formatStaleTasksSection, selectEpisodeToRevisit, selectStaleTasks } from "./today-stale-revisit.js";

const NOW = Date.parse("2026-05-28T00:00:00Z");
const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

describe("selectStaleTasks", () => {
  const task = (id: string, title: string, status: string, createdAt: string, dueAt?: string) =>
    ({ id, title, status, createdAt, ...(dueAt ? { dueAt } : {}) });

  it("picks open + undated tasks older than the threshold, oldest first", () => {
    const stale = selectStaleTasks([
      task("1", "fresh", "open", daysAgo(3)),
      task("2", "old undated", "open", daysAgo(40)),
      task("3", "older undated", "open", daysAgo(90))
    ], NOW);
    expect(stale.map((t) => t.title)).toEqual(["older undated", "old undated"]);
  });

  it("excludes dated and done tasks", () => {
    const stale = selectStaleTasks([
      task("1", "old but dated", "open", daysAgo(40), "2026-06-01T00:00:00Z"),
      task("2", "old but done", "done", daysAgo(40)),
      task("3", "genuinely stale", "open", daysAgo(40))
    ], NOW);
    expect(stale.map((t) => t.title)).toEqual(["genuinely stale"]);
  });
});

describe("selectEpisodeToRevisit + formatters", () => {
  const ep = (summary: string, endedDaysAgo: number) => ({ summary, endedAt: daysAgo(endedDaysAgo) });

  it("returns the due episode with the largest interval crossed", () => {
    const got = selectEpisodeToRevisit([ep("recent", 3), ep("not due", 5), ep("old decision", 90)], NOW);
    expect(got?.summary).toBe("old decision");
    expect(got?.intervalDays).toBe(90);
  });

  it("formats a stale-tasks section and an episode-revisit line (singular day)", () => {
    expect(formatStaleTasksSection([])).toBe("");
    expect(formatStaleTasksSection([{ id: "1", title: "renew the domain", ageDays: 42.7 }])).toContain("[42d] renew the domain");
    expect(formatEpisodeRevisitLine(undefined)).toBe("");
    expect(formatEpisodeRevisitLine({ summary: "cut the Q3 budget", intervalDays: 1, ageDays: 1.4 })).toContain("💭 1 day ago: cut the Q3 budget");
  });
});
