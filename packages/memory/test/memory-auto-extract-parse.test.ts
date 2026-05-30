import { describe, expect, it } from "vitest";

import { extractJsonObject, pickAutoExtractSystemPrompt } from "../src/memory-auto-extract.js";

// Coverage for the pure parse/route helpers of the user-memory auto-extractor
// (the module had no direct test). extractJsonObject is the UNTRUSTED-boundary
// parser: it turns a small local model's raw, often-messy output into the
// structured ExtractionPayload that drives memory writes — so it must tolerate
// code fences, prose, and (critically) a model that echoes the schema BEFORE
// the real payload. pickAutoExtractSystemPrompt routes by Hangul ratio.

describe("extractJsonObject", () => {
  it("parses a direct JSON object", () => {
    expect(extractJsonObject('{"facts":{"a":"b"}}')).toEqual({ facts: { a: "b" } });
  });

  it("strips a ```json fenced block and a bare ``` fence", () => {
    expect(extractJsonObject('```json\n{"facts":{"x":"y"}}\n```')).toEqual({ facts: { x: "y" } });
    expect(extractJsonObject('```\n{"goals":[]}\n```')).toEqual({ goals: [] });
  });

  it("takes the LAST parseable block when the model echoes the schema/example FIRST", () => {
    // Small local models often print the schema or an empty example before the
    // real extraction; taking the first block would silently discard the answer.
    const raw = 'Example: {"facts":{}}\nHere is the real one:\n{"facts":{"spouse":"Mina"}}';
    expect(extractJsonObject(raw)).toEqual({ facts: { spouse: "Mina" } });
  });

  it("recovers a JSON object embedded in surrounding prose", () => {
    expect(extractJsonObject('Sure! {"preferences":{"tone":"concise"}} hope that helps'))
      .toEqual({ preferences: { tone: "concise" } });
  });

  it("does not let braces INSIDE a string value break the block balance", () => {
    expect(extractJsonObject('{"facts":{"note":"use { and } carefully"}}'))
      .toEqual({ facts: { note: "use { and } carefully" } });
  });

  it("returns undefined for empty, non-JSON, or a top-level array (must be an object)", () => {
    expect(extractJsonObject("   ")).toBeUndefined();
    expect(extractJsonObject("not json at all")).toBeUndefined();
    expect(extractJsonObject("[1,2,3]")).toBeUndefined();
  });
});

describe("pickAutoExtractSystemPrompt", () => {
  it("picks the Korean prompt when Hangul is ≥ 30% of the text, else English", () => {
    expect(pickAutoExtractSystemPrompt("내 아내 이름은 미나야").startsWith("이번 대화")).toBe(true);
    expect(pickAutoExtractSystemPrompt("What time is it?").startsWith("You analyse")).toBe(true);
  });

  it("defaults to English for empty input and for mixed text below the 30% Hangul threshold", () => {
    expect(pickAutoExtractSystemPrompt("").startsWith("You analyse")).toBe(true);
    expect(pickAutoExtractSystemPrompt("Please summarize this 회의 in English with lots of detail").startsWith("You analyse")).toBe(true);
  });
});
