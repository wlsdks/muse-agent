import { describe, expect, it } from "vitest";

import { rankEpisodeHits } from "@muse/recall";
import { buildEpisodeIndex } from "../src/episode-index.js";

describe("rankEpisodeHits importance", () => {
  const queryVec = [1, 0];
  // Two episodes with the SAME embedding (equal cosine relevance) — importance
  // is the only differentiator.
  const base = { embedding: [1, 0] as readonly number[], summary: "" };

  it("ranks the higher-importance episode first at equal relevance", () => {
    const hits = rankEpisodeHits(queryVec, [
      { ...base, id: "low", importance: 2 },
      { ...base, id: "high", importance: 9 }
    ], 2);
    expect(hits[0]?.id).toBe("high");
    expect(hits[1]?.id).toBe("low");
  });

  it("ranks purely by cosine when no episode carries importance", () => {
    const hits = rankEpisodeHits(queryVec, [
      { id: "a", summary: "", embedding: [0.4, 0.9] },
      { id: "b", summary: "", embedding: [0.99, 0.1] }
    ], 2);
    expect(hits[0]?.id).toBe("b");
  });

  it("does not let importance override a clearly more relevant episode", () => {
    const hits = rankEpisodeHits(queryVec, [
      { id: "relevant", summary: "", embedding: [1, 0], importance: 1 },
      { id: "irrelevant-but-important", summary: "", embedding: [0, 1], importance: 10 }
    ], 1);
    expect(hits[0]?.id).toBe("relevant");
  });

  it("returns [] for a non-positive topK", () => {
    expect(rankEpisodeHits(queryVec, [{ ...base, id: "x", importance: 9 }], 0)).toEqual([]);
  });
});

describe("buildEpisodeIndex importance carry", () => {
  const embedFn = async () => [1, 0];

  it("carries episode importance onto the index entry", async () => {
    const { index } = await buildEpisodeIndex({
      episodes: [
        { id: "e1", userId: "u", startedAt: "2026-05-01", endedAt: "2026-05-01", summary: "pivotal", importance: 9 },
        { id: "e2", userId: "u", startedAt: "2026-05-02", endedAt: "2026-05-02", summary: "idle" }
      ],
      embedFn,
      previous: undefined,
      model: "test-embed",
      nowIso: "2026-05-03T00:00:00.000Z"
    });
    expect(index.entries.find((e) => e.id === "e1")?.importance).toBe(9);
    expect(index.entries.find((e) => e.id === "e2")?.importance).toBeUndefined();
  });

  it("refreshes importance on a reused (unchanged-summary) entry without re-embedding", async () => {
    const previous = (await buildEpisodeIndex({
      episodes: [{ id: "e1", userId: "u", startedAt: "2026-05-01", endedAt: "2026-05-01", summary: "same" }],
      embedFn,
      previous: undefined,
      model: "test-embed",
      nowIso: "2026-05-03T00:00:00.000Z"
    })).index;

    const { index, embedded, skipped } = await buildEpisodeIndex({
      episodes: [{ id: "e1", userId: "u", startedAt: "2026-05-01", endedAt: "2026-05-01", summary: "same", importance: 7 }],
      embedFn,
      previous,
      model: "test-embed",
      nowIso: "2026-05-04T00:00:00.000Z"
    });
    expect(skipped).toBe(1);
    expect(embedded).toBe(0);
    expect(index.entries[0]?.importance).toBe(7);
  });
});
