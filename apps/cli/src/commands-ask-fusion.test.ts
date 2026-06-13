/**
 * Assembled-path test for RAG-Fusion (arXiv:2402.03367) in diversifyAskChunks.
 *
 * Geometry: 5 orthogonal embedding dimensions.
 *   dim 0 = WireGuard/MTU topic, dim 1 = rent/납부일 topic, dims 2–4 = decoy axes.
 *
 * Full-query cosine scores place both answer chunks (A, B) below three decoys,
 * so pure top-3 cosine + lexical selection misses BOTH. Per-clause embedding
 * vectors (clause-1 aligns with dim 0, clause-2 with dim 1) each rank one
 * answer chunk top; RRF fusion of all ranking lists surfaces both into top-3.
 *
 * The query string uses tokens absent from all chunk texts so the lexical
 * ranking contributes nothing — isolating the clause-embedding fusion as the
 * mechanism under test.
 */
import { describe, expect, it } from "vitest";

import { diversifyAskChunks } from "./commands-ask.js";

function chunk(file: string, embedding: number[], text = "x") {
  return { chunk: { chunkIndex: 0, embedding, file, text }, file, score: 0 };
}

// Orthogonal unit basis vectors (5-dimensional).
const A  = { ...chunk("wireguard.md", [1, 0, 0, 0, 0], "wireguard configuration"), score: 0.44 };
const B  = { ...chunk("rent.md",      [0, 1, 0, 0, 0], "rent payment schedule"),   score: 0.43 };
const D1 = { ...chunk("d1.md",        [0, 0, 1, 0, 0], "investor runway notes"),   score: 0.56 };
const D2 = { ...chunk("d2.md",        [0, 0, 0, 1, 0], "coffee preferences page"), score: 0.55 };
const D3 = { ...chunk("d3.md",        [0, 0, 0, 0, 1], "project timeline plan"),   score: 0.54 };
const candidates = [A, B, D1, D2, D3];

// Clause vectors: clause-1 aligns dim 0 (WireGuard), clause-2 aligns dim 1 (rent).
const clause1Vec = [1, 0, 0, 0, 0] as const;
const clause2Vec = [0, 1, 0, 0, 0] as const;

// Query tokens ("zeta", "theta") appear in no chunk text, so lexical ranking
// adds nothing — isolates clause-embedding fusion as the rescue mechanism.
const query = "zeta theta compound query";

describe("diversifyAskChunks — RAG-Fusion via subqueryEmbeddings (arXiv:2402.03367)", () => {
  it("counterfactual: without subqueryEmbeddings, both answer chunks miss top-3", () => {
    // Decoys score 0.56/0.55/0.54; A and B score 0.44/0.43.
    // Lexical ranking is empty (no overlap). Cosine order → D1,D2,D3 win.
    const picked = diversifyAskChunks(candidates, 3, 0.7, query).map((p) => p.file);
    expect(picked).not.toContain("wireguard.md");
    expect(picked).not.toContain("rent.md");
  });

  it("non-vacuity: with clause vectors, BOTH answer chunks A and B appear in top-3", () => {
    const picked = diversifyAskChunks(candidates, 3, 0.7, query, [clause1Vec, clause2Vec]).map((p) => p.file);
    expect(picked).toContain("wireguard.md");
    expect(picked).toContain("rent.md");
  });

  it("floor: every returned chunk's score is the stored full-query cosine, not a clause cosine", () => {
    const picked = diversifyAskChunks(candidates, 3, 0.7, query, [clause1Vec, clause2Vec]);
    for (const p of picked) {
      const original = candidates.find((c) => c.file === p.file);
      expect(p.score).toBe(original?.score);
    }
    // Answer chunks specifically keep their full-query cosine, not the clause cosine (1.0).
    expect(picked.find((p) => p.file === "wireguard.md")?.score).toBe(0.44);
    expect(picked.find((p) => p.file === "rent.md")?.score).toBe(0.43);
  });

  it("regression: empty subqueryEmbeddings produces byte-identical result to omitting the param", () => {
    const withEmpty   = diversifyAskChunks(candidates, 3, 0.7, query, []).map((p) => p.file);
    const withOmitted = diversifyAskChunks(candidates, 3, 0.7, query).map((p) => p.file);
    expect(withEmpty).toEqual(withOmitted);
  });

  it("regression: undefined subqueryEmbeddings is byte-identical to omitting the param", () => {
    const withUndefined = diversifyAskChunks(candidates, 3, 0.7, query, undefined).map((p) => p.file);
    const withOmitted   = diversifyAskChunks(candidates, 3, 0.7, query).map((p) => p.file);
    expect(withUndefined).toEqual(withOmitted);
  });

  it("must-refuse: off-corpus clause vectors do not inflate any chunk's score", () => {
    // Clause vectors that are oblique to all chunk embeddings — no chunk gets a
    // high cosine boost. Verifies fusion changes WHICH chunks are selected, never
    // manufactures confidence by inflating the stored score field.
    const offVec1 = [0, 0, 0.707, 0, 0.707] as const;
    const offVec2 = [0, 0, 0, 0.707, 0.707] as const;
    const picked = diversifyAskChunks(candidates, 3, 0.7, query, [offVec1, offVec2]);
    for (const p of picked) {
      const original = candidates.find((c) => c.file === p.file);
      expect(p.score).toBe(original?.score);
    }
  });
});
