import { describe, expect, it } from "vitest";

import { computeEpisodeRetention, selectRetainedEpisodes, type PersistedEpisode } from "@muse/stores";

const NOW = Date.parse("2026-05-27T00:00:00Z");
const ep = (id: string, endedAt: string, importance?: number): PersistedEpisode => ({
  id,
  userId: "u",
  startedAt: endedAt,
  endedAt,
  summary: `s ${id}`,
  ...(importance !== undefined ? { importance } : {})
});

describe("computeEpisodeRetention (FadeMem arXiv 2601.18642)", () => {
  it("decays with age — a newer episode is more retained at equal importance", () => {
    const recent = computeEpisodeRetention(ep("r", "2026-05-26T00:00:00Z"), NOW);
    const old = computeEpisodeRetention(ep("o", "2026-01-01T00:00:00Z"), NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it("importance slows the fade — a high-importance episode out-retains a same-age trivial one", () => {
    const at = "2026-03-01T00:00:00Z";
    expect(computeEpisodeRetention(ep("hi", at, 10), NOW))
      .toBeGreaterThan(computeEpisodeRetention(ep("lo", at, 1), NOW));
  });

  it("reduces to recency for unscored episodes (back-compatible)", () => {
    const a = computeEpisodeRetention(ep("a", "2026-05-20T00:00:00Z"), NOW);
    const b = computeEpisodeRetention(ep("b", "2026-05-10T00:00:00Z"), NOW);
    expect(a).toBeGreaterThan(b);
  });

  it("returns 0 for an unparseable endedAt (forgotten first)", () => {
    expect(computeEpisodeRetention(ep("bad", "not-a-date"), NOW)).toBe(0);
  });
});

describe("selectRetainedEpisodes — importance-aware forgetting", () => {
  it("keeps a pivotal OLDER session over a trivial more-recent one at the cap (importance tips comparable ages)", () => {
    // ~35 days old + importance 10 vs ~25 days old + importance 1: importance
    // slows the fade enough to out-retain the more-recent trivial session.
    const kept = selectRetainedEpisodes([
      ep("trivial-recent", "2026-05-02T00:00:00Z", 1),
      ep("pivotal-old", "2026-04-22T00:00:00Z", 10)
    ], 1, NOW);
    expect(kept.map((e) => e.id)).toEqual(["pivotal-old"]);
  });

  it("prunes purely by recency when nothing is scored (unchanged behaviour)", () => {
    const kept = selectRetainedEpisodes([
      ep("old", "2026-05-01T00:00:00Z"),
      ep("mid", "2026-05-10T00:00:00Z"),
      ep("new", "2026-05-20T00:00:00Z")
    ], 2, NOW);
    expect(kept.map((e) => e.id).sort()).toEqual(["mid", "new"]);
  });

  it("is deterministic on equal retention (endedAt then id desc)", () => {
    const same = "2026-05-12T00:00:00Z";
    const kept = selectRetainedEpisodes([ep("ep_a", same), ep("ep_b", same), ep("ep_c", same)], 2, NOW);
    expect(kept.map((e) => e.id).sort()).toEqual(["ep_b", "ep_c"]);
  });
});
