import { describe, expect, it } from "vitest";

import { recentFeedHeadlines } from "./commands-ask.js";

const feeds = [
  {
    entries: [
      { publishedAt: "2026-05-20T00:00:00.000Z", summary: "s-hn-old", title: "HN old" },
      { publishedAt: "2026-05-25T00:00:00.000Z", summary: "s-hn-new", title: "HN new" }
    ],
    name: "Hacker News"
  },
  {
    entries: [{ publishedAt: "2026-05-24T00:00:00.000Z", summary: "s-rust", title: "Rust release" }],
    name: "Rust Blog"
  }
];

describe("recentFeedHeadlines — SB-1/G2: ground `ask` on watched feeds", () => {
  it("merges entries across all feeds, newest-first, capped at the limit, keeping the feed name", () => {
    const out = recentFeedHeadlines(feeds, 2);
    expect(out.map((h) => h.title)).toEqual(["HN new", "Rust release"]);
    expect(out[0]).toMatchObject({ feedName: "Hacker News", title: "HN new" });
    expect(out).toHaveLength(2);
  });

  it("returns empty for no feeds or a non-positive limit", () => {
    expect(recentFeedHeadlines([], 5)).toEqual([]);
    expect(recentFeedHeadlines(feeds, 0)).toEqual([]);
  });
});
