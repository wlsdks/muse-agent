import { describe, expect, it } from "vitest";

import { rankKnowledgeChunks } from "./knowledge-recall.js";

// Toy embedding space: axis 0 = "budget meeting" topic, axis 1 = junk.
const VEC: Record<string, readonly number[]> = {
  "grocery budget list: milk, eggs, bread": [0.1, 0.99],
  "q3 budget meeting decided marketing spend stays flat": [1, 0],
  "q3 budget meeting follow-up: marketing spend review next week": [0.97, 0.05],
  "what did the q3 budget meeting decide about marketing spend": [1, 0],
  "workout plan monday wednesday friday": [0, 1]
};
const embed = (text: string): Promise<readonly number[]> => Promise.resolve(VEC[text] ?? [0, 0]);

describe("hybrid + diversify MMR uses a relevance on the SAME scale as the diversity penalty", () => {
  it("keeps the second-most-relevant chunk instead of swapping it for near-noise (audit finding 2)", async () => {
    const notes = [
      { source: "a.md", text: "q3 budget meeting decided marketing spend stays flat" },
      { source: "b.md", text: "q3 budget meeting follow-up: marketing spend review next week" },
      { source: "junk.md", text: "grocery budget list: milk, eggs, bread" },
      { source: "d.md", text: "workout plan monday wednesday friday" }
    ];
    const matches = await rankKnowledgeChunks(
      "what did the q3 budget meeting decide about marketing spend",
      notes,
      { diversify: true, embed, hybrid: true, topK: 2 }
    );
    const sources = matches.map((m) => m.source);
    expect(sources).toContain("a.md");
    expect(sources).toContain("b.md");
    expect(sources).not.toContain("junk.md");
  });
});
