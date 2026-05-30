import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  createKvSummarizeTool,
  createMarkdownTableTool,
  createSlugifyTool,
  createTextStatsTool
} from "../src/muse-tools-text.js";

// Direct OUTPUT-correctness coverage for the built-in text-formatting tools
// (untested module). eval:tools proves the model SELECTS them; this proves the
// handler renders the RIGHT output. All pure known-answer.

const run = (tool: { execute: (a: JsonObject) => JsonObject }, args: JsonObject): JsonObject => tool.execute(args);

describe("text_stats", () => {
  const stats = createTextStatsTool();
  it("counts words, graphemes, and lines", () => {
    expect(run(stats, { text: "hello world\nfoo" })).toEqual({ characters: 15, lines: 2, words: 3 });
  });

  it("returns all-zero counts for whitespace-only input", () => {
    expect(run(stats, { text: "   \n  " })).toEqual({ characters: 0, lines: 0, words: 0 });
  });

  it("counts a ZWJ emoji sequence as ONE user-perceived character (grapheme, not UTF-16 units)", () => {
    // a + family-emoji (man-ZWJ-woman-ZWJ-girl) + b: 3 graphemes but many code
    // units — text.length would over-count. Built from \u escapes so the source
    // carries no raw zero-width (ZWJ) byte (repo byte-hygiene gate).
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    expect(run(stats, { text: `a${family}b` })).toEqual({ characters: 3, lines: 1, words: 1 });
  });
});

describe("slugify", () => {
  const slug = createSlugifyTool();
  it("lowercases, collapses non-alphanumerics to '-', and strips edge dashes", () => {
    expect(run(slug, { text: "  Hello, World!  " })).toEqual({ slug: "hello-world" });
  });

  it("strips diacritics via NFKD normalization", () => {
    expect(run(slug, { text: "Café Münchën" })).toEqual({ slug: "cafe-munchen" });
  });

  it("returns 'untitled' for input with no alphanumerics", () => {
    expect(run(slug, { text: "!!!" })).toEqual({ slug: "untitled" });
  });

  it("truncates to maxLength and re-trims a trailing dash", () => {
    expect(run(slug, { maxLength: 8, text: "hello-world-foo" })).toEqual({ slug: "hello-wo" });
    expect(run(slug, { maxLength: 6, text: "ab cd ef" })).toEqual({ slug: "ab-cd" }); // "ab-cd-" → trailing dash trimmed
  });
});

describe("kv_summarize", () => {
  const kv = createKvSummarizeTool();
  it("flattens nested objects/arrays with dotted keys and indices", () => {
    expect(run(kv, { data: { a: 1, b: { c: "x" }, d: [true, null] } }))
      .toEqual({ summary: "a: 1\nb.c: x\nd.0: true\nd.1: null" });
  });

  it("marks empty arrays/objects explicitly and returns '' for null data", () => {
    expect(run(kv, { data: { e: [], o: {} } })).toEqual({ summary: "e: []\no: {}" });
    expect(run(kv, { data: null })).toEqual({ summary: "" });
  });
});

describe("markdown_table", () => {
  const table = createMarkdownTableTool();
  it("derives the column union (first-appearance) and fills missing cells empty", () => {
    expect(run(table, { rows: [{ a: 1, b: 2 }, { a: 3, c: 4 }] }))
      .toEqual({ markdown: "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 |  | 4 |" });
  });

  it("honors an explicit column order", () => {
    expect(run(table, { columns: ["b", "a"], rows: [{ a: 1, b: 2 }] }))
      .toEqual({ markdown: "| b | a |\n| --- | --- |\n| 2 | 1 |" });
  });

  it("renders a nested cell as compact JSON (not '[object Object]')", () => {
    expect(run(table, { rows: [{ x: { k: 1 } }] })).toEqual({ markdown: '| x |\n| --- |\n| {"k":1} |' });
  });

  it("escapes pipes and newlines in cells", () => {
    expect(run(table, { rows: [{ v: "a|b\nc" }] })).toEqual({ markdown: "| v |\n| --- |\n| a\\|b<br/>c |" });
  });

  it("returns an empty string when there are no rows", () => {
    expect(run(table, { rows: [] })).toEqual({ markdown: "" });
  });
});
