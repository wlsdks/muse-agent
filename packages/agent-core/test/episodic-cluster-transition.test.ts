import { describe, expect, it } from "vitest";

import {
  EPISODIC_CLUSTER_DROP_RATIO,
  selectByClusterTransition,
  StoreBackedEpisodicRecallProvider,
  type SummaryListSource
} from "../src/episodic-recall.js";

// --- unit: selectByClusterTransition ---

describe("selectByClusterTransition — unit", () => {
  it("(a) cliff [0.9, 0.85, 0.3, 0.2] topK=4 → 2", () => {
    // 0.3 < 0.85 * 0.5 = 0.425 → cliff after index 1 → k=2
    expect(selectByClusterTransition([0.9, 0.85, 0.3, 0.2], { topK: 4 })).toBe(2);
  });

  it("(b) tight [0.9, 0.88, 0.86] topK=3 → 3 (no cliff)", () => {
    // 0.88 ≥ 0.9*0.5=0.45 ✓; 0.86 ≥ 0.88*0.5=0.44 ✓ → no transition → topK=3
    expect(selectByClusterTransition([0.9, 0.88, 0.86], { topK: 3 })).toBe(3);
  });

  it("(c) cliff [0.9, 0.3, 0.28] topK=3 → 1 (cliff after index 0)", () => {
    // 0.3 < 0.9 * 0.5 = 0.45 → cliff at index 0 → k=1, clamped to [1,topK]
    expect(selectByClusterTransition([0.9, 0.3, 0.28], { topK: 3 })).toBe(1);
  });

  it("(d) empty [] → 0", () => {
    expect(selectByClusterTransition([], { topK: 5 })).toBe(0);
  });

  it("(d) single item [0.9] → 1 (n < topK → min(n, topK))", () => {
    expect(selectByClusterTransition([0.9], { topK: 5 })).toBe(1);
  });

  it("(e) non-vacuity/counterfactual: flattened scores → k changes 2→topK", () => {
    // Cliff version → 2
    const withCliff = selectByClusterTransition([0.9, 0.85, 0.3, 0.2], { topK: 4 });
    expect(withCliff).toBe(2);
    // Flattened (no cliff): [0.9, 0.85, 0.82, 0.79] — all within 50% of previous
    const withoutCliff = selectByClusterTransition([0.9, 0.85, 0.82, 0.79], { topK: 4 });
    expect(withoutCliff).toBe(4);
    // Proves the drop drives the cut, not just the clamp
    expect(withCliff).not.toBe(withoutCliff);
  });

  it("(f) fail-soft: zeros [0, 0, 0] → topK, never throws", () => {
    expect(selectByClusterTransition([0, 0, 0], { topK: 3 })).toBe(3);
  });

  it("(f) fail-soft: negatives [-0.5, -0.1] → topK, never throws", () => {
    expect(selectByClusterTransition([-0.5, -0.1], { topK: 2 })).toBe(2);
  });

  it("(f) fail-soft: [NaN, 0.5] → topK, never throws", () => {
    expect(selectByClusterTransition([Number.NaN, 0.5], { topK: 2 })).toBe(2);
  });

  it("(f) fail-soft: [Infinity, 0.5] → topK, never throws", () => {
    expect(selectByClusterTransition([Infinity, 0.5], { topK: 2 })).toBe(2);
  });

  it("cliff only after topK boundary → k ≤ topK", () => {
    // topK=2, cliff only between index 2 and 3 (beyond topK)
    // [0.9, 0.88, 0.2, 0.1] — walk only pairs within [0, topK-1) = index 0
    // 0.88 ≥ 0.9*0.5=0.45 → no cliff in window → return topK=2
    expect(selectByClusterTransition([0.9, 0.88, 0.2, 0.1], { topK: 2 })).toBe(2);
  });

  it("exported EPISODIC_CLUSTER_DROP_RATIO matches default (0.5)", () => {
    expect(EPISODIC_CLUSTER_DROP_RATIO).toBe(0.5);
  });

  it("custom dropRatio respected: [0.9, 0.7] dropRatio=0.1 → cliff (0.7 < 0.9*0.9=0.81)", () => {
    expect(selectByClusterTransition([0.9, 0.7], { topK: 2, dropRatio: 0.1 })).toBe(1);
  });

  it("custom dropRatio=0: every decrease triggers cliff (0.01 < 0.9*1.0) → k=1", () => {
    // dropRatio=0 means threshold = cur * 1.0 = cur; any decrease fires immediately.
    expect(selectByClusterTransition([0.9, 0.01], { topK: 2, dropRatio: 0 })).toBe(1);
  });
});

