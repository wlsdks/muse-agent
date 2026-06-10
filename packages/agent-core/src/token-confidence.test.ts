import { describe, expect, it } from "vitest";

import { summarizeTokenConfidence } from "./token-confidence.js";

describe("summarizeTokenConfidence", () => {
  it("computes mean/min logprob and perplexity over CONTENT tokens only", () => {
    const summary = summarizeTokenConfidence([
      { logprob: -0.0000001, token: "<|channel>" },
      { logprob: -0.1, token: "the" },
      { logprob: -0.5, token: "answer" }
    ]);
    expect(summary?.scoredTokens).toBe(2);
    expect(summary?.meanLogprob).toBeCloseTo(-0.3, 5);
    expect(summary?.minLogprob).toBeCloseTo(-0.5, 5);
    expect(summary?.perplexity).toBeCloseTo(Math.exp(0.3), 5);
  });

  it("returns undefined when nothing scorable remains (empty or marker-only)", () => {
    expect(summarizeTokenConfidence([])).toBeUndefined();
    expect(summarizeTokenConfidence([{ logprob: -0.1, token: "<|channel>" }])).toBeUndefined();
  });
});
