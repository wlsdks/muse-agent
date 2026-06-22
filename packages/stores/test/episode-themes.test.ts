import { describe, expect, it } from "vitest";

import { detectTopicAbsence, recurringThemes, type PersistedEpisode } from "../src/personal-episodes-store.js";

function ep(id: string, endedAt: string, topics: readonly string[]): PersistedEpisode {
  return { id, userId: "stark", startedAt: endedAt, endedAt, summary: `s-${id}`, topics };
}

describe("detectTopicAbsence — learned-habit absence (inverse of recurringThemes)", () => {
  const now = new Date("2026-06-04T00:00:00Z");
  const dayAgo = (n: number): string => new Date(now.getTime() - n * 86_400_000).toISOString();

  it("flags a topic gone silent FAR past its own median cadence, citing the last episode", () => {
    // every ~4 days for 4 sessions, then silent 28 days
    const episodes = [ep("a1", dayAgo(40), ["Apollo"]), ep("a2", dayAgo(36), ["Apollo"]), ep("a3", dayAgo(32), ["Apollo"]), ep("a4", dayAgo(28), ["Apollo"])];
    const [absence] = detectTopicAbsence(episodes, { now });
    expect(absence?.topic).toBe("Apollo");
    expect(absence?.typicalGapDays).toBe(4);
    expect(absence?.silentDays).toBe(28);
    expect(absence?.occurrences).toBe(4);
    expect(absence?.lastSeen).toBe(dayAgo(28)); // citation anchor = most-recent episode
    expect(absence?.lastSummary).toBe("s-a4");
  });

  it("does NOT flag a topic still within a normal gap of its cadence", () => {
    // every ~4 days, last seen 5 days ago — a normal gap, not an anomaly
    const episodes = [ep("b1", dayAgo(13), ["Hermes"]), ep("b2", dayAgo(9), ["Hermes"]), ep("b3", dayAgo(5), ["Hermes"])];
    expect(detectTopicAbsence(episodes, { now })).toHaveLength(0);
  });

  it("needs enough history to baseline a cadence (a topic seen twice is NOT flagged)", () => {
    const episodes = [ep("c1", dayAgo(60), ["OnceOff"]), ep("c2", dayAgo(56), ["OnceOff"])];
    expect(detectTopicAbsence(episodes, { now })).toHaveLength(0);
  });

  it("honours the absolute floor — a fast daily cadence gone silent ONE day does not fire", () => {
    const episodes = [ep("d1", dayAgo(3), ["standup"]), ep("d2", dayAgo(2), ["standup"]), ep("d3", dayAgo(1), ["standup"])];
    expect(detectTopicAbsence(episodes, { now })).toHaveLength(0);
  });

  it("returns [] for topic-less episodes", () => {
    expect(detectTopicAbsence([ep("e1", dayAgo(40), []), ep("e2", dayAgo(30), [])], { now })).toHaveLength(0);
  });
});

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
