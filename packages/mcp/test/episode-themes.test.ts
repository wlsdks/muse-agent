import { describe, expect, it } from "vitest";

import { recurringThemes, type PersistedEpisode } from "../src/personal-episodes-store.js";

function ep(id: string, endedAt: string, topics: readonly string[]): PersistedEpisode {
  return { id, userId: "stark", startedAt: endedAt, endedAt, summary: `s-${id}`, topics };
}

describe("recurringThemes", () => {
  it("surfaces topics recurring across >= minCount episodes, most-frequent first", () => {
    const episodes = [
      ep("1", "2026-05-01T00:00:00Z", ["taxes", "travel"]),
      ep("2", "2026-05-02T00:00:00Z", ["Taxes", "health"]),
      ep("3", "2026-05-03T00:00:00Z", ["taxes", "travel"])
    ];
    const themes = recurringThemes(episodes, { minCount: 2 });
    expect(themes.map((t) => t.topic)).toEqual(["taxes", "travel"]);
    expect(themes[0]).toMatchObject({ topic: "taxes", count: 3, lastSeen: "2026-05-03T00:00:00Z" });
    expect(themes[1]).toMatchObject({ topic: "travel", count: 2, lastSeen: "2026-05-03T00:00:00Z" });
  });

  it("counts a topic once per episode even if repeated within it, case-insensitively", () => {
    const episodes = [
      ep("1", "2026-05-01T00:00:00Z", ["Budget", "budget", "BUDGET"]),
      ep("2", "2026-05-02T00:00:00Z", ["budget"])
    ];
    const [theme] = recurringThemes(episodes, { minCount: 2 });
    expect(theme).toMatchObject({ topic: "Budget", count: 2 });
  });

  it("excludes one-off topics and respects the limit", () => {
    const episodes = [
      ep("1", "2026-05-01T00:00:00Z", ["a", "b"]),
      ep("2", "2026-05-02T00:00:00Z", ["a", "b"]),
      ep("3", "2026-05-03T00:00:00Z", ["c"])
    ];
    expect(recurringThemes(episodes, { minCount: 2, limit: 1 })).toHaveLength(1);
    expect(recurringThemes(episodes, { minCount: 2 }).map((t) => t.topic)).not.toContain("c");
  });

  it("ignores blank/whitespace topics and episodes with no topics", () => {
    const episodes = [
      ep("1", "2026-05-01T00:00:00Z", ["  ", "music"]),
      { id: "2", userId: "stark", startedAt: "x", endedAt: "2026-05-02T00:00:00Z", summary: "s" },
      ep("3", "2026-05-03T00:00:00Z", ["music"])
    ];
    expect(recurringThemes(episodes, { minCount: 2 }).map((t) => t.topic)).toEqual(["music"]);
  });
});
