import { describe, expect, it } from "vitest";

import { diversifyAskChunks } from "./commands-ask.js";

function chunk(file: string, idx: number, embedding: number[], text = "x") {
  return { chunk: { chunkIndex: idx, embedding, file, text }, file, score: 0 };
}

describe("diversifyAskChunks — MMR grounding selection (Carbonell & Goldstein 1998)", () => {
  it("demotes a near-duplicate in favour of a diverse relevant chunk", () => {
    // A is most relevant; B nearly duplicates A; C is distinct but slightly
    // less relevant. Pure top-2 cosine would pick [A, B] (redundant); MMR
    // should pick [A, C].
    const candidates = [
      { ...chunk("a.md", 0, [1, 0, 0]), score: 0.90 },
      { ...chunk("b.md", 0, [0.99, 0.14, 0]), score: 0.88 }, // near-duplicate of A
      { ...chunk("c.md", 0, [0, 1, 0]), score: 0.70 } // distinct
    ];
    const picked = diversifyAskChunks(candidates, 2, 0.7);
    expect(picked.map((p) => p.file)).toEqual(["a.md", "c.md"]);
  });

  it("is a plain cosine sort when there's nothing to trim (candidates ≤ K)", () => {
    const candidates = [
      { ...chunk("a.md", 0, [1, 0, 0]), score: 0.5 },
      { ...chunk("b.md", 0, [0, 1, 0]), score: 0.9 }
    ];
    expect(diversifyAskChunks(candidates, 5, 0.7).map((p) => p.file)).toEqual(["b.md", "a.md"]);
  });

  it("returns empty for a non-positive K", () => {
    expect(diversifyAskChunks([{ ...chunk("a.md", 0, [1, 0, 0]), score: 0.5 }], 0)).toEqual([]);
  });

  it("keeps each chunk's cosine score for downstream citation/banner", () => {
    const picked = diversifyAskChunks([
      { ...chunk("a.md", 0, [1, 0, 0]), score: 0.91 },
      { ...chunk("b.md", 0, [0, 1, 0]), score: 0.42 }
    ], 2, 0.7);
    expect(picked.find((p) => p.file === "a.md")?.score).toBe(0.91);
  });

  describe("hybrid (cosine + lexical RRF) selection when a query is supplied", () => {
    // The real-world bug: the answer note's cosine ranks below near-misses on
    // nomic's compressed embedding space, so a pure top-K cosine slice excludes
    // it and `muse ask` FALSE-REFUSES. The query's distinctive keywords must
    // rescue it into the top-K.
    // All four embeddings are mutually orthogonal, so MMR's diversity term is
    // equal across them and cosine-only selection orders purely by score — the
    // three higher-cosine decoys win the top-3 and vpn (0.50) is excluded.
    const vpn = { ...chunk("vpn.md", 0, [0, 0, 0, 1], "WireGuard VPN MTU is 1380 to avoid fragmentation"), score: 0.50 };
    const decoys = [
      { ...chunk("d1.md", 0, [1, 0, 0, 0], "investor sync notes about runway"), score: 0.58 },
      { ...chunk("d2.md", 0, [0, 1, 0, 0], "coffee preferences flat white"), score: 0.57 },
      { ...chunk("d3.md", 0, [0, 0, 1, 0], "rent due on the 25th"), score: 0.56 }
    ];

    it("rescues the keyword-matching answer note that pure cosine would rank out of the top-3", () => {
      const candidates = [...decoys, vpn];
      // Pure cosine top-3 = the three decoys; the vpn note (cosine 0.50) is excluded.
      const cosineOnly = diversifyAskChunks(candidates, 3, 0.7).map((p) => p.file);
      expect(cosineOnly).not.toContain("vpn.md");
      // Hybrid with the query: the vpn note's strong lexical overlap surfaces it.
      const hybrid = diversifyAskChunks(candidates, 3, 0.7, "What MTU did I set for the WireGuard VPN?").map((p) => p.file);
      expect(hybrid).toContain("vpn.md");
    });

    it("preserves the absolute cosine score on the rescued chunk (confidence framing intact)", () => {
      const picked = diversifyAskChunks([...decoys, vpn], 3, 0.7, "WireGuard MTU");
      expect(picked.find((p) => p.file === "vpn.md")?.score).toBe(0.50);
    });

    it("falls back to cosine selection when the query has no content tokens (only stopwords)", () => {
      const candidates = [...decoys, vpn];
      const stopwordOnly = diversifyAskChunks(candidates, 3, 0.7, "what is the").map((p) => p.file);
      expect(stopwordOnly).toEqual(diversifyAskChunks(candidates, 3, 0.7).map((p) => p.file));
    });
  });
});
