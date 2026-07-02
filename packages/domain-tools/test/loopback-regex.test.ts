import { describe, expect, it } from "vitest";

import { createRegexMcpServer } from "../src/loopback-regex.js";

const tool = (name: string) => {
  const found = createRegexMcpServer().tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
};
const tooLong = "a".repeat(50_001);

describe("muse.regex ReDoS guard — rejects nested-unbounded-quantifier patterns (catastrophic backtracking)", () => {
  // These hang the whole agent process on a long non-matching input (JS regex can't
  // be timed out on the main thread). The guard rejects at COMPILE time, so a SHORT
  // text here never runs the dangerous regex — and the guard covers all three tools.
  for (const pattern of ["(a+)+$", "(.*)*", "([a-z]+)*", "(a*)*", "([a-z]+){2,}", "(\\d+)+"]) {
    it(`rejects ${pattern} across test/match/replace`, () => {
      expect(tool("test").execute({ pattern, text: "aaa" })).toMatchObject({ error: expect.stringContaining("catastrophic") });
      expect(tool("match").execute({ pattern, text: "aaa" })).toMatchObject({ error: expect.stringContaining("catastrophic") });
      expect(tool("replace").execute({ pattern, replacement: "x", text: "aaa" })).toMatchObject({ error: expect.stringContaining("catastrophic") });
    });
  }
  it("does NOT reject a benign pattern (no nested unbounded quantifier)", () => {
    expect(tool("test").execute({ pattern: "a+b+", text: "aab" })).toEqual({ matched: true });
    expect(tool("test").execute({ pattern: "(\\d+)-(\\d+)", text: "1-2" })).toEqual({ matched: true });
  });
});

describe("muse.regex#test", () => {
  it("reports a match and a non-match with RegExp.test semantics", () => {
    expect(tool("test").execute({ text: "hello", pattern: "ell" })).toEqual({ matched: true });
    expect(tool("test").execute({ text: "hello", pattern: "xyz" })).toEqual({ matched: false });
  });

  it("honours sanitized flags (case-insensitive via 'i')", () => {
    expect(tool("test").execute({ text: "ABC", pattern: "abc", flags: "i" })).toEqual({ matched: true });
    // A non-[gimsuy] flag char is stripped, not fatal.
    expect(tool("test").execute({ text: "ABC", pattern: "abc", flags: "iZ" })).toEqual({ matched: true });
  });

  it("requires text and pattern, and bounds their length", () => {
    expect(tool("test").execute({ pattern: "a" })).toEqual({ error: "text is required" });
    expect(tool("test").execute({ text: "a" })).toEqual({ error: "pattern is required" });
    expect(tool("test").execute({ text: tooLong, pattern: "a" })).toMatchObject({
      error: expect.stringContaining("text must be at most"),
    });
    expect(tool("test").execute({ text: "a", pattern: "a".repeat(257) })).toMatchObject({
      error: expect.stringContaining("pattern must be at most"),
    });
  });

  it("surfaces a compile failure as an error", () => {
    expect(tool("test").execute({ text: "a", pattern: "(" })).toMatchObject({
      error: expect.stringContaining("invalid pattern"),
    });
  });
});

describe("muse.regex#match", () => {
  it("enumerates matches with index and capture groups, forcing the global flag", () => {
    expect(tool("match").execute({ text: "2026-01", pattern: "(\\d+)-(\\d+)" })).toEqual({
      matches: [{ index: 0, value: "2026-01", groups: ["2026", "01"] }],
      truncated: false,
    });
  });

  it("maps an unmatched optional group to an empty string", () => {
    expect(tool("match").execute({ text: "a", pattern: "(x)?(a)" })).toMatchObject({
      matches: [{ index: 0, value: "a", groups: ["", "a"] }],
    });
  });

  it("terminates on a zero-width pattern by advancing past empty matches", () => {
    expect(tool("match").execute({ text: "aab", pattern: "a*" })).toEqual({
      matches: [
        { index: 0, value: "aa" },
        { index: 2, value: "" },
        { index: 3, value: "" },
      ],
      truncated: false,
    });
  });

  it("caps results at maxMatches and flags truncation", () => {
    expect(tool("match").execute({ text: "aaaa", pattern: "a", maxMatches: 2 })).toEqual({
      matches: [
        { index: 0, value: "a" },
        { index: 1, value: "a" },
      ],
      truncated: true,
    });
  });

  it("returns an empty match list (not truncated) when nothing matches", () => {
    expect(tool("match").execute({ text: "x", pattern: "z" })).toEqual({ matches: [], truncated: false });
  });

  it("requires text and pattern and rejects an invalid pattern / over-long text", () => {
    expect(tool("match").execute({ pattern: "a" })).toEqual({ error: "text is required" });
    expect(tool("match").execute({ text: "a" })).toEqual({ error: "pattern is required" });
    expect(tool("match").execute({ text: tooLong, pattern: "a" })).toMatchObject({
      error: expect.stringContaining("text must be at most"),
    });
    expect(tool("match").execute({ text: "a", pattern: "(" })).toMatchObject({
      error: expect.stringContaining("invalid pattern"),
    });
  });
});

describe("muse.regex#replace", () => {
  it("replaces every occurrence and supports capture-group back-references", () => {
    expect(tool("replace").execute({ text: "a-a-a", pattern: "a", replacement: "b" })).toEqual({ result: "b-b-b" });
    expect(tool("replace").execute({ text: "john smith", pattern: "(\\w+) (\\w+)", replacement: "$2 $1" })).toEqual({
      result: "smith john",
    });
  });

  it("requires text, pattern, and replacement", () => {
    expect(tool("replace").execute({ pattern: "a", replacement: "b" })).toEqual({ error: "text is required" });
    expect(tool("replace").execute({ text: "a", replacement: "b" })).toEqual({ error: "pattern is required" });
    expect(tool("replace").execute({ text: "a", pattern: "a" })).toEqual({ error: "replacement is required" });
  });

  it("bounds text length and rejects an invalid pattern", () => {
    expect(tool("replace").execute({ text: tooLong, pattern: "a", replacement: "b" })).toMatchObject({
      error: expect.stringContaining("text must be at most"),
    });
    expect(tool("replace").execute({ text: "a", pattern: "(", replacement: "b" })).toMatchObject({
      error: expect.stringContaining("invalid pattern"),
    });
  });
});
