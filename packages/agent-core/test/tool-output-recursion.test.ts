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
    // (extractVerifiedSources emits each URL more than once — once from the
    // `url` field, once from the generic string scan; that pre-existing
    // duplication is out of scope here. This test only proves the depth cap
    // doesn't drop shallow, legitimate sources.)
    const urls = new Set(sources.map((s) => s.url));
    expect(urls).toEqual(new Set([
      "https://a.example.com/page",
      "https://b.example.com/page"
    ]));
  });
});
