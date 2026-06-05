import { describe, expect, it } from "vitest";

import { filterEpisodesSince, parseLimit, resolveEpisodeSinceCutoff } from "./commands-episode.js";

describe("commands-episode parseLimit — strict-parse convention", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseLimit(undefined, 10, 200)).toBe(10);
    expect(parseLimit("", 10, 200)).toBe(10);
    expect(parseLimit("   ", 10, 200)).toBe(10);
  });

  it("parses a valid value and caps it", () => {
    expect(parseLimit("5", 10, 200)).toBe(5);
    expect(parseLimit(" 7 ", 10, 200)).toBe(7);
    expect(parseLimit("999", 10, 200)).toBe(200);
    expect(parseLimit("3.9", 10, 200)).toBe(3);
  });

  it("throws on an explicitly invalid value instead of silently using the default", () => {
    expect(() => parseLimit("abc", 10, 200)).toThrow(/--limit must be a positive number/u);
    expect(() => parseLimit("0", 10, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("-2", 10, 200)).toThrow(/positive number/u);
    expect(() => parseLimit("10x", 10, 200), "unit-slip must not silently degrade to the 10 default — that's the exact silent-fallback bug").toThrow(/got '10x'/u);
    expect(() => parseLimit("5 entries", 10, 200)).toThrow(/got '5 entries'/u);
  });
});

describe("resolveEpisodeSinceCutoff — --since / --days window", () => {
  const NOW = Date.parse("2026-06-10T12:00:00Z");
  const day = 86_400_000;

  it("--days N → now minus N days; --since ISO → that instant", () => {
    expect(resolveEpisodeSinceCutoff({ days: "7" }, NOW).cutoffMs).toBe(NOW - 7 * day);
    expect(resolveEpisodeSinceCutoff({ since: "2026-06-01" }, NOW).cutoffMs).toBe(Date.parse("2026-06-01"));
  });

  it("no options → no cutoff (no filter)", () => {
    expect(resolveEpisodeSinceCutoff({}, NOW)).toEqual({});
  });

  it("rejects both-at-once, a non-date --since, and a zero/non-numeric --days", () => {
    expect(resolveEpisodeSinceCutoff({ days: "7", since: "2026-06-01" }, NOW).error).toMatch(/only one/u);
    expect(resolveEpisodeSinceCutoff({ since: "last monday" }, NOW).error).toMatch(/ISO date/u);
    expect(resolveEpisodeSinceCutoff({ days: "0" }, NOW).error).toMatch(/positive whole number/u);
    expect(resolveEpisodeSinceCutoff({ days: "7x" }, NOW).error).toMatch(/positive whole number/u);
  });
});

describe("filterEpisodesSince — keep sessions ended on/after the cutoff", () => {
  const NOW = Date.parse("2026-06-10T12:00:00Z");
  const day = 86_400_000;
  const episodes = [
    { endedAt: new Date(NOW - 2 * day).toISOString(), id: "recent" },
    { endedAt: new Date(NOW - 10 * day).toISOString(), id: "old" },
    { endedAt: "not-a-date", id: "broken" }
  ];

  it("keeps only on/after the cutoff, excluding older + unparseable", () => {
    const cutoff = NOW - 7 * day;
    expect(filterEpisodesSince(episodes, cutoff).map((e) => e.id)).toEqual(["recent"]);
    expect(filterEpisodesSince(episodes, NOW - 30 * day).map((e) => e.id)).toEqual(["recent", "old"]);
  });
});
