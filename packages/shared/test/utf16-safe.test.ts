import { describe, expect, it } from "vitest";
import { sliceUtf16Safe, truncateUtf16Safe } from "../src/index.js";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

describe("truncateUtf16Safe", () => {
  it("is byte-identical to slice() for BMP text (Korean, ASCII) with no astral char at the boundary", () => {
    const ko = "안녕하세요 반갑습니다";
    expect(truncateUtf16Safe(ko, 5)).toBe(ko.slice(0, 5));
    expect(truncateUtf16Safe(ko, 5)).toBe("안녕하세요");

    const ascii = "hello world";
    expect(truncateUtf16Safe(ascii, 5)).toBe(ascii.slice(0, 5));
  });

  it("drops a lone high surrogate when the cap lands mid-emoji", () => {
    const text = "hi😀there";
    const result = truncateUtf16Safe(text, 3);
    expect(result).toBe("hi");
    expect(LONE_SURROGATE.test(result)).toBe(false);
  });

  it("returns the empty string for a non-positive cap", () => {
    expect(truncateUtf16Safe("hello", 0)).toBe("");
    expect(truncateUtf16Safe("hello", -1)).toBe("");
  });
});

describe("sliceUtf16Safe", () => {
  it("is byte-identical to slice() when neither boundary splits a pair", () => {
    const text = "안녕하세요 world";
    expect(sliceUtf16Safe(text, 2, 8)).toBe(text.slice(2, 8));
  });

  it("drops both a leading lone low surrogate and a trailing lone high surrogate", () => {
    const text = "😀😀😀"; // 3 astral chars, 2 UTF-16 units each: indices 0-1, 2-3, 4-5
    const result = sliceUtf16Safe(text, 1, 5);
    expect(result).toBe("😀");
    expect(LONE_SURROGATE.test(result)).toBe(false);
  });

  it("leaves no lone surrogate when a boundary falls inside a ZWJ emoji sequence", () => {
    const text = "👩‍💻x"; // woman + ZWJ + laptop, astral parts on both sides of the ZWJ
    for (let cut = 0; cut <= text.length; cut++) {
      const result = sliceUtf16Safe(text, 0, cut);
      expect(LONE_SURROGATE.test(result)).toBe(false);
    }
  });
});
