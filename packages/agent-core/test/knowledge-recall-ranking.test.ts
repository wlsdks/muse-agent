import { describe, expect, it } from "vitest";

import { edgeLoadByRelevance, fuseByReciprocalRank, reorderForLongContext, selectByMarginalValue, selectByMmr } from "../src/knowledge-recall.js";

describe("selectByMarginalValue — Charnov MVT give-up-at-R* stopping rule for the cited-source count", () => {
  it("stops early on a sharp relevance cliff (one source far above the mean)", () => {
    // R* (mean) = 0.2625; only 0.9 clears it → leave the habitat at 1 source.
    expect(selectByMarginalValue([0.9, 0.05, 0.05, 0.05])).toBe(1);
  });

  it("keeps more sources when the field is rich (many comparably-relevant)", () => {
    // R* = 0.6125; 0.8, 0.75, 0.7 clear it, 0.2 does not → 3.
    expect(selectByMarginalValue([0.8, 0.75, 0.7, 0.2])).toBe(3);
  });

  it("returns all when every source is equally relevant — no cliff to stop at", () => {
    expect(selectByMarginalValue([0.5, 0.5, 0.5])).toBe(3); // all == R*, none below
  });

  it("is scale-robust on the compressed cosine band (a real winner still cuts the noise)", () => {
    // Nomic-style: one lexical+semantic winner ~0.78 over a ~0.43 noise floor.
    expect(selectByMarginalValue([0.78, 0.45, 0.43, 0.41])).toBe(1); // R*≈0.5175, only 0.78 clears
  });

  it("clamps to [min, max] and handles the empty list", () => {
    expect(selectByMarginalValue([0.9, 0.05, 0.05], { max: 5, min: 2 })).toBe(2); // R* wants 1, min lifts to 2
    expect(selectByMarginalValue([0.5, 0.5, 0.5, 0.5], { max: 2 })).toBe(2); // all clear R*, capped at max
    expect(selectByMarginalValue([])).toBe(0);
  });
});

describe("fuseByReciprocalRank", () => {
  it("sums 1/(k + rank) across rankings, rewarding agreement between lists", () => {
    // "x" is rank 1 in BOTH lists; "y"/"z" appear in one list each.
    const fused = fuseByReciprocalRank([["x", "y"], ["x", "z"]]);
    expect(fused.get("x")).toBe(2 / 61);
    expect(fused.get("y")).toBe(1 / 62);
    expect(fused.get("z")).toBe(1 / 62);
    expect(fused.get("x")!).toBeGreaterThan(fused.get("y")!);
  });

  it("ranks a single list strictly by position (rank 1 scores highest)", () => {
    const fused = fuseByReciprocalRank([["a", "b", "c"]]);
    expect(fused.get("a")!).toBeGreaterThan(fused.get("b")!);
    expect(fused.get("b")!).toBeGreaterThan(fused.get("c")!);
  });

  it("honours a custom k (smaller k spreads the scores wider)", () => {
    expect(fuseByReciprocalRank([["a"]], 0).get("a")).toBe(1); // 1/(0+1)
    expect(fuseByReciprocalRank([["a"]], 9).get("a")).toBe(1 / 10);
  });

  it("returns an empty map for no rankings", () => {
    expect(fuseByReciprocalRank([]).size).toBe(0);
  });
});

describe("selectByMmr", () => {
  const candidates = [
    { key: "A", relevance: 0.9, embedding: [1, 0] },
    { key: "B", relevance: 0.8, embedding: [1, 0] }, // near-duplicate of A
    { key: "C", relevance: 0.7, embedding: [0, 1] }, // distinct from A
  ];

  it("passes over a near-duplicate in favour of a distinct lower-relevance item", () => {
    // λ=0.5 balances relevance and diversity: B (higher relevance, but a
    // duplicate of the already-picked A) loses to the orthogonal C.
    expect(selectByMmr(candidates, 0.5, 2)).toEqual(["A", "C"]);
  });

  it("collapses to pure relevance order at λ=1 (no diversity penalty)", () => {
    expect(selectByMmr(candidates, 1, 2)).toEqual(["A", "B"]);
  });

  it("returns all candidates when topK exceeds the pool, and none for topK=0", () => {
    expect(selectByMmr(candidates, 0.5, 10)).toHaveLength(3);
    expect(selectByMmr(candidates, 0.5, 0)).toEqual([]);
  });
});

describe("edgeLoadByRelevance", () => {
  it("places the best items at the two edges and the worst in the middle", () => {
    // Input is best-first; LLMs attend best to the start/end of context.
    expect(edgeLoadByRelevance([1, 2, 3, 4, 5])).toEqual([1, 3, 5, 4, 2]);
    expect(edgeLoadByRelevance([1, 2, 3, 4])).toEqual([1, 3, 4, 2]);
  });

  it("is a stable permutation for trivial inputs", () => {
    expect(edgeLoadByRelevance([])).toEqual([]);
    expect(edgeLoadByRelevance(["only"])).toEqual(["only"]);
    expect([...edgeLoadByRelevance([1, 2, 3, 4, 5])].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("reorderForLongContext (lost-in-the-middle edge-loading)", () => {
  const scores = (items) => items.map((x) => x.score);
  const mk = (arr) => arr.map((s) => ({ id: s, score: s }));

  it("sorts by score then alternates to put the top items at BOTH edges, lowest in the middle", () => {
    // sorted desc [5,4,3,2,1] → front=[5,3,1], back=[4,2]→reversed [2,4]
    // → [5,3,1,2,4]: highest at index 0, second-highest at the LAST index, lowest dead-centre.
    expect(scores(reorderForLongContext(mk([5, 4, 3, 2, 1])))).toEqual([5, 3, 1, 2, 4]);
    const out = reorderForLongContext(mk([5, 4, 3, 2, 1]));
    expect(out[0]?.score).toBe(5); // best at the front edge
    expect(out[out.length - 1]?.score).toBe(4); // 2nd-best at the back edge
    expect(out[2]?.score).toBe(1); // worst buried in the middle (where attention is weakest)
  });

  it("sorts internally, so an UNSORTED input yields the same edge-loaded order", () => {
    expect(scores(reorderForLongContext(mk([1, 5, 3, 2, 4])))).toEqual([5, 3, 1, 2, 4]);
  });

  it("is a non-mutating permutation; handles empty / single / pair", () => {
    const input = mk([1, 2, 3]);
    reorderForLongContext(input);
    expect(scores(input)).toEqual([1, 2, 3]); // input untouched
    expect(reorderForLongContext([])).toEqual([]);
    expect(scores(reorderForLongContext(mk([7])))).toEqual([7]);
    expect(scores(reorderForLongContext(mk([9, 1])))).toEqual([9, 1]);
  });
});