// --- assembled: StoreBackedEpisodicRecallProvider live resolve ---

function makeStore(summaries: ReadonlyArray<{
  sessionId: string;
  narrative: string;
  createdAt?: Date;
  userId?: string;
}>): SummaryListSource {
  return {
    listAll(options?: { readonly userId?: string; readonly limit?: number }) {
      const filtered = options?.userId
        ? summaries.filter((e) => e.userId === options.userId)
        : summaries;
      return filtered.slice(0, options?.limit ?? 200);
    }
  };
}

describe("StoreBackedEpisodicRecallProvider — cluster-transition adaptive-k", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");

  it("assembled: head cluster [~0.80, ~0.78] + cliff [0.30] topK=3 → exactly 2 (the CUTOFF, not inhibition, cuts s-C)", async () => {
    const narratives = { A: "machine learning neural networks", B: "deep learning gradient descent", C: "chess opening theory" };
    // 4D orthogonal embedder: each narrative sits in its own perpendicular subspace so
    // cos(A,B)=0.80×0.78≈0.62, cos(A,C)≈0.24, cos(B,C)≈0.23 — all < 0.92 so
    // consolidation does NOT collapse any pair. The sole cut is the CAR cliff.
    //   query=[1,0,0,0]; A=[0.80,0.60,0,0]; B=[0.78,0,0.626,0]; C=[0.30,0,0,0.954]
    // cos(query,A)=0.80, cos(query,B)=0.78, cos(query,C)=0.30
    // cos(A,B)=0.80×0.78=0.624 < 0.92 ✓; cos(A,C)=0.24 < 0.92 ✓
    // CAR cliff: 0.30 < 0.78×0.5=0.39 → k=2; inhibition penalty on C≈0.5×0.23=0.115
    //   → inhibited C=0.30-0.115=0.185 > minScore 0.05, so inhibition does NOT cut C.
    // ONLY the CAR cliff cuts s-C. Neutralizing selectByClusterTransition → 3 returned (RED).
    const vecs = new Map<string, readonly number[]>([
      [narratives.A, [0.80, 0.60, 0, 0]],
      [narratives.B, [0.78, 0, Math.sqrt(1 - 0.78 * 0.78), 0]],
      [narratives.C, [0.30, 0, 0, Math.sqrt(1 - 0.30 * 0.30)]]
    ]);
    const embed = async (text: string): Promise<readonly number[]> => vecs.get(text) ?? [1, 0, 0, 0];
    const store = makeStore([
      { sessionId: "s-A", narrative: narratives.A, createdAt: NOW },
      { sessionId: "s-B", narrative: narratives.B, createdAt: NOW },
      { sessionId: "s-C", narrative: narratives.C, createdAt: NOW }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed,
      topK: 3,
      minScore: 0.05,
      recencyWeight: 0,
      now: () => NOW.getTime()
    });
    const snapshot = await provider.resolve("query");
    expect(snapshot?.matches).toHaveLength(2);
    const ids = snapshot!.matches.map((m) => m.sessionId);
    expect(ids).toContain("s-A");
    expect(ids).toContain("s-B");
    expect(ids).not.toContain("s-C");
  });

  it("counterfactual: tight cluster [0.80, 0.79, 0.78] topK=3 → all 3 survive", async () => {
    const narratives = { A: "machine learning neural networks alpha", B: "machine learning gradient beta", C: "machine learning convergence gamma" };
    // 0.79 ≥ 0.80*0.5=0.40 ✓; 0.78 ≥ 0.79*0.5=0.395 ✓ → no cliff → k=3.
    // Orthogonal perpendicular dims so cos(A,B)=0.80×0.79≈0.63, cos(A,C)≈0.62,
    // cos(B,C)≈0.61 — all < 0.92 so consolidation keeps all three (genuinely distinct).
    const narrativeVecMap = new Map<string, readonly number[]>([
      [narratives.A, [0.80, 0.60, 0, 0]],
      [narratives.B, [0.79, 0, Math.sqrt(1 - 0.79 * 0.79), 0]],
      [narratives.C, [0.78, 0, 0, Math.sqrt(1 - 0.78 * 0.78)]]
    ]);
    const store = makeStore([
      { sessionId: "s-A", narrative: narratives.A, createdAt: NOW },
      { sessionId: "s-B", narrative: narratives.B, createdAt: NOW },
      { sessionId: "s-C", narrative: narratives.C, createdAt: NOW }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: async (text: string) => narrativeVecMap.get(text) ?? [1, 0, 0, 0],
      topK: 3,
      minScore: 0.10,
      recencyWeight: 0,
      now: () => NOW.getTime()
    });
    const snapshot = await provider.resolve("query");
    expect(snapshot?.matches).toHaveLength(3);
  });

  it("fade-path scale-robustness: uniform fade multiplier on tight Jaccard cluster → no spurious cut", async () => {
    // FADE_PENALTY=0.5 halves all Jaccard sims proportionally.
    // Before fade: three narratives all score identically against the same query tokens.
    // After fade: all scores are halved by the same factor → relative drops unchanged.
    // selectByClusterTransition must see a tight cluster (no relative drop ≥ 50%) → k=3.
    //
    // We use Jaccard (no embedder) to avoid lateral-inhibition interactions.
    // All three narratives share the same dense token set as the query, so they score
    // identically (same Jaccard sim). Fade scales all by 0.5 uniformly → no cliff.
    const queryTerms = "machine learning neural network training gradient descent backprop";
    const store = makeStore([
      { sessionId: "s-A", narrative: queryTerms, createdAt: NOW },
      { sessionId: "s-B", narrative: queryTerms, createdAt: NOW },
      { sessionId: "s-C", narrative: queryTerms, createdAt: NOW }
    ]);
    // fadedKeys marks ALL three sessions as fading — FADE_PENALTY=0.5 halves all sims
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      // No embed → Jaccard path; no lateral inhibition (narrativeVecs empty → strength=0)
      fadedKeys: async () => new Set(["s-A", "s-B", "s-C"]),
      topK: 3,
      minScore: 0.05,
      recencyWeight: 0,
      now: () => NOW.getTime()
    });
    const snapshot = await provider.resolve(queryTerms);
    // All 3 must survive — a uniform fade multiplier is NOT a cliff in relative terms
    expect(snapshot?.matches).toHaveLength(3);
  });

  it("regression invariant: no-transition case returns same count as previous fixed topK", async () => {
    const narratives = { A: "topic A alpha", B: "topic B beta" };
    // Orthogonal perpendicular dims: cos(A,B)=0.80×0.79≈0.63 < 0.92 → consolidation
    // keeps both. No cliff (0.79 ≥ 0.80×0.5) → topK=2, byte-identical to old fixed-slice.
    const narrativeVecMap = new Map<string, readonly number[]>([
      [narratives.A, [0.80, 0.60, 0]],
      [narratives.B, [0.79, 0, Math.sqrt(1 - 0.79 * 0.79)]]
    ]);
    const store = makeStore([
      { sessionId: "s-A", narrative: narratives.A, createdAt: NOW },
      { sessionId: "s-B", narrative: narratives.B, createdAt: NOW }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: async (text: string) => narrativeVecMap.get(text) ?? [1, 0, 0],
      topK: 2,
      minScore: 0.10,
      recencyWeight: 0,
      now: () => NOW.getTime()
    });
    const snapshot = await provider.resolve("query");
    // No cliff → topK=2, byte-identical to old fixed-slice behavior
    expect(snapshot?.matches).toHaveLength(2);
  });
});
