import { describe, expect, it } from "vitest";

import { chunkText } from "./notes-chunk.js";

describe("chunkText", () => {
  it("returns one chunk for short text under the limit", () => {
    expect(chunkText("hello world", 100)).toEqual(["hello world"]);
  });

  it("packs multiple paragraphs into one chunk while they fit", () => {
    const out = chunkText("alpha\n\nbeta", 100);
    expect(out).toEqual(["alpha\n\nbeta"]);
  });

  it("starts a new chunk when the next paragraph would overflow chunkChars", () => {
    const out = chunkText("aaaa\n\nbbbb", 5);
    expect(out).toEqual(["aaaa", "bbbb"]);
  });

  it("hard-wraps a single paragraph longer than chunkChars so no chunk exceeds the limit", () => {
    const out = chunkText("abcdefghij", 4);
    expect(out.every((c) => c.length <= 4)).toBe(true);
    expect(out.join("")).toBe("abcdefghij");
  });

  it("prefers a whitespace break point over a mid-word cut", () => {
    const out = chunkText("hello world foo", 8);
    expect(out[0]).toBe("hello");
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(chunkText("   \n\n   ", 100)).toEqual([]);
  });
});
