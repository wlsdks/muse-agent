import { describe, expect, it } from "vitest";

import { extractFirstJsonArray, iterateJsonArrayCandidates } from "../src/json-array-scan.js";

describe("extractFirstJsonArray", () => {
  it("returns a plain top-level array verbatim", () => {
    expect(extractFirstJsonArray("[1,2,3]")).toBe("[1,2,3]");
  });

  it("returns null when no balanced span parses as an array", () => {
    expect(extractFirstJsonArray("no brackets here")).toBeNull();
    expect(extractFirstJsonArray("[1,2")).toBeNull();
    expect(extractFirstJsonArray("{\"a\":1}")).toBeNull();
  });

  it("skips prose-bracket collisions and returns the real array", () => {
    // The whole reason this scanner exists: a markdown range / checkbox /
    // citation collides with the `[` delimiter but is not valid JSON.
    expect(extractFirstJsonArray('items [1-3]: ["a","b"]')).toBe('["a","b"]');
    expect(extractFirstJsonArray("- [x] todo [1]")).toBe("[1]");
  });

  it("treats a citation like [2] as a valid array (it parses) — caller filters by shape", () => {
    expect(extractFirstJsonArray("see [2] for details")).toBe("[2]");
  });

  it("does not let a ] inside a string value close the span early", () => {
    expect(extractFirstJsonArray('["a]b"]')).toBe('["a]b"]');
    expect(extractFirstJsonArray('["][", "x"]')).toBe('["][", "x"]');
  });

  it("respects escaped quotes and escaped backslashes inside string values", () => {
    expect(extractFirstJsonArray('["a\\"b"]')).toBe('["a\\"b"]');
    expect(extractFirstJsonArray('["a\\\\"]')).toBe('["a\\\\"]');
  });

  it("returns the empty array span", () => {
    expect(extractFirstJsonArray("plan: []")).toBe("[]");
  });

  it("picks the outer valid array, not its nested args:[] interior", () => {
    const plan = '[{"tool":"x","args":[]}]';
    expect(extractFirstJsonArray(`here is the plan ${plan}`)).toBe(plan);
  });

  it("resumes PAST an invalid balanced span — a valid array nested inside it is intentionally not surfaced", () => {
    // Deliberate trade-off documented in the module: descending into an
    // invalid outer span would re-introduce the args:[] false-positive.
    expect(extractFirstJsonArray('x [garbage [{"a":1}] y]')).toBeNull();
  });
});

describe("iterateJsonArrayCandidates", () => {
  it("yields every valid top-level array in order and skips invalid balanced spans", () => {
    const spans = [...iterateJsonArrayCandidates('a [1] b ["x"] c [bad] d [3,4]')].map((c) => c.text);
    expect(spans).toEqual(["[1]", '["x"]', "[3,4]"]);
  });

  it("exposes the parsed value alongside the source text", () => {
    const [first] = [...iterateJsonArrayCandidates('prefix [{"k":1}] suffix')];
    expect(first?.text).toBe('[{"k":1}]');
    expect(first?.value).toEqual([{ k: 1 }]);
  });

  it("terminates (bounded scan) on repetition-degenerate unbalanced input instead of hanging", () => {
    const degenerate = "[".repeat(50_000);
    expect([...iterateJsonArrayCandidates(degenerate)]).toEqual([]);
  });
});
