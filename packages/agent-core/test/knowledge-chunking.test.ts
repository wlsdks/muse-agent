import { describe, expect, it } from "vitest";

import { chunkText } from "../src/index.js";

describe("chunkText", () => {
  it("returns [] for empty / whitespace and one chunk for a short text", () => {
    expect(chunkText("", 100)).toEqual([]);
    expect(chunkText("   ", 100)).toEqual([]);
    expect(chunkText("short note", 100)).toEqual(["short note"]);
  });

  it("splits on paragraph boundaries, each chunk within maxChars", () => {
    const para = "x".repeat(50);
    const chunks = chunkText([para, para, para].join("\n\n"), 60);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
    }
  });

  it("hard-splits a single paragraph longer than maxChars", () => {
    const chunks = chunkText("y".repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("packs small adjacent paragraphs together up to the limit", () => {
    const chunks = chunkText(["aaa", "bbb", "ccc"].join("\n\n"), 100);
    // All three fit under 100 → one packed chunk.
    expect(chunks).toEqual(["aaa\n\nbbb\n\nccc"]);
  });
});
