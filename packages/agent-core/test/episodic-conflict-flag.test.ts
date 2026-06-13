import { describe, expect, it } from "vitest";

import {
  flagEpisodicConflicts,
  renderEpisodicSection,
  StoreBackedEpisodicRecallProvider,
  type EpisodicMatch,
  type SummaryListSource
} from "../src/index.js";

// A-MAC factual-confidence admission factor (arXiv:2603.04549, ICLR 2026):
// a recalled memory is low-confidence when it CONTRADICTS another recalled
// memory of the same topic. flagEpisodicConflicts is the read-time detector —
// semantic topic gate (cosine on the already-computed narrative vecs) + the
// neither-subset value-conflict skeleton, same proven skeleton as Mem0's
// detectEvidenceContradictions but self-contained for the episodic surface.

// Topic-band vectors: cos(A,B) ≈ 0.88 — ABOVE the topic gate (0.86) yet BELOW
// the consolidation threshold (0.92), so a value-conflict pair survives dedup
// and reaches the flagger. sin = √(1-0.88²) ≈ 0.4750.
const VEC_FLIGHT_A: readonly number[] = [1, 0];
const VEC_FLIGHT_B: readonly number[] = [0.88, 0.475]; // cos to A ≈ 0.88
const VEC_OFFTOPIC: readonly number[] = [0, 1];        // cos to A = 0

function match(sessionId: string, narrative: string, similarity: number): EpisodicMatch {
  return { sessionId, narrative, similarity };
}

describe("flagEpisodicConflicts — pure helper", () => {
  it("flags a same-topic DIFFERENT-VALUE pair, keying the lower-relevance episode", () => {
    // Sorted by relevance desc: A (higher) then B (lower). Same topic (flight),
    // conflicting value (3pm vs 6pm), neither-subset → conflict.
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "flight is at 6pm", 0.88)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["ep-A", VEC_FLIGHT_A],
      ["ep-B", VEC_FLIGHT_B]
    ]);

    const flags = flagEpisodicConflicts(matches, vecs);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.sessionId).toBe("ep-B");        // the lower-relevance one is annotated
    expect(flags[0]!.conflictsWith).toBe("ep-A");    // against the higher-relevance one
    expect(flags[0]!.topicSim).toBeGreaterThanOrEqual(0.86);
  });

  it("over-flag guard: an ELABORATION (subset) is NOT a conflict", () => {
    // B is a superset of A (adds "from gate" but contradicts nothing) → subset
    // gate kills it even though the topic gate + overlap pass.
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "flight is at 3pm from gate", 0.88)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["ep-A", VEC_FLIGHT_A],
      ["ep-B", VEC_FLIGHT_B]
    ]);
    expect(flagEpisodicConflicts(matches, vecs)).toHaveLength(0);
  });

  it("topic gate: an OFF-TOPIC pair (cos=0) is never flagged", () => {
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "dentist is at 6pm", 0.5)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["ep-A", VEC_FLIGHT_A],
      ["ep-B", VEC_OFFTOPIC]
    ]);
    expect(flagEpisodicConflicts(matches, vecs)).toHaveLength(0);
  });

  it("same-script guard: a cross-script conflicting pair is NOT flagged (fail-open)", () => {
    // KO vs EN: lexical value-comparison is unreliable cross-lingual, so the
    // pair is skipped (a missed cross-lingual conflict = today's behaviour).
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "비행기는 오후 6시", 0.88)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["ep-A", VEC_FLIGHT_A],
      ["ep-B", VEC_FLIGHT_B]
    ]);
    expect(flagEpisodicConflicts(matches, vecs)).toHaveLength(0);
  });

  it("fail-soft: empty narrativeVecs returns no flags", () => {
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "flight is at 6pm", 0.88)
    ];
    expect(flagEpisodicConflicts(matches, new Map())).toHaveLength(0);
  });

  it("fail-soft: a candidate missing a vec is skipped, not flagged", () => {
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "flight is at 6pm", 0.88)
    ];
    const vecs = new Map<string, readonly number[]>([["ep-A", VEC_FLIGHT_A]]);
    expect(flagEpisodicConflicts(matches, vecs)).toHaveLength(0);
  });

  it("one flag per lower-relevance episode (highest-relevance partner wins)", () => {
    // Three same-topic conflicting episodes — B and C each flag against A only,
    // never duplicating onto each other.
    const matches = [
      match("ep-A", "flight is at 3pm", 1.0),
      match("ep-B", "flight is at 6pm", 0.9),
      match("ep-C", "flight is at 9pm", 0.88)
    ];
    const vecs = new Map<string, readonly number[]>([
      ["ep-A", VEC_FLIGHT_A],
      ["ep-B", VEC_FLIGHT_B],
      ["ep-C", VEC_FLIGHT_B]
    ]);
    const flags = flagEpisodicConflicts(matches, vecs);
    expect(flags.map((f) => f.sessionId).sort()).toEqual(["ep-B", "ep-C"]);
    expect(flags.every((f) => f.conflictsWith === "ep-A")).toBe(true);
  });
});

