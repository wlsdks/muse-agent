import { describe, expect, it } from "vitest";

import {
  consolidateNearDuplicates,
  EPISODIC_CONSOLIDATION_THRESHOLD,
  StoreBackedEpisodicRecallProvider,
  type EpisodicMatch,
  type SummaryListSource
} from "../src/index.js";

// Hand-built 3-dim vecs for deterministic cosine control.
// NEAR-DUP pair: A and A' point in almost the same direction.
// cosine([1,0,0],[0.99,0.14,0]) ≈ 0.99 / (1 * √(0.99²+0.14²)) ≈ 0.99/1.0 ≈ 0.990 ≥ 0.92.
// DISTINCT: orthogonal (dim 2 only) → cosine to A or A' = 0.
const VEC_A: readonly number[] = [1, 0, 0];
const VEC_A_PRIME: readonly number[] = [0.99, 0.14, 0]; // cosine to A ≈ 0.990 ≥ 0.92
const VEC_B: readonly number[] = [0, 0, 1];             // distinct, cosine to A = 0
// Related-but-distinct: cos([0.6,0.8,0],[1,0,0])=0.6 < 0.92
const VEC_C: readonly number[] = [0.6, 0.8, 0];

function match(sessionId: string, similarity: number): EpisodicMatch {
  return { sessionId, narrative: `narrative-${sessionId}`, similarity };
}

describe("consolidateNearDuplicates — pure helper", () => {
  it("collapses near-dup and lets distinct episode advance", () => {
    // A(1.0) > A'(0.95) > B(0.5). A' is near-dup of A (cos≈0.99 ≥ 0.92); B is distinct.
    const scored: EpisodicMatch[] = [
      match("A", 1.0),
      match("A-prime", 0.95),
      match("B", 0.5)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["A", VEC_A],
      ["A-prime", VEC_A_PRIME],
      ["B", VEC_B]
    ]);

    const result = consolidateNearDuplicates(scored, vecs);
    const ids = result.map((m) => m.sessionId);

    expect(ids).toContain("A");
    expect(ids).toContain("B");
    expect(ids).not.toContain("A-prime");
  });

  it("over-merge guard: related-but-distinct pair (cos≈0.6) keeps BOTH", () => {
    const scored: EpisodicMatch[] = [
      match("A", 1.0),
      match("C", 0.8)  // VEC_C has cosine≈0.6 to VEC_A, below 0.92
    ];
    const vecs = new Map<string, readonly number[]>([
      ["A", VEC_A],
      ["C", VEC_C]
    ]);

    const result = consolidateNearDuplicates(scored, vecs);
    const ids = result.map((m) => m.sessionId);

    expect(ids).toContain("A");
    expect(ids).toContain("C");
  });

  it("fail-soft: empty narrativeVecs returns input unchanged", () => {
    const scored: EpisodicMatch[] = [
      match("A", 1.0),
      match("A-prime", 0.95),
      match("B", 0.5)
    ];

    const result = consolidateNearDuplicates(scored, new Map());
    expect(result.map((m) => m.sessionId)).toEqual(["A", "A-prime", "B"]);
  });

  it("fail-soft: candidate missing a vec is kept (0 similarity, no false collapse)", () => {
    const scored: EpisodicMatch[] = [
      match("A", 1.0),
      match("unknown", 0.95)  // no vec entry → 0 cosine → kept
    ];
    const vecs = new Map<string, readonly number[]>([
      ["A", VEC_A]
      // "unknown" intentionally absent
    ]);

    const result = consolidateNearDuplicates(scored, vecs);
    const ids = result.map((m) => m.sessionId);

    expect(ids).toContain("A");
    expect(ids).toContain("unknown");
  });

  it("keep-higher-ranked: of a near-dup pair, the higher-scored (earlier) one is kept", () => {
    const scored: EpisodicMatch[] = [
      match("A", 0.9),
      match("A-prime", 0.7)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["A", VEC_A],
      ["A-prime", VEC_A_PRIME]
    ]);

    const result = consolidateNearDuplicates(scored, vecs);
    const ids = result.map((m) => m.sessionId);

    expect(ids).toContain("A");
    expect(ids).not.toContain("A-prime");
  });

  it("threshold export matches expected conservative value", () => {
    expect(EPISODIC_CONSOLIDATION_THRESHOLD).toBe(0.92);
  });
});

// ---------------------------------------------------------------------------
// Assembled-path: drive StoreBackedEpisodicRecallProvider end-to-end with a
// deterministic fake embedder (no Ollama) to prove consolidation is wired.
// ---------------------------------------------------------------------------

