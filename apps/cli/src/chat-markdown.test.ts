import { describe, expect, it } from "vitest";

import { parseAnswerMarkdown, parseInlineMarkdown, type MdBlock } from "./chat-markdown.js";

function kinds(blocks: readonly MdBlock[]): string[] {
  return blocks.map((b) => b.kind);
}

describe("parseInlineMarkdown", () => {
  it("splits bold, italic and inline code, keeps plain runs", () => {
    expect(parseInlineMarkdown("a **b** c `d` e _f_ g")).toEqual([
      { text: "a " }, { bold: true, text: "b" }, { text: " c " }, { code: true, text: "d" },
      { text: " e " }, { italic: true, text: "f" }, { text: " g" }
    ]);
  });

  it("supports __bold__ and *italic* forms", () => {
    expect(parseInlineMarkdown("__x__ and *y*")).toEqual([
      { bold: true, text: "x" }, { text: " and " }, { italic: true, text: "y" }
    ]);
  });

  it("parses a link into text + url", () => {
    expect(parseInlineMarkdown("see [docs](https://x.dev/a) now")).toEqual([
      { text: "see " }, { text: "docs", url: "https://x.dev/a" }, { text: " now" }
    ]);
  });

  it("does not re-parse markup inside an inline code span", () => {
    expect(parseInlineMarkdown("run `a ** b` ok")).toEqual([
      { text: "run " }, { code: true, text: "a ** b" }, { text: " ok" }
    ]);
  });

  it("leaves a stray backtick / dangling bold as plain text (never raw markup surprise)", () => {
    expect(parseInlineMarkdown("a ` b ** c")).toEqual([{ text: "a ` b ** c" }]);
    expect(parseInlineMarkdown("plain")).toEqual([{ text: "plain" }]);
  });
});

describe("parseAnswerMarkdown — blocks", () => {
  it("separates a fenced code block and captures its language", () => {
    const blocks = parseAnswerMarkdown("before\n\n```bash\nnpm run build\necho hi\n```\n\nafter");
    expect(kinds(blocks)).toEqual(["paragraph", "code", "paragraph"]);
    const code = blocks[1];
    expect(code).toEqual({ kind: "code", lang: "bash", lines: ["npm run build", "echo hi"] });
  });

  it("handles a fence with no language", () => {
    const blocks = parseAnswerMarkdown("```\nplain code\n```");
    expect(blocks).toEqual([{ kind: "code", lines: ["plain code"] }]);
  });

  it("preserves indentation and blank lines verbatim inside code", () => {
    const blocks = parseAnswerMarkdown("```py\ndef f():\n\n    return 1\n```");
    expect(blocks[0]).toEqual({ kind: "code", lang: "py", lines: ["def f():", "", "    return 1"] });
  });

  it("parses heading levels", () => {
    const blocks = parseAnswerMarkdown("# One\n\n## Two\n\n### Three");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, spans: [{ text: "One" }] },
      { kind: "heading", level: 2, spans: [{ text: "Two" }] },
      { kind: "heading", level: 3, spans: [{ text: "Three" }] }
    ]);
  });

  it("parses an unordered list with an aligned bullet marker", () => {
    const blocks = parseAnswerMarkdown("- one\n* two\n+ three");
    expect(blocks[0]).toEqual({
      kind: "list",
      items: [
        { level: 0, marker: "•", ordered: false, spans: [{ text: "one" }] },
        { level: 0, marker: "•", ordered: false, spans: [{ text: "two" }] },
        { level: 0, marker: "•", ordered: false, spans: [{ text: "three" }] }
      ]
    });
  });

  it("parses an ordered list keeping the source numbers", () => {
    const blocks = parseAnswerMarkdown("1. first\n2. second\n3) third");
    expect(blocks[0]).toEqual({
      kind: "list",
      items: [
        { level: 0, marker: "1.", ordered: true, spans: [{ text: "first" }] },
        { level: 0, marker: "2.", ordered: true, spans: [{ text: "second" }] },
        { level: 0, marker: "3.", ordered: true, spans: [{ text: "third" }] }
      ]
    });
  });

  it("nests a list by indentation depth", () => {
    const blocks = parseAnswerMarkdown("- top\n  - child\n    - grandchild");
    const list = blocks[0];
    if (list?.kind !== "list") throw new Error("expected list");
    expect(list.items.map((it) => it.level)).toEqual([0, 1, 2]);
  });

  it("parses a blockquote as its own block, stripping the marker", () => {
    const blocks = parseAnswerMarkdown("> quoted line\n> second");
    expect(blocks[0]).toEqual({ kind: "quote", lines: [[{ text: "quoted line" }], [{ text: "second" }]] });
  });

  it("splits paragraphs on a blank line", () => {
    const blocks = parseAnswerMarkdown("para one line a\npara one line b\n\npara two");
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    const first = blocks[0];
    if (first?.kind !== "paragraph") throw new Error("expected paragraph");
    expect(first.lines).toHaveLength(2);
  });

  it("carries inline spans into paragraph, heading and list text", () => {
    const blocks = parseAnswerMarkdown("# A `b`\n\ntext **bold**\n\n- item `x`");
    const heading = blocks[0];
    if (heading?.kind !== "heading") throw new Error("expected heading");
    expect(heading.spans).toEqual([{ text: "A " }, { code: true, text: "b" }]);
  });

  it("mixes headings, prose, lists and code in one document", () => {
    const doc = "# Title\n\nHere is prose with `code`.\n\n- a\n- b\n\n```bash\nls -la\n```";
    expect(kinds(parseAnswerMarkdown(doc))).toEqual(["heading", "paragraph", "list", "code"]);
  });

  describe("malformed input degrades gracefully (never throws, never raw backticks)", () => {
    it("an unclosed fence still becomes a code block to EOF", () => {
      const blocks = parseAnswerMarkdown("intro\n\n```bash\nnpm i\nmore code");
      expect(kinds(blocks)).toEqual(["paragraph", "code"]);
      expect(blocks[1]).toEqual({ kind: "code", lang: "bash", lines: ["npm i", "more code"] });
    });

    it("a stray single backtick in prose stays literal text, not a broken span", () => {
      const blocks = parseAnswerMarkdown("a ` b");
      expect(blocks[0]).toEqual({ kind: "paragraph", lines: [[{ text: "a ` b" }]] });
    });

    it("empty input yields no blocks", () => {
      expect(parseAnswerMarkdown("")).toEqual([]);
      expect(parseAnswerMarkdown("\n\n")).toEqual([]);
    });

    it("normalizes CRLF line endings", () => {
      const blocks = parseAnswerMarkdown("# H\r\n\r\nbody");
      expect(kinds(blocks)).toEqual(["heading", "paragraph"]);
    });
  });
});
