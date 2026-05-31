import { describe, expect, it } from "vitest";

import { cosineSimilarity } from "../src/episodic-recall.js";
import { lexicalOverlap, lexicalTokens } from "../src/knowledge-recall.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical (and same-direction scaled) vectors, -1 for opposite, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10); // scale-invariant
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns 0 for empty, length-mismatched, or zero-magnitude inputs (no NaN escapes)", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0); // mismatched length
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // zero vector → would be 0/0 = NaN, guarded to 0
  });
});

describe("lexicalTokens", () => {
  it("lowercases, splits on non-alphanumerics, dedupes, and drops <2-char tokens + stopwords", () => {
    expect([...lexicalTokens("The Quick brown Fox, fox!")].sort()).toEqual(["brown", "fox", "quick"]);
  });

  it("returns an empty set when everything is a stopword or too short", () => {
    expect([...lexicalTokens("a I the is at on of")]).toEqual([]);
  });
});

describe("lexicalOverlap", () => {
  it("counts shared content tokens between the query set and the text", () => {
    expect(lexicalOverlap(lexicalTokens("Q3 budget review"), "the q3 budget plan")).toBe(2); // q3 + budget
  });

  it("is 0 for an empty query set", () => {
    expect(lexicalOverlap(new Set(), "anything at all")).toBe(0);
  });
});
