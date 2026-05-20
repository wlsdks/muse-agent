import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalDirNotesProvider, sliceWithoutLoneSurrogate } from "../src/notes-providers-local.js";

describe("sliceWithoutLoneSurrogate (notes snippet boundary helper)", () => {
  it("returns the slice unchanged when the cut is on a BMP boundary", () => {
    expect(sliceWithoutLoneSurrogate("hello world", 5)).toBe("hello");
  });

  it("returns the input unchanged when cap >= length", () => {
    expect(sliceWithoutLoneSurrogate("short", 10)).toBe("short");
  });

  it("drops the trailing high surrogate when the cap cuts mid-pair", () => {
    const pre = "abc";
    const grin = "😀";
    const input = `${pre}${grin}xyz`;
    expect(input.length).toBe(8);
    const sliced = sliceWithoutLoneSurrogate(input, 4);
    expect(sliced).toBe(pre);
    expect(sliced.length).toBe(3);
    for (let i = 0; i < sliced.length; i += 1) {
      const c = sliced.charCodeAt(i);
      expect(c >= 0xd800 && c <= 0xdfff, `index ${i.toString()} must not be a surrogate`).toBe(false);
    }
  });

  it("leaves a clean cut after a complete surrogate pair untouched", () => {
    const input = `abc😀xyz`;
    expect(sliceWithoutLoneSurrogate(input, 5)).toBe(`abc😀`);
  });

  it("handles an empty input", () => {
    expect(sliceWithoutLoneSurrogate("", 5)).toBe("");
  });
});

describe("LocalDirNotesProvider.search snippet — surrogate-cap at the 240-char boundary", () => {
  it("does NOT leave a lone high surrogate when the snippet boundary cuts an emoji mid-pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-notes-snippet-"));
    const pre = "needle " + "x".repeat(232);
    const grin = "😀";
    const line = `${pre}${grin}rest`;
    expect(pre.length).toBe(239);
    writeFileSync(join(root, "n.md"), `${line}\n`, "utf8");
    const provider = new LocalDirNotesProvider({ notesDir: root });
    const hits = await provider.search("needle", 5);
    expect(hits).toHaveLength(1);
    const snippet = hits[0]!.snippet;
    expect(snippet.endsWith("...")).toBe(true);
    const head = snippet.slice(0, snippet.length - 3);
    for (let i = 0; i < head.length; i += 1) {
      const c = head.charCodeAt(i);
      expect(c >= 0xd800 && c <= 0xdfff, `snippet index ${i.toString()} must not be a lone surrogate`).toBe(false);
    }
    expect(head.length).toBeLessThanOrEqual(240);
  });
});
