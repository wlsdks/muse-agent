import { describe, expect, it } from "vitest";

import { parseJson } from "../src/provider-shared.js";

// parseJson is the shared "parse a provider response body, undefined on
// failure" helper every adapter (anthropic/gemini/ollama/openai/base)
// relies on — an undefined return is what turns a 200-with-bad-body into
// a retryable transport anomaly rather than a thrown SyntaxError.
describe("parseJson", () => {
  it("parses every valid JSON value kind", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson("[1,2]")).toEqual([1, 2]);
    expect(parseJson("42")).toBe(42);
    expect(parseJson('"str"')).toBe("str");
    expect(parseJson("true")).toBe(true);
    expect(parseJson("null")).toBeNull();
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(parseJson("")).toBeUndefined();
    expect(parseJson("   ")).toBeUndefined();
  });

  it("returns undefined (never throws) for malformed JSON", () => {
    expect(parseJson("not json")).toBeUndefined();
    expect(parseJson("{partial")).toBeUndefined();
    expect(parseJson('{"a":1}trailing')).toBeUndefined();
  });
});
