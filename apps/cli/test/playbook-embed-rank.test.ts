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

  it("carries origin through the projection (without it the CBR density gate is inert)", () => {
    expect(toPlaybookStrategy({ text: "x", origin: "reflected" }).origin).toBe("reflected");
    expect("origin" in toPlaybookStrategy({ text: "x" })).toBe(false);
  });
});

// CBR case-density gate (arXiv:2504.06943) reaches production through THIS
// projection: a raw store entry carrying origin:"reflected" that is isolated +
// unproven must be dropped. This drives the REAL seam (toPlaybookStrategy), not a
// hand-built PlaybookStrategy — the test that proves origin survives end-to-end.
describe("rankPlaybookEntriesByRelevance — CBR density gate through the real projection", () => {
  const VEC = new Map<string, readonly number[]>([
    ["q", [1, 0, 0, 0]],
    ["email before noon", [1, 0, 0, 0]],
    ["email under 4 lines", [0.97, 0.24, 0, 0]],
    ["email cc manager", [0.95, 0.31, 0, 0]],
    ["book cheapest flight", [0, 0, 1, 0]], // isolated reflected unproven
    ["prefers tea not coffee", [0, 0, 0, 1]] // isolated grounded — must survive
  ]);
  const embed = (t: string): Promise<readonly number[]> => Promise.resolve(VEC.get(t) ?? [0, 0, 0, 0]);

  it("drops an isolated reflected unproven store entry; keeps grounded + clustered", async () => {
    const entries: PlaybookEntryLike[] = [
      { text: "email before noon", origin: "reflected", reward: 0 },
      { text: "email under 4 lines", origin: "reflected", reward: 0 },
      { text: "email cc manager", origin: "reflected", reward: 0 },
      { text: "book cheapest flight", origin: "reflected", reward: 0 },
      { text: "prefers tea not coffee", origin: "grounded", reward: 0 }
    ];
    const ranked = await rankPlaybookEntriesByRelevance(entries, "q", embed, 10, NOW);
    const texts = ranked.map((s) => s.text);
    expect(texts).not.toContain("book cheapest flight"); // gated
    expect(texts).toContain("prefers tea not coffee");   // grounded kept
    expect(texts).toContain("email before noon");        // clustered kept
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
