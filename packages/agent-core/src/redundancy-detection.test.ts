import { describe, expect, it } from "vitest";

import { detectRedundantPairs } from "./knowledge-recall.js";

// Same-topic embed: every text gets the same base vector → cosine ≈ 1 (topic gate
// always passes), so the lexical Jaccard gate is what discriminates.
const sameTopicEmbed = (): ((text: string) => Promise<readonly number[]>) =>
  async (_text: string) => [0.9, 0.1, 0, 0];

// Orthogonal embed: texts beginning with "the " get one direction, others an
// orthogonal one (cosine ≈ 0) — lets us isolate the COSINE gate on a high-Jaccard pair.
const orthogonalEmbed = (): ((text: string) => Promise<readonly number[]>) =>
  async (text: string) => (text.startsWith("the ") ? [0.9, 0.1, 0, 0] : [0, 0, 0.9, 0.1]);

describe("detectRedundantPairs — step-repetition (MAST FM-1.3, arXiv:2503.13657) detection", () => {
  it("POSITIVE: two near-identical outputs (one restates the other, adds nothing) → one pair", async () => {
    // Token sets coincide after stopword removal → Jaccard ≈ 1.0 ≥ 0.9.
    const pairs = await detectRedundantPairs(
      ["the quarterly budget is set at 1250 dollars", "quarterly budget is set at 1250 dollars"],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.aIndex).toBe(0);
    expect(pairs[0]!.bIndex).toBe(1);
    expect(pairs[0]!.overlap).toBeGreaterThanOrEqual(0.9);
  });

  it("NEGATIVE (the binding guard): same skeleton, DIFFERENT value tokens → ZERO pairs (the 1분기/2분기 trap)", async () => {
    // "Q1 sales were 5억" vs "Q2 sales were 7억": each carries a distinct value token →
    // Jaccard well below 0.9, so these are NOT redundant (they're distinct results).
    const pairs = await detectRedundantPairs(
      ["first quarter sales reached 500 million", "second quarter sales reached 700 million"],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("NEGATIVE: elaboration (one side adds real new content) → ZERO pairs", async () => {
    // "meeting at 2pm" ⊂ "meeting at 2pm in conference room four" — the larger adds
    // content, lowering Jaccard below the floor → not redundant.
    const pairs = await detectRedundantPairs(
      ["the planning meeting is at 2pm today", "the planning meeting is at 2pm today in conference room four downtown"],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("NEGATIVE: low-cosine pair → ZERO pairs even with identical token sets (the topic gate, isolated)", async () => {
    // Identical tokens after stopword strip (Jaccard 1.0) but the embed places them on
    // orthogonal directions → cosine below the topic floor → not flagged.
    const pairs = await detectRedundantPairs(
      ["the budget is 1250 dollars", "budget is 1250 dollars"],
      orthogonalEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("NEGATIVE: cross-script pair (EN vs KO) → ZERO pairs (same-script guard, fail-open)", async () => {
    const pairs = await detectRedundantPairs(
      ["the quarterly budget is set at 1250 dollars", "분기 예산은 1250 달러로 정해졌습니다"],
      sameTopicEmbed()
    );
    expect(pairs).toHaveLength(0);
  });

  it("fail-open: a throwing embed → ZERO pairs (never blocks the run)", async () => {
    const pairs = await detectRedundantPairs(
      ["the quarterly budget is set at 1250 dollars", "the quarterly budget is set at 1250 dollars"],
      async () => { throw new Error("embedder down"); }
    );
    expect(pairs).toHaveLength(0);
  });

  it("fewer than two texts → ZERO pairs", async () => {
    expect(await detectRedundantPairs(["only one output"], sameTopicEmbed())).toHaveLength(0);
    expect(await detectRedundantPairs([], sameTopicEmbed())).toHaveLength(0);
  });
});
