import { describe, expect, it } from "vitest";

import { candidatePhrases, rakeKeyphrases } from "./keyphrase.js";

describe("candidatePhrases — stopwords/punctuation/numbers split phrases (spaces do not)", () => {
  it("keeps runs of content words, breaking on stopwords and punctuation", () => {
    expect(candidatePhrases("The solar panel array, and the billing system.")).toEqual([
      ["solar", "panel", "array"],
      ["billing", "system"]
    ]);
  });

  it("breaks on a period even with no surrounding stopword (punctuation is a delimiter)", () => {
    expect(candidatePhrases("alpha beta. gamma.")).toEqual([["alpha", "beta"], ["gamma"]]);
  });

  it("drops pure numbers, single chars, and stopwords as delimiters", () => {
    expect(candidatePhrases("migrate 3 servers off X today")).toEqual([["migrate"], ["servers"], ["today"]]);
  });

  it("chunks a content run longer than the phrase cap", () => {
    expect(candidatePhrases("one two three four five six", 4)).toEqual([
      ["one", "two", "three", "four"],
      ["five", "six"]
    ]);
  });

  it("returns [] for stopword-only / empty text", () => {
    expect(candidatePhrases("the and of to")).toEqual([]);
    expect(candidatePhrases("   ")).toEqual([]);
  });
});

describe("rakeKeyphrases — RAKE (Rose et al. 2010)", () => {
  const doc = [
    "The solar panel array is here.",
    "We saw the solar panel array.",
    "The solar panel array is ready.",
    "The weather was nice."
  ].join(" ");

  it("surfaces the dominant multi-word topic at the top", () => {
    const out = rakeKeyphrases(doc, { limit: 5 });
    expect(out[0]!.phrase).toBe("solar panel array");
  });

  it("a multi-word topic outscores an incidental single word", () => {
    const out = rakeKeyphrases(doc, { limit: 10 });
    const arr = out.find((k) => k.phrase === "solar panel array")!.score;
    const weather = out.find((k) => k.phrase === "weather")?.score ?? 0;
    expect(arr).toBeGreaterThan(weather);
  });

  it("deduplicates a repeated phrase (scored once) and honours the limit", () => {
    const out = rakeKeyphrases(doc, { limit: 3 });
    expect(out.length).toBe(3);
    expect(out.filter((k) => k.phrase === "solar panel array")).toHaveLength(1);
  });

  it("a single-word phrase scores 1; a clean two-word phrase scores higher", () => {
    // "alpha beta" → each word deg 2 / freq 1 = 2, phrase = 4; "gamma" → 1.
    const out = rakeKeyphrases("alpha beta. gamma.", { limit: 5 });
    expect(out[0]!.phrase).toBe("alpha beta");
    expect(out[0]!.score).toBeCloseTo(4, 5);
    expect(out.find((k) => k.phrase === "gamma")!.score).toBeCloseTo(1, 5);
  });

  it("returns [] when there are no content words", () => {
    expect(rakeKeyphrases("the and of to")).toEqual([]);
  });
});
