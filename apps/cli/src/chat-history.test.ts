import { describe, expect, it } from "vitest";

import { capContentForSummary } from "./chat-history.js";

describe("capContentForSummary (chat-history compaction surrogate-cap)", () => {
  it("returns the slice unchanged for a clean BMP boundary cut", () => {
    expect(capContentForSummary("hello world", 5)).toBe("hello");
  });

  it("returns the input unchanged when cap >= length", () => {
    expect(capContentForSummary("short", 10)).toBe("short");
  });

  it("drops a trailing lone high surrogate when the cap cuts an emoji mid-pair", () => {
    const pre = "x".repeat(399);
    const grin = "😀";
    const input = `${pre}${grin}rest`;
    expect(input.length).toBe(405);
    const head = capContentForSummary(input, 400);
    expect(head).toBe(pre);
    expect(head.length).toBe(399);
    for (let i = 0; i < head.length; i += 1) {
      const c = head.charCodeAt(i);
      expect(c >= 0xd800 && c <= 0xdfff, `index ${i.toString()} must not be a surrogate`).toBe(false);
    }
  });

  it("leaves a complete surrogate-pair cut untouched", () => {
    const input = `abc😀xyz`;
    expect(capContentForSummary(input, 5)).toBe(`abc😀`);
  });

  it("handles an empty input", () => {
    expect(capContentForSummary("", 400)).toBe("");
  });
});
