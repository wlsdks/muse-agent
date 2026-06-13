import { describe, expect, it } from "vitest";

import {
  rankPlaybookEntriesByRelevance,
  toPlaybookStrategy,
  type PlaybookEntryLike
} from "../src/playbook-embed-rank.js";

const NOW = Date.parse("2026-06-13T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// A fake embedder returning the SAME vector for every text → cosine ties for
// all strategies, so relevance is equal and the reward/recency term alone
// decides ordering. This isolates the D-UCB temporal discount.
const tieEmbed = async (): Promise<readonly number[]> => [1, 0, 0];

describe("toPlaybookStrategy", () => {
  it("carries the recency anchors when present", () => {
    const s = toPlaybookStrategy({
      text: "x", tag: "t", reward: 2, reinforcements: 3, decays: 1,
      lastReinforcedAt: daysAgo(2), createdAt: daysAgo(10)
    });
    expect(s.lastReinforcedAt).toBe(daysAgo(2));
    expect(s.createdAt).toBe(daysAgo(10));
    expect(s.tag).toBe("t");
    expect(s.reward).toBe(2);
  });

  it("omits anchor keys when absent (no undefined keys)", () => {
    const s = toPlaybookStrategy({ text: "x" });
    expect("lastReinforcedAt" in s).toBe(false);
    expect("createdAt" in s).toBe(false);
    expect("reward" in s).toBe(false);
  });
});

describe("rankPlaybookEntriesByRelevance — D-UCB recency on the embed-rank path (arXiv:0805.3415)", () => {
  // stale inserted FIRST, fresh second — so insertion order alone would keep
  // stale ahead. Equal reward + equal cosine ⇒ only the recency discount can
  // reorder them.
  const stale: PlaybookEntryLike = {
    text: "stale strategy", reward: 4, reinforcements: 4, decays: 0, lastReinforcedAt: daysAgo(120)
  };
  const fresh: PlaybookEntryLike = {
    text: "fresh strategy", reward: 4, reinforcements: 4, decays: 0, lastReinforcedAt: daysAgo(1)
  };

  it("fresh outranks stale once the recency discount is fed nowMs", async () => {
    const ranked = await rankPlaybookEntriesByRelevance([stale, fresh], "any query", tieEmbed, undefined, NOW);
    expect(ranked[0]?.text).toBe("fresh strategy");
    expect(ranked[1]?.text).toBe("stale strategy");
  });

  it("counterfactual: equal timestamps → insertion order preserved (recency, not insertion, drove the reorder)", async () => {
    // Give BOTH the same fresh anchor: the discount is equal, so the tie falls
    // back to insertion order — stale-as-inserted stays first. If the previous
    // test's reorder were an artifact of insertion/index, this would also show
    // fresh first; it doesn't.
    const a: PlaybookEntryLike = { ...stale, lastReinforcedAt: daysAgo(1) };
    const ranked = await rankPlaybookEntriesByRelevance([a, fresh], "any query", tieEmbed, undefined, NOW);
    expect(ranked[0]?.text).toBe("stale strategy");
    expect(ranked[1]?.text).toBe("fresh strategy");
  });
});
