import { describe, expect, it } from "vitest";

import { formatBriefFeedLines, selectBriefFeedHeadlines } from "./brief-feeds.js";
import { FEEDS_STORE_SCHEMA_VERSION, type FeedsStore } from "./feeds-store.js";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const entry = (id: string, title: string, ageHours: number) => ({
  id,
  link: `https://x/${id}`,
  publishedAt: hoursAgo(ageHours),
  summary: "",
  title
});

const store = (feeds: FeedsStore["feeds"]): FeedsStore => ({ feeds, version: FEEDS_STORE_SCHEMA_VERSION });

describe("selectBriefFeedHeadlines", () => {
  it("returns the most recent headlines across feeds, newest first, capped at limit", () => {
    const s = store([
      { entries: [entry("a", "Old news", 30), entry("b", "Tech drop", 2)], id: "f1", name: "Tech", url: "u1" },
      { entries: [entry("c", "Market move", 1)], id: "f2", name: "Biz", url: "u2" }
    ]);
    const picked = selectBriefFeedHeadlines(s, NOW, { limit: 2, withinHours: 24 });
    expect(picked.map((h) => h.title)).toEqual(["Market move", "Tech drop"]); // 1h before 2h; the 30h-old one excluded by window
    expect(picked[0]!.feedTitle).toBe("Biz");
  });

  it("excludes entries outside the window and empty titles, returns [] when nothing recent", () => {
    const s = store([{ entries: [entry("a", "Stale", 100), entry("b", "  ", 1)], id: "f1", name: "Tech", url: "u1" }]);
    expect(selectBriefFeedHeadlines(s, NOW, { withinHours: 24 })).toEqual([]);
    expect(selectBriefFeedHeadlines(store([]), NOW)).toEqual([]);
  });
});

describe("formatBriefFeedLines", () => {
  it("renders a 📰 block with the feed name, or empty string when none", () => {
    const out = formatBriefFeedLines([{ feedTitle: "Tech", link: "x", title: "Big news" }]);
    expect(out).toContain("📰 In your feeds:");
    expect(out).toContain("· Big news (Tech)");
    expect(formatBriefFeedLines([])).toBe("");
  });
});
