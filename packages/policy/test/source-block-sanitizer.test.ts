import { describe, expect, it } from "vitest";
import { sanitizeSourceBlocks } from "../src/index.js";

describe("sanitizeSourceBlocks", () => {
  it("removes copied linked source sections at the end of a response", () => {
    const result = sanitizeSourceBlocks([
      "The answer is 42.",
      "",
      "Sources:",
      "- [Invoice docs](https://example.test/invoice)"
    ].join("\n"));

    expect(result).toEqual({
      content: "The answer is 42.",
      reason: "linked_source_block",
      removed: true
    });
  });

  it("removes empty fallback source sections", () => {
    const result = sanitizeSourceBlocks([
      "I do not have enough evidence.",
      "",
      "Sources:",
      "- No verified sources."
    ].join("\n"));

    expect(result).toEqual({
      content: "I do not have enough evidence.",
      reason: "empty_source_block",
      removed: true
    });
  });

  it("leaves a response with NO source heading completely unchanged (the common case)", () => {
    // The most frequent input — a plain answer with no Sources/출처 section — must
    // pass straight through (the !sourceBlock early return), never altered.
    const plain = "The capital of France is Paris. A plain factual answer.";
    expect(sanitizeSourceBlocks(plain)).toEqual({ content: plain, removed: false });
  });

  it("trims trailing blank lines below a removable block before classifying it", () => {
    // A model often leaves blank lines after the source section; trimTrailingBlankLines
    // must drop them so the block still classifies (here: empty fallback → removed)
    // and the kept content has no dangling whitespace.
    const result = sanitizeSourceBlocks([
      "I do not have enough evidence.", "", "Sources:", "- No verified sources.", "", "", ""
    ].join("\n"));
    expect(result).toEqual({ content: "I do not have enough evidence.", reason: "empty_source_block", removed: true });
  });

  it("keeps narrative source mentions that are not a source list", () => {
    const result = sanitizeSourceBlocks("Sources: this word appears in the user-provided sentence.");

    expect(result).toEqual({
      content: "Sources: this word appears in the user-provided sentence.",
      removed: false
    });
  });

  it("strips an inline empty fallback on the heading line itself", () => {
    expect(sanitizeSourceBlocks("Answer is 42.\n\nSources: none")).toEqual({
      content: "Answer is 42.",
      reason: "empty_source_block",
      removed: true
    });
  });

  it("strips a bare dangling heading at end-of-response (truncated section)", () => {
    expect(sanitizeSourceBlocks("The answer.\n\nSources:")).toEqual({
      content: "The answer.",
      reason: "empty_source_block",
      removed: true
    });
  });

  it("strips only the trailing fallback, keeping a real cited block above it", () => {
    expect(
      sanitizeSourceBlocks("Answer.\n\nSources:\n- https://example.com/x\n\nReferences: none")
    ).toEqual({
      content: "Answer.\n\nSources:\n- https://example.com/x",
      reason: "empty_source_block",
      removed: true
    });
  });

  it("does NOT remove when real content follows a Sources:-looking line (over-removal guard)", () => {
    const input = "Sources: see below\nReal content paragraph.\nMore real content.";
    expect(sanitizeSourceBlocks(input)).toEqual({ content: input, removed: false });
  });

  it("treats a doi:/arxiv: reference list as a linked source block", () => {
    expect(sanitizeSourceBlocks("Done.\nReferences:\n[1] doi:10.1/abc")).toEqual({
      content: "Done.",
      reason: "linked_source_block",
      removed: true
    });
  });

  it("strips a Korean empty-source block (출처: 없음) — Muse is Korean-first; a Qwen 출처 fallback must be recognised like the English Sources: None", () => {
    expect(sanitizeSourceBlocks("답변입니다.\n\n출처: 없음")).toEqual({
      content: "답변입니다.",
      reason: "empty_source_block",
      removed: true
    });
    expect(sanitizeSourceBlocks("답변입니다.\n\n출처:\n- 확인된 출처 없음")).toEqual({
      content: "답변입니다.",
      reason: "empty_source_block",
      removed: true
    });
    expect(sanitizeSourceBlocks("답변입니다.\n\n참고 자료: 해당 없음")).toEqual({
      content: "답변입니다.",
      reason: "empty_source_block",
      removed: true
    });
  });

  it("strips a Korean linked-source block (출처 heading + URL list)", () => {
    expect(sanitizeSourceBlocks("답변.\n\n출처:\n- https://ko.wikipedia.org/wiki/x")).toEqual({
      content: "답변.",
      reason: "linked_source_block",
      removed: true
    });
  });

  it("does NOT strip a legitimate Korean 참고: prose note (no URL, not an empty-fallback) — the classifier gates removal", () => {
    const input = "본문입니다.\n\n참고: 이 내용은 추정이며 확정이 아닙니다.";
    expect(sanitizeSourceBlocks(input)).toEqual({ content: input, removed: false });
  });
});
