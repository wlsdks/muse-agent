import { describe, expect, it } from "vitest";

import {
  applyLateralInhibition,
  EPISODIC_INHIBITION_STRENGTH,
  StoreBackedEpisodicRecallProvider,
  type EpisodicMatch,
  type SummaryListSource
} from "../src/index.js";

// Hand-built 3-dim vecs for deterministic cosine control.
// DUP group: identical direction (dim 0 only) → cosine=1.0 between any pair.
// DISTINCT: orthogonal (dim 2 only) → cosine=0 to any DUP.
const DUP_A = [1, 0, 0];
const DUP_B = [1, 0, 0];
const DUP_C = [1, 0, 0];
const DISTINCT = [0, 0, 1];

function match(sessionId: string, similarity: number): EpisodicMatch {
  return { sessionId, narrative: `narrative-${sessionId}`, similarity };
}

describe("applyLateralInhibition — pure helper", () => {
  it("NON-VACUITY: distinct episode surfaces and only 1 dup survives (topK=3)", () => {
    // Scores: dup-a(0.9) > dup-b(0.6) > dup-c(0.5) > distinct(0.4). minScore=0.15, strength=0.5.
    // dup-a: no selected → penalty=0 → 0.9 >= 0.15 → ACCEPTED.
    // dup-b: cos(DUP_B,DUP_A)=1 → penalty=0.5 → inhibited=0.6-0.5=0.1 < 0.15 → DROPPED.
    // dup-c: cos(DUP_C,DUP_A)=1 → penalty=0.5 → inhibited=0.5-0.5=0.0 < 0.15 → DROPPED.
    // distinct: cos(DISTINCT,DUP_A)=0 → penalty=0 → 0.4 >= 0.15 → ACCEPTED.
    // Without inhibition: plain slice(0,3) = [dup-a,dup-b,dup-c]; distinct is excluded.
    const scored: EpisodicMatch[] = [
      match("dup-a", 0.9),
      match("dup-b", 0.6),
      match("dup-c", 0.5),
      match("distinct", 0.4)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["dup-a", DUP_A],
      ["dup-b", DUP_B],
      ["dup-c", DUP_C],
      ["distinct", DISTINCT]
    ]);
    const result = applyLateralInhibition(scored, vecs, {
      topK: 3,
      minScore: 0.15,
      inhibitionStrength: EPISODIC_INHIBITION_STRENGTH
    });

    const ids = result.map((m) => m.sessionId);
    expect(ids).toContain("distinct");
    expect(ids.filter((id) => id.startsWith("dup")).length).toBeLessThanOrEqual(1);

    // Confirm this test is non-vacuous: without inhibition distinct would NOT surface.
    expect(scored.slice(0, 3).map((m) => m.sessionId)).not.toContain("distinct");
  });

  it("COUNTERFACTUAL off-switch: strength=0 is byte-identical to plain minScore-filtered slice", () => {
    const scored: EpisodicMatch[] = [
      match("a", 0.9),
      match("b", 0.88),
      match("c", 0.86),
      match("d", 0.80)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["a", DUP_A],
      ["b", DUP_B],
      ["c", DUP_C],
      ["d", DISTINCT]
    ]);
    const inhibited = applyLateralInhibition(scored, vecs, {
      topK: 3,
      minScore: 0.15,
      inhibitionStrength: 0
    });
    const plain = scored.filter((m) => (m.similarity ?? 0) >= 0.15).slice(0, 3);
    expect(inhibited.map((m) => m.sessionId)).toEqual(plain.map((m) => m.sessionId));
  });

  it("FAIL-SOFT: empty narrativeVecs is byte-identical to plain slice", () => {
    const scored: EpisodicMatch[] = [
      match("x", 0.9),
      match("y", 0.7),
      match("z", 0.6)
    ];
    const result = applyLateralInhibition(scored, new Map(), {
      topK: 2,
      minScore: 0.1,
      inhibitionStrength: EPISODIC_INHIBITION_STRENGTH
    });
    expect(result.map((m) => m.sessionId)).toEqual(["x", "y"]);
  });

  it("FLOOR below-gate: inhibited score < minScore is dropped, not surfaced", () => {
    // dup-b raw=0.3; penalty=0.5×1=0.5 → inhibited=-0.2 < minScore(0.25) → DROPPED.
    const scored: EpisodicMatch[] = [
      match("dup-a", 0.9),
      match("dup-b", 0.3)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["dup-a", DUP_A],
      ["dup-b", DUP_B]
    ]);
    const result = applyLateralInhibition(scored, vecs, {
      topK: 3,
      minScore: 0.25,
      inhibitionStrength: EPISODIC_INHIBITION_STRENGTH
    });
    const ids = result.map((m) => m.sessionId);
    expect(ids).toContain("dup-a");
    expect(ids).not.toContain("dup-b");
  });

  it("FLOOR non-redundant relevant episode is never displaced by inhibition", () => {
    // distinct is orthogonal to dup-a → penalty=0.5×0=0 → always accepted at full score.
    const scored: EpisodicMatch[] = [
      match("dup-a", 0.9),
      match("distinct", 0.5)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["dup-a", DUP_A],
      ["distinct", DISTINCT]
    ]);
    const result = applyLateralInhibition(scored, vecs, {
      topK: 2,
      minScore: 0.15,
      inhibitionStrength: EPISODIC_INHIBITION_STRENGTH
    });
    const ids = result.map((m) => m.sessionId);
    expect(ids).toContain("dup-a");
    expect(ids).toContain("distinct");
  });
});

