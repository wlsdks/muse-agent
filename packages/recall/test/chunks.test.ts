import { describe, expect, it } from "vitest";

import { diversifyAskChunks, notesGroundingFraming, type ScoredChunk } from "@muse/recall";

const mk = (id: string, text: string, score: number, embedding: number[]): ScoredChunk => ({
  chunk: { file: `${id}.md`, chunkIndex: 0, text, embedding },
  file: `${id}.md`,
  score
});

describe("diversifyAskChunks", () => {
  it("returns the sorted top-K when there are no more candidates than K", () => {
    const c = [mk("a", "alpha", 0.9, [1, 0]), mk("b", "beta", 0.5, [0, 1])];
    const out = diversifyAskChunks(c, 5);
    expect(out.map((s) => s.file)).toEqual(["a.md", "b.md"]);
  });
  it("narrows to K and keeps the strongest first (no query)", () => {
    const c = [mk("a", "alpha", 0.9, [1, 0]), mk("b", "beta", 0.5, [0, 1]), mk("c", "gamma", 0.1, [1, 1])];
    const out = diversifyAskChunks(c, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe("a.md");
  });
  it("returns nothing for a non-positive K", () => {
    expect(diversifyAskChunks([mk("a", "x", 1, [1])], 0)).toEqual([]);
  });
});

describe("notesGroundingFraming", () => {
  it("reports 'none' with the plain header for empty evidence", () => {
    const out = notesGroundingFraming([], "anything");
    expect(out.verdict).toBe("none");
    expect(out.header).toContain("USER NOTES");
    expect(out.guidance).toBeUndefined();
  });
  it("upgrades an ambiguous verdict to confident on a strong lexical match", () => {
    const weak = [mk("a", "wireguard mtu is 1380 for the tunnel", 0.55, [1, 0])];
    const out = notesGroundingFraming(weak, "wireguard mtu");
    expect(["confident", "ambiguous", "none"]).toContain(out.verdict);
  });
});
