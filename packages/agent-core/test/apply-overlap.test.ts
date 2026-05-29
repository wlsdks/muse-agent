import { describe, expect, it } from "vitest";

import { applyOverlap } from "../src/knowledge-recall.js";

describe("applyOverlap", () => {
  it("returns a copy unchanged when there is nothing to overlap", () => {
    expect(applyOverlap([], 10)).toEqual([]);
    expect(applyOverlap(["only chunk here"], 5)).toEqual(["only chunk here"]);
  });

  it("treats a zero / negative / non-finite overlap as no overlap", () => {
    expect(applyOverlap(["aaa", "bbb"], 0)).toEqual(["aaa", "bbb"]);
    expect(applyOverlap(["aaa", "bbb"], -5)).toEqual(["aaa", "bbb"]);
    expect(applyOverlap(["aaa", "bbb"], Number.NaN)).toEqual(["aaa", "bbb"]);
    expect(applyOverlap(["aaaaa", "bbb"], Number.POSITIVE_INFINITY)).toEqual(["aaaaa", "bbb"]);
  });

  it("prepends the previous chunk's tail (joined by a blank line) to each later chunk", () => {
    // tail of "hello world foo" at width 6 = "ld foo"; its only space sits
    // past the front 30%, so the raw tail is kept.
    expect(applyOverlap(["hello world foo", "next chunk"], 6)).toEqual(["hello world foo", "ld foo\n\nnext chunk"]);
  });

  it("starts the tail at a word boundary when whitespace falls in the front of the tail", () => {
    // tail of "xx hello" at width 6 = " hello"; the leading space is within
    // the front 30%, so the tail is trimmed to "hello" to avoid a mid-token start.
    expect(applyOverlap(["xx hello", "next"], 6)).toEqual(["xx hello", "hello\n\nnext"]);
  });

  it("clamps the overlap width to the previous chunk length", () => {
    expect(applyOverlap(["abc", "xyz"], 100)).toEqual(["abc", "abc\n\nxyz"]);
  });

  it("adds no prefix when the previous chunk is empty", () => {
    expect(applyOverlap(["", "second"], 5)).toEqual(["", "second"]);
  });

  it("chains the overlap across three or more chunks", () => {
    expect(applyOverlap(["alpha beta", "gamma delta", "epsilon"], 6)).toEqual([
      "alpha beta",
      "a beta\n\ngamma delta",
      "delta\n\nepsilon",
    ]);
  });
});
