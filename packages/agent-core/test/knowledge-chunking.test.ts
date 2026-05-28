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

describe("chunkText — overlapping window (DPR-style; Karpukhin et al. 2020)", () => {
  it("default (no overlap arg) is byte-identical to the prior behaviour — back-compat", () => {
    const text = ["x".repeat(50), "y".repeat(50), "z".repeat(50)].join("\n\n");
    expect(chunkText(text, 60)).toEqual(chunkText(text, 60, 0));
  });

  it("the two halves of a boundary-spanning phrase end up in the SAME chunk under overlap", () => {
    // Without overlap, "RECONCILE" sits at the end of chunk 0 and "budget
    // cap" at the start of chunk 1 — an embedding of the whole phrase
    // matches neither chunk well. With overlap, the tail of chunk 0 is
    // prepended to chunk 1 so both halves appear together in chunk 1.
    const head = `${"alpha ".repeat(8).trim()} RECONCILE`;
    const tail = `budget cap ${"beta ".repeat(8).trim()}`;
    const text = `${head}\n\n${tail}`;
    const noOverlap = chunkText(text, 60);
    const overlapped = chunkText(text, 60, 25);
    expect(noOverlap.some((c) => c.includes("RECONCILE") && c.includes("budget cap"))).toBe(false);
    expect(overlapped.some((c) => c.includes("RECONCILE") && c.includes("budget cap"))).toBe(true);
  });

  it("overlap=0 or single-chunk input is a no-op", () => {
    expect(chunkText("short", 100, 50)).toEqual(["short"]);
    const text = ["aaa", "bbb"].join("\n\n");
    expect(chunkText(text, 1000, 50)).toEqual([text]); // fits in one chunk
  });

  it("an absurd overlap (≥ chunk length) is tolerated, not crashed", () => {
    const chunks = chunkText(["foo bar baz", "qux quux corge"].join("\n\n"), 12, 999);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => typeof c === "string")).toBe(true);
  });
});
