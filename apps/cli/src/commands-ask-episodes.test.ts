import { describe, expect, it } from "vitest";

import { rankEpisodeHits } from "@muse/recall";

const episodes = [
  { embedding: [1, 0, 0], id: "e1", summary: "discussed the Q3 budget plan" },
  { embedding: [0, 1, 0], id: "e2", summary: "talked about a vacation in Italy" },
  { embedding: [0.9, 0.1, 0], id: "e3", summary: "reviewed the API contract" }
];

describe("rankEpisodeHits — SB-1: ground `ask` on past-session summaries", () => {
  it("ranks episodes by cosine similarity to the query and caps at top-K", () => {
    const hits = rankEpisodeHits([1, 0, 0], episodes, 2);
    expect(hits.map((h) => h.id)).toEqual(["e1", "e3"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("returns empty for no episodes or a non-positive top-K", () => {
    expect(rankEpisodeHits([1, 0, 0], [], 3)).toEqual([]);
    expect(rankEpisodeHits([1, 0, 0], episodes, 0)).toEqual([]);
  });
});

describe("rankEpisodeHits — recency decay (Generative Agents, arXiv 2304.03442)", () => {
  const NOW = Date.parse("2026-05-28T00:00:00Z");
  const daysAgo = (n: number): string => new Date(NOW - n * 86_400_000).toISOString();

  it("breaks an otherwise-equal-relevance tie toward the more recent session", () => {
    const same = [
      { embedding: [1, 0, 0], endedAt: daysAgo(30), id: "old", summary: "older session about X" },
      { embedding: [1, 0, 0], endedAt: daysAgo(1), id: "new", summary: "recent session about X" }
    ];
    const hits = rankEpisodeHits([1, 0, 0], same, 2, NOW);
    expect(hits.map((h) => h.id)).toEqual(["new", "old"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("is backward-compatible: episodes without endedAt rank purely by cosine", () => {
    const hits = rankEpisodeHits([1, 0, 0], [
      { embedding: [1, 0, 0], id: "a", summary: "a" },
      { embedding: [0.9, 0.1, 0], id: "b", summary: "b" }
    ], 2, NOW);
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("does not let a much stronger cosine be overturned by recency alone (bump is bounded)", () => {
    const hits = rankEpisodeHits([1, 0, 0], [
      { embedding: [1, 0, 0], endedAt: daysAgo(400), id: "relevant-old", summary: "exact match, ancient" },
      { embedding: [0, 1, 0], endedAt: daysAgo(0), id: "irrelevant-new", summary: "unrelated, just now" }
    ], 2, NOW);
    expect(hits[0]!.id).toBe("relevant-old"); // cosine 1.0 still beats 0.0 + 0.15
  });

  it("clamps a future-dated session to age 0 (no score explosion from a skewed clock)", () => {
    const hits = rankEpisodeHits([1, 0, 0], [
      { embedding: [1, 0, 0], endedAt: new Date(NOW + 5 * 86_400_000).toISOString(), id: "future", summary: "future" }
    ], 1, NOW);
    // cosine 1.0 + recencyWeight*1.0 max = 1.15, never more
    expect(hits[0]!.score).toBeLessThanOrEqual(1.15 + 1e-9);
    expect(hits[0]!.score).toBeGreaterThan(1.0);
  });
});
