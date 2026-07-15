import { describe, expect, it } from "vitest";

import { applyReranking, rerankTopK, type RerankProvider } from "./reranking.js";

const m = (source: string, score: number, text = source) => ({ cosine: score, score, source, text });

describe("applyReranking — second-pass relevance reorder, fail-open", () => {
  it("reorders by the reranker scores (a low-cosine but highly-relevant chunk rises)", () => {
    const matches = [m("a", 0.6), m("b", 0.5), m("c", 0.4)];
    const out = applyReranking(matches, [0.1, 0.9, 0.3]); // b is most relevant per the reranker
    expect(out.map((x) => x.source)).toEqual(["b", "c", "a"]);
    expect(out[0]!.rerankScore).toBe(0.9);
  });

  it("fail-open: a length mismatch keeps the original order (never reorders on bad input)", () => {
    const matches = [m("a", 0.6), m("b", 0.5)];
    expect(applyReranking(matches, [0.9]).map((x) => x.source)).toEqual(["a", "b"]);
  });

  it("a non-finite score falls back to that match's own score (no NaN sort)", () => {
    // a: NaN → fallback to its own 0.6; b: 0.55. So a (0.6) > b (0.55).
    const out = applyReranking([m("a", 0.6), m("b", 0.5)], [Number.NaN, 0.55]);
    expect(out.map((x) => x.source)).toEqual(["a", "b"]);
  });

  it("never drops a match", () => {
    expect(applyReranking([m("a", 0.6), m("b", 0.5), m("c", 0.4)], [0.1, 0.2, 0.3])).toHaveLength(3);
  });
});

describe("rerankTopK — rerank the head, leave the tail, fail-open on a provider error", () => {
  const reranker = (scores: readonly number[]): RerankProvider => ({ id: "fake", rerank: async () => scores });

  it("reranks only the top-K and preserves the tail order", async () => {
    const matches = [m("a", 0.6), m("b", 0.5), m("c", 0.4), m("d", 0.3)];
    const out = await rerankTopK(matches, "q", reranker([0.1, 0.9]), 2); // rerank a,b → b first; c,d untouched
    expect(out.map((x) => x.source)).toEqual(["b", "a", "c", "d"]);
  });

  it("a throwing reranker returns the matches unchanged (grounding never weakened by a flaky rerank)", async () => {
    const matches = [m("a", 0.6), m("b", 0.5)];
    const throwing: RerankProvider = { id: "boom", rerank: async () => { throw new Error("model down"); } };
    expect((await rerankTopK(matches, "q", throwing)).map((x) => x.source)).toEqual(["a", "b"]);
  });

  it("preserves existing fields while it reorders matches", async () => {
    const matches = [
      { ...m("a", 0.6), rerankScore: 0.6 },
      { ...m("b", 0.5), rerankScore: 0.5 }
    ];
    const out = await rerankTopK(matches, "q", reranker([0.1, 0.9]), 2);
    expect(out).toEqual([matches[1], matches[0]]);
  });

  it("does not call the reranker for an infinite top-K", async () => {
    let called = false;
    const spy: RerankProvider = { id: "spy", rerank: async () => { called = true; return [1, 0]; } };
    const matches = [m("a", 0.6), m("b", 0.5)];
    expect(await rerankTopK(matches, "q", spy, Number.POSITIVE_INFINITY)).toBe(matches);
    expect(called).toBe(false);
  });

  it("≤1 match → no rerank call (nothing to reorder)", async () => {
    let called = false;
    const spy: RerankProvider = { id: "spy", rerank: async () => { called = true; return [1]; } };
    await rerankTopK([m("a", 0.6)], "q", spy);
    expect(called).toBe(false);
  });
});
