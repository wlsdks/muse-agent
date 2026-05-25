import { describe, expect, it } from "vitest";

import { extractVerifiedSources, extractToolInsights } from "../src/tool-output-evidence.js";

// Tool output is untrusted (CLAUDE.md). A deeply nested JSON payload from a
// buggy/hostile MCP server overflowed the recursive walk (RangeError ~5000
// levels) and crashed evidence extraction. These pin the depth cap.
describe("tool-output-evidence — recursion safety on deep untrusted JSON", () => {
  function deepResultChain(levels: number): string {
    return `${'{"result":'.repeat(levels)}{"url":"https://x.com"}${"}".repeat(levels)}`;
  }

  function deeplyNestedArray(levels: number): string {
    let inner = `[{"url":"https://y.com"}]`;
    for (let i = 0; i < levels; i += 1) inner = `[${inner}]`;
    return inner;
  }

  it("does not overflow on a deep .result chain", () => {
    expect(() => extractVerifiedSources("web_search", deepResultChain(10_000))).not.toThrow();
    expect(() => extractToolInsights(deepResultChain(10_000))).not.toThrow();
  });

  it("does not overflow on a deeply nested array", () => {
    expect(() => extractVerifiedSources("web_search", deeplyNestedArray(10_000))).not.toThrow();
  });

  it("still extracts sources from normal shallow tool output (no over-truncation)", () => {
    const output = JSON.stringify({
      results: [
        { title: "Doc A", url: "https://a.example.com/page" },
        { title: "Doc B", url: "https://b.example.com/page" }
      ]
    });
    const sources = extractVerifiedSources("web_search", output);
    // De-duped by url (finding from round 12, fixed round 14): each url
    // appears ONCE, keeping the real `title` field (not the url-derived one).
    expect(sources).toEqual([
      { title: "Doc A", toolName: "web_search", url: "https://a.example.com/page" },
      { title: "Doc B", toolName: "web_search", url: "https://b.example.com/page" }
    ]);
  });

  it("de-dupes a url emitted by both the field match and the generic scan", () => {
    const sources = extractVerifiedSources(
      "web_search",
      JSON.stringify({ results: [{ title: "Doc A", url: "https://a.example.com/p" }] })
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toEqual({ title: "Doc A", toolName: "web_search", url: "https://a.example.com/p" });
  });
});
