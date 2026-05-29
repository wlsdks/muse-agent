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

// Property fuzz (backlog P5) — this scanner parses UNTRUSTED local-model output,
// so the universal invariants must hold over a large adversarial corpus, not
// just the curated cases above: it never throws, and anything it surfaces is a
// genuine JSON-array substring of the input. A deterministic LCG keeps the
// corpus reproducible (no Math.random flake).
describe("json-array-scan — property fuzz (never-throws + only-valid-array-substrings)", () => {
  const corpus = (): string[] => {
    const atoms = ["[", "]", "{", "}", "\"", "\\", ":", ",", " ", "\n", "1", "ab", "x]y", "true", "null",
      "- [x]", "[2]", "[1-3]", '[{"tool":"t","args":{},"description":"d"}]', '{"a":"]"}', "prose here", "🙂", '"esc\\"q"'];
    let state = 0x51a4c2;
    const rand = (n: number): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
    const out: string[] = ["", "[", "][", "[[]]", "[}", "[1,2,", "no brackets at all"];
    for (let i = 0; i < 300; i += 1) {
      out.push(Array.from({ length: 1 + rand(12) }, () => atoms[rand(atoms.length)]).join(""));
    }
    return out;
  };
  const CORPUS = corpus();

  it("never throws; extractFirstJsonArray returns null OR a JSON-array substring of the input", () => {
    for (const text of CORPUS) {
      let result: string | null = null;
      expect(() => { result = extractFirstJsonArray(text); }).not.toThrow();
      if (result !== null) {
        expect(text.includes(result), `must be a substring: ${JSON.stringify(result)}`).toBe(true);
        const parsed: unknown = JSON.parse(result); // must not throw — the scanner JSON-validated it
        expect(Array.isArray(parsed)).toBe(true);
      }
    }
  });

  it("every iterate candidate is a JSON-array substring whose value equals its parsed text; extractFirst is the first candidate", () => {
    for (const text of CORPUS) {
      let candidates: { text: string; value: readonly unknown[] }[] = [];
      expect(() => { candidates = [...iterateJsonArrayCandidates(text)]; }).not.toThrow();
      for (const c of candidates) {
        expect(text.includes(c.text)).toBe(true);
        const parsed: unknown = JSON.parse(c.text);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toEqual(c.value); // .value is exactly JSON.parse(.text)
      }
      expect(extractFirstJsonArray(text)).toBe(candidates[0]?.text ?? null);
    }
  });
});