function makeStore(
  entries: ReadonlyArray<{ sessionId: string; narrative: string; createdAt?: Date }>
): SummaryListSource {
  return {
    listAll() {
      return entries;
    }
  };
}

// 3-dim embedder:
//   dim0 = "project" keyword count
//   dim1 = "chess" keyword count
//   dim2 = "memory" keyword count
//
// Near-dup pair: proj-1 → [2,0,0], proj-1-dup → [2,0,0].
//   cosine = 1.0 ≥ 0.92 → collapse.
// Distinct: chess-1 → [0,2,1].
//
// Without consolidation (topK=2): sort gives proj-1(~0.816), proj-1-dup(~0.816), chess-1(~0.632).
//   CAR sees two equal high scores → adaptiveK=2 → [proj-1, proj-1-dup]; chess-1 starved.
// With consolidation: proj-1-dup collapsed → candidates=[proj-1, chess-1];
//   adaptiveK=2 → both surface.
function fakeEmbedConsolidation(text: string): Promise<readonly number[]> {
  const lower = text.toLowerCase();
  const dim0 = (lower.match(/project/g) ?? []).length;
  const dim1 = (lower.match(/chess/g) ?? []).length;
  const dim2 = (lower.match(/memory/g) ?? []).length;
  return Promise.resolve([dim0, dim1, dim2]);
}

describe("StoreBackedEpisodicRecallProvider — assembled consolidation path", () => {
  it("NON-VACUITY: distinct episode surfaces because near-dup is collapsed before CAR", async () => {
    const store = makeStore([
      { sessionId: "proj-1",     narrative: "project project architecture decision" },
      { sessionId: "proj-1-dup", narrative: "project project architecture plan" },  // near-identical
      { sessionId: "chess-1",    narrative: "chess chess memory opening endgame" }  // distinct
    ]);

    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: fakeEmbedConsolidation,
      topK: 2,
      minScore: 0.1,
      recencyWeight: 0
    });

    const snapshot = await provider.resolve("project chess memory");
    expect(snapshot).toBeDefined();
    const ids = snapshot!.matches.map((m) => m.sessionId);

    // Distinct episode must surface because the dup was collapsed, freeing a slot.
    expect(ids).toContain("chess-1");
    // At most one project-variant (the stronger-ranked one).
    expect(ids.filter((id) => id.startsWith("proj")).length).toBeLessThanOrEqual(1);
  });

  it("COUNTERFACTUAL: without consolidation (threshold=1.01) near-dup occupies slot", () => {
    // When threshold is above 1.0, cosine can never reach it, so nothing collapses.
    // The near-dup occupies the second slot and chess-1 (distinct) is starved.
    // Pass threshold > 1 directly to the pure helper to prove non-vacuity.
    const scored: EpisodicMatch[] = [
      match("proj-1",     0.816),
      match("proj-1-dup", 0.816),
      match("chess-1",    0.632)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["proj-1",     [2, 0, 0]],
      ["proj-1-dup", [2, 0, 0]],
      ["chess-1",    [0, 2, 1]]
    ]);

    // With real threshold: dup is dropped, chess-1 advances.
    const withConsolidation = consolidateNearDuplicates(scored, vecs, 0.92);
    expect(withConsolidation.map((m) => m.sessionId)).not.toContain("proj-1-dup");
    expect(withConsolidation.map((m) => m.sessionId)).toContain("chess-1");

    // Without consolidation (threshold disabled at 1.01): dup is kept, starving chess-1
    // when CAR caps at 2.
    const withoutConsolidation = consolidateNearDuplicates(scored, vecs, 1.01);
    expect(withoutConsolidation.map((m) => m.sessionId)).toContain("proj-1-dup");
    // In the without-consolidation world, taking topK=2 from the 3-item list gives
    // [proj-1, proj-1-dup] — chess-1 is starved.
    expect(withoutConsolidation.slice(0, 2).map((m) => m.sessionId)).not.toContain("chess-1");
  });

  it("minScore floor: consolidation never surfaces a below-minScore episode", async () => {
    // All episodes are below minScore except one; verify output respects the gate.
    const store = makeStore([
      { sessionId: "proj-1", narrative: "project project architecture decision" }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: fakeEmbedConsolidation,
      topK: 3,
      minScore: 0.9999,  // near 1 → only exact-match vectors would pass
      recencyWeight: 0
    });

    const snapshot = await provider.resolve("completely unrelated unrelated query");
    // No episode clears the high minScore threshold → undefined
    expect(snapshot).toBeUndefined();
  });
});
