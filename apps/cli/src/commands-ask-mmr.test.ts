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
});
