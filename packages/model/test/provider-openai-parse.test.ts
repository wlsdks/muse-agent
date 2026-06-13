import { describe, expect, it } from "vitest";

import { parseOpenAIToolCalls, parseOpenAIUsage, parseToolArguments, readOpenAIContent } from "../src/provider-openai-parse.js";

describe("readOpenAIContent", () => {
  it("returns a plain string content as-is", () => {
    expect(readOpenAIContent("hello")).toBe("hello");
  });

  it("joins the text parts of an array content, dropping non-text entries", () => {
    expect(readOpenAIContent([{ text: "a" }, { foo: 1 }, { text: "b" }])).toBe("ab");
  });

  it("returns empty string for an unrecognised shape", () => {
    expect(readOpenAIContent(42)).toBe("");
  });
});

describe("parseToolArguments", () => {
  it("returns an object argument unchanged", () => {
    expect(parseToolArguments({ city: "Seoul" })).toEqual({ city: "Seoul" });
  });

  it("parses a JSON-string argument", () => {
    expect(parseToolArguments('{"n":5}')).toEqual({ n: 5 });
  });

  it("returns {} for invalid / non-object JSON", () => {
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments("[1,2]")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
  });
});

describe("parseOpenAIToolCalls", () => {
  it("maps function tool calls, defaulting a missing id", () => {
    expect(
      parseOpenAIToolCalls([{ function: { name: "search", arguments: '{"q":"x"}' } }])
    ).toEqual([{ arguments: { q: "x" }, id: "tool_call_0", name: "search" }]);
  });

  it("returns undefined for a non-array or empty input", () => {
    expect(parseOpenAIToolCalls(undefined)).toBeUndefined();
    expect(parseOpenAIToolCalls([])).toBeUndefined();
  });
});

describe("parseOpenAIUsage", () => {
  it("maps the usage token fields", () => {
    expect(parseOpenAIUsage({ prompt_tokens: 10, completion_tokens: 4 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 4
    });
  });

  it("returns undefined for a non-object usage", () => {
    expect(parseOpenAIUsage(null)).toBeUndefined();
  });
});