describe("renderEpisodicSection — conflict annotation", () => {
  it("renders a verify marker for a conflict-flagged match", () => {
    const rendered = renderEpisodicSection({
      matches: [
        { sessionId: "ep-A", narrative: "flight is at 3pm", similarity: 1.0 },
        { sessionId: "ep-B", narrative: "flight is at 6pm", similarity: 0.88, conflictsWith: "ep-A" }
      ]
    });
    expect(rendered).toBeDefined();
    expect(rendered).toContain("flight is at 6pm");
    expect(rendered).toContain("conflicts with a more relevant memory");
    // The non-conflicting line carries no marker.
    const lines = rendered!.split("\n");
    const aLine = lines.find((l) => l.includes("flight is at 3pm"))!;
    expect(aLine).not.toContain("conflicts with");
  });

  it("no marker when nothing is flagged (unchanged legacy output)", () => {
    const rendered = renderEpisodicSection({
      matches: [{ sessionId: "ep-A", narrative: "flight is at 3pm", similarity: 1.0 }]
    });
    expect(rendered).not.toContain("conflicts with");
  });
});

// ---------------------------------------------------------------------------
// Assembled path: drive the PRODUCTION StoreBackedEpisodicRecallProvider end-to-
// end with a deterministic embedder (no Ollama). Proves the flagger is wired —
// neutralising flagEpisodicConflicts (return []) turns this RED.
// ---------------------------------------------------------------------------

function makeStore(
  entries: ReadonlyArray<{ sessionId: string; narrative: string; createdAt?: Date }>
): SummaryListSource {
  return { listAll: () => entries };
}

// 2-dim embedder placing the two flight narratives in the [0.86, 0.92) topic
// band (cos ≈ 0.88) so consolidation keeps both and the conflict survives to
// the snapshot. Off-topic queries fall back to the orthogonal axis.
function fakeEmbed(text: string): Promise<readonly number[]> {
  const lower = text.toLowerCase();
  if (lower.includes("3pm")) return Promise.resolve(VEC_FLIGHT_A);
  if (lower.includes("6pm")) return Promise.resolve(VEC_FLIGHT_B);
  if (lower.includes("flight")) return Promise.resolve([0.97, 0.05]); // query: relevant to both
  return Promise.resolve([0, 1]);
}

describe("StoreBackedEpisodicRecallProvider — assembled conflict annotation", () => {
  it("NON-VACUITY: a surviving value-conflict pair is annotated in the snapshot", async () => {
    const store = makeStore([
      { sessionId: "ep-A", narrative: "flight is at 3pm" },
      { sessionId: "ep-B", narrative: "flight is at 6pm" }
    ]);
    const provider = new StoreBackedEpisodicRecallProvider({
      store,
      embed: fakeEmbed,
      topK: 3,
      minScore: 0.1,
      recencyWeight: 0
    });

    const snapshot = await provider.resolve("when is my flight");
    expect(snapshot).toBeDefined();
    const byId = new Map(snapshot!.matches.map((m) => [m.sessionId, m]));
    // Both survive dedup/cutoff (cos 0.88 < 0.92 consolidation threshold).
    expect(byId.has("ep-A")).toBe(true);
    expect(byId.has("ep-B")).toBe(true);
    // The lower-relevance conflicting episode carries the annotation; the
    // higher-relevance one does not.
    expect(byId.get("ep-B")!.conflictsWith).toBe("ep-A");
    expect(byId.get("ep-A")!.conflictsWith).toBeUndefined();

    // And it renders the verify marker end-to-end.
    const rendered = renderEpisodicSection(snapshot);
    expect(rendered).toContain("conflicts with a more relevant memory");
  });
});
