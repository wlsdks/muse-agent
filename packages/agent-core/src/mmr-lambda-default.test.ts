import { describe, expect, it } from "vitest";

import { rankKnowledgeChunks } from "./knowledge-recall.js";

// Toy 2D embedding space; cosine to the query vector = relevance. Chosen so the
// MMR crossover sits at λ≈0.647: at λ=0.5 the DISTINCT chunk C beats the near-
// duplicate B for the second slot, at λ=0.7 the near-duplicate B wins. This
// pins the NON-HYBRID diversify default to the JSDoc'd 0.5 — under the old 0.7
// the second slot went to B (the near-duplicate), not C.
const VEC: Record<string, readonly number[]> = {
  "what did the budget meeting decide": [1, 0],
  "budget meeting decided marketing stays flat": [0.961, 0.276], // A, top relevance
  "budget meeting decision: marketing stays flat for now": [0.94, 0.342], // B, near-duplicate of A
  "unrelated grocery list milk eggs bread": [0.574, -0.819] // C, distinct but still relevant
};
const embed = (text: string): Promise<readonly number[]> => Promise.resolve(VEC[text] ?? [0, 0]);

const notes = [
  { source: "a.md", text: "budget meeting decided marketing stays flat" },
  { source: "b.md", text: "budget meeting decision: marketing stays flat for now" },
  { source: "c.md", text: "unrelated grocery list milk eggs bread" }
];
const query = "what did the budget meeting decide";

describe("rankKnowledgeChunks non-hybrid diversify default mmrLambda", () => {
  it("defaults to 0.5 — the distinct chunk wins the second slot over the near-duplicate", async () => {
    const matches = await rankKnowledgeChunks(query, notes, { diversify: true, embed, topK: 2 });
    const sources = matches.map((m) => m.source);
    expect(sources).toContain("a.md");
    expect(sources).toContain("c.md");
    expect(sources).not.toContain("b.md");
  });

  it("control: at the explicit old default 0.7 the near-duplicate wins instead", async () => {
    const matches = await rankKnowledgeChunks(query, notes, { diversify: true, embed, mmrLambda: 0.7, topK: 2 });
    const sources = matches.map((m) => m.source);
    expect(sources).toContain("a.md");
    expect(sources).toContain("b.md");
    expect(sources).not.toContain("c.md");
  });
});