// ---------------------------------------------------------------------------
// Assembled-path: drive StoreBackedEpisodicRecallProvider end-to-end with a
// deterministic fake embedder (no Ollama).
// ---------------------------------------------------------------------------

function makeStoreWithSummaries(
  entries: ReadonlyArray<{ sessionId: string; narrative: string; createdAt?: Date }>
): SummaryListSource {
  return {
    listAll() {
      return entries;
    }
  };
}

// 3-dim embedder: dim0=project keywords, dim1=chess keywords, dim2=memory keywords.
// Returns raw counts (cosine normalises internally).
//
// Query "project chess memory" → [1,1,1].
// proj narratives "project launch release …" → [3,0,0].
//   cosine([1,1,1],[3,0,0]) = 3/(√3×3) ≈ 0.577.
// chess-1 narrative "chess opening gambit endgame memory recall" → [0,4,2].
//   cosine([1,1,1],[0,4,2]) = 6/(√3×√20) ≈ 0.775.
//
// Greedy (topK=3, minScore=0.4, strength=0.5):
//   chess-1(0.775): no selected → penalty=0 → ACCEPTED.
//   proj-1(0.577): cos([3,0,0],[0,4,2])=0 → penalty=0 → ACCEPTED.
//   proj-2(0.577): cos([3,0,0],[0,4,2])=0, cos([3,0,0],[3,0,0])=1 → penalty=0.5
//     → inhibited=0.577-0.5=0.077 < 0.4 → DROPPED.
//   proj-3: same → DROPPED.
// Result: [chess-1, proj-1] — distinct surfaced, ≤1 dup.
function fakeEmbedAssembled(text: string): Promise<readonly number[]> {
  const lower = text.toLowerCase();
  const dim0 = ["project", "launch", "release", "deploy"].filter((w) => lower.includes(w)).length;
  const dim1 = ["chess", "opening", "gambit", "endgame"].filter((w) => lower.includes(w)).length;
  const dim2 = ["memory", "recall", "remember"].filter((w) => lower.includes(w)).length;
  return Promise.resolve([dim0, dim1, dim2]);
}

describe("StoreBackedEpisodicRecallProvider — assembled lateral inhibition path", () => {
  it("surfaces distinct episode and ≤1 near-duplicate when embeddings present", async () => {
    const store = makeStoreWithSummaries([
      { sessionId: "proj-1", narrative: "project launch and release planning" },
      { sessionId: "proj-2", narrative: "launch deploy project final release" },
      { sessionId: "proj-3", narrative: "project deploy launch release roadmap" },
      { sessionId: "chess-1", narrative: "chess opening gambit endgame memory recall" }
    ]);

    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: fakeEmbedAssembled,
      topK: 3,
      minScore: 0.4,
      recencyWeight: 0
    });

    const snapshot = await provider.resolve("project chess memory");
    expect(snapshot).toBeDefined();
    const ids = snapshot!.matches.map((m) => m.sessionId);

    expect(ids).toContain("chess-1");
    expect(ids.filter((id) => id.startsWith("proj")).length).toBeLessThanOrEqual(1);
    expect(snapshot!.matches.length).toBeLessThanOrEqual(3);
  });
});
