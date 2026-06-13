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

/**
 * Builds an embedder where each narrative maps to an ORTHOGONAL unit vector
 * (no lateral-inhibition penalty between narratives) with controlled cosine
 * similarity to the query vector [1, 0, 0, ...].
 *
 * Query → [1, 0, 0, 0, ...]
 * Narrative i → [sim_i, perp_i, 0, ..., 1(at slot i+2), 0, ...]
 * cosine(query, narrative_i) = sim_i
 * cosine(narrative_i, narrative_j) ≈ sim_i * sim_j (small when sims < 1)
 *
 * To guarantee zero lateral-inhibition penalty we use fully orthogonal vectors:
 * narrative i lives in its own dimension (slot i+1) AND shares the query dimension.
 * Actually the simplest approach: narrativeVec[i] = [0, ..., 1, ...] (slot i+1 only,
 * cosine with query=[1,0,0,...] = 0) — but then sims are all 0 which defeats scoring.
 *
 * Better: make the query vector all-ones / n, and each narrative a one-hot at its
 * slot. cos(allOnes/n, e_i) = 1/sqrt(n). That's uniform, not controllable.
 *
 * Simplest controllable approach: throw the lateral-inhibition completely by
 * making narrative vectors orthogonal to EACH OTHER while keeping a known
 * dot product with the query. We put each narrative's "similarity component"
 * in a different orthogonal subspace:
 *   query     = [q1, q2, q3, ...]  where qi = sim_i (not unit, but we normalise)
 *   narrative_i = unit vector in slot i → cos(query_unit, e_i) = sim_i / ||query||
 *
 * This is getting complex. Simpler: just avoid lateral inhibition entirely by
 * setting embed to undefined (Jaccard path). The fade test only needs to verify
 * that the relative-drop check survives a uniform multiplier — Jaccard gives
 * real sims and FADE_PENALTY scales them proportionally.
 */
function makeEmbedder(narrativeToSim: ReadonlyMap<string, number>): (text: string) => Promise<readonly number[]> {
  // Returns a deterministic unit-vector embedding such that cosine similarity
  // to the query vector equals the desired sim value for each narrative.
  // Query vector = [1, 0]; narrative vector = [sim, sqrt(1 - sim^2)] → cosine = sim.
  // NOTE: All narrative vectors are near-parallel → lateral inhibition fires between
  // them. Tests that use this embedder must account for inhibition, or use distinct
  // narratives with very different sim values so inhibition doesn't bridge them.
  return async (text: string) => {
    const sim = narrativeToSim.get(text);
    if (sim === undefined) {
      // query vector
      return [1, 0];
    }
    const perp = Math.sqrt(Math.max(0, 1 - sim * sim));
    return [sim, perp];
  };
}

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
    // 3D embedder so the cutoff — NOT lateral inhibition — is the sole cause of the cut:
    //   query=[1,0,0]; A=[0.80,0.60,0]; B=[0.78,0.6258,0]; C=[0.30,0,0.9539]
    // cos(query,·)=x-component → base sims A=0.80, B=0.78, C=0.30. C's perpendicular
    // mass is on axis-2 (orthogonal to A/B's axis-1), so cos(A,C)=cos(B,C)=0.24 →
    // inhibition penalty on C is only ~0.5*0.24=0.12 → C's inhibited score 0.30-0.12=0.18
    // > minScore 0.05, i.e. C SURVIVES inhibition+minScore. The ONLY thing that excludes
    // C is the transition cutoff (0.30 < 0.78*0.5=0.39 → k=2). So neutralizing
    // selectByClusterTransition to topK makes this return 3 (RED) — the assertion binds the cut.
    const vecs = new Map<string, readonly number[]>([
      [narratives.A, [0.80, 0.60, 0]],
      [narratives.B, [0.78, Math.sqrt(1 - 0.78 * 0.78), 0]],
      [narratives.C, [0.30, 0, Math.sqrt(1 - 0.30 * 0.30)]]
    ]);
    const embed = async (text: string): Promise<readonly number[]> => vecs.get(text) ?? [1, 0, 0];
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
    // 0.79 ≥ 0.80*0.5=0.40 ✓; 0.78 ≥ 0.79*0.5=0.395 ✓ → no cliff → k=3
    const simMap = new Map<string, number>([
      [narratives.A, 0.80],
      [narratives.B, 0.79],
      [narratives.C, 0.78]
    ]);
    const store = makeStore([
      { sessionId: "s-A", narrative: narratives.A, createdAt: NOW },
      { sessionId: "s-B", narrative: narratives.B, createdAt: NOW },
      { sessionId: "s-C", narrative: narratives.C, createdAt: NOW }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: makeEmbedder(simMap),
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
    const simMap = new Map<string, number>([
      [narratives.A, 0.80],
      [narratives.B, 0.79]
    ]);
    const store = makeStore([
      { sessionId: "s-A", narrative: narratives.A, createdAt: NOW },
      { sessionId: "s-B", narrative: narratives.B, createdAt: NOW }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: makeEmbedder(simMap),
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
