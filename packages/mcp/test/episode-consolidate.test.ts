import { describe, expect, it } from "vitest";

import { planEpisodeConsolidation, type PersistedEpisode } from "../src/personal-episodes-store.js";

function ep(id: string, endedAt: string, summary: string, importance?: number): PersistedEpisode {
  return { id, userId: "stark", startedAt: endedAt, endedAt, summary, ...(importance ? { importance } : {}) };
}

describe("planEpisodeConsolidation", () => {
  it("pairs near-duplicate summaries, keeping the higher-importance one", () => {
    const episodes = [
      ep("a", "2026-05-01T00:00:00Z", "Discussed the quarterly tax filing and the deadline", 3),
      ep("b", "2026-05-02T00:00:00Z", "Discussed the quarterly tax filing and its deadline", 7),
      ep("c", "2026-05-03T00:00:00Z", "Planned a trip to Busan with the family")
    ];
    const plan = planEpisodeConsolidation(episodes, { threshold: 0.6 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kept: "b", archived: "a" });
    expect(plan[0]!.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it("breaks an importance tie by recency (keeps the newer)", () => {
    const episodes = [
      ep("old", "2026-05-01T00:00:00Z", "Reviewed the budget spreadsheet line by line"),
      ep("new", "2026-05-09T00:00:00Z", "Reviewed the budget spreadsheet line by line")
    ];
    const [pair] = planEpisodeConsolidation(episodes, { threshold: 0.8 });
    expect(pair).toMatchObject({ kept: "new", archived: "old" });
  });

  it("leaves distinct memories untouched and never archives the same id twice", () => {
    const episodes = [
      ep("x", "2026-05-01T00:00:00Z", "Booked the dentist appointment for Tuesday"),
      ep("y", "2026-05-02T00:00:00Z", "Researched noise-cancelling headphones"),
      ep("z", "2026-05-03T00:00:00Z", "Talked about the weather")
    ];
    expect(planEpisodeConsolidation(episodes, { threshold: 0.85 })).toEqual([]);
  });
});
