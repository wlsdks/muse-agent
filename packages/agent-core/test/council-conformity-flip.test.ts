import { describe, expect, it } from "vitest";

import {
  COUNCIL_SELF_STANCE_FLOOR,
  detectConformityFlips,
  type CouncilUtterance
} from "../src/index.js";

// "Not All Flips Are Conformity" (arXiv:2606.00820): a peer that reaches agreement
// by abandoning its OWN prior stance (self-reversal) and moving toward the panel is
// conforming, not reasoning — and conformity flips are 57-77% correct→wrong.

// 2-dim stance space. "for" ≈ [1,0], "against" ≈ [0,1]; a self-reversal is for→against.
const VEC = new Map<string, readonly number[]>([
  ["A for", [1, 0]],
  ["B against", [0, 1]],
  ["C for", [1, 0]],
  ["B for", [1, 0]],      // B flipped its OWN stance to match A/C
  ["B for reworded", [0.98, 0.2]] // B kept its (new) stance, just reworded
]);
const embed = (t: string): Promise<readonly number[]> => Promise.resolve(VEC.get(t) ?? [0, 0]);

const u = (peerId: string, reasoning: string): CouncilUtterance => ({ peerId, reasoning });

describe("detectConformityFlips", () => {
  it("flags a peer that reversed its OWN stance AND moved toward the panel", async () => {
    // Round 1: A for, C for, B against (B isolated). Round 2: B flips to 'for'.
    const prior = [u("A", "A for"), u("C", "C for"), u("B", "B against")];
    const current = [u("A", "A for"), u("C", "C for"), u("B", "B for")];
    const flips = await detectConformityFlips(prior, current, embed);
    expect(flips.map((f) => f.peerId)).toEqual(["B"]);
  });

  it("does NOT flag a peer that kept its stance (high self-cosine), even if it agrees", async () => {
    // A and C agree across both rounds — they never reversed → not conformity.
    const prior = [u("A", "A for"), u("C", "C for"), u("B", "B against")];
    const current = [u("A", "A for"), u("C", "C for"), u("B", "B against")];
    const flips = await detectConformityFlips(prior, current, embed);
    expect(flips).toEqual([]);
  });

  it("does NOT flag a mere rewording of the SAME (new) stance (self-cosine high)", async () => {
    // B was 'for' last round and is still 'for' (reworded) — kept its stance.
    const prior = [u("A", "A for"), u("C", "C for"), u("B", "B for")];
    const current = [u("A", "A for"), u("C", "C for"), u("B", "B for reworded")];
    const flips = await detectConformityFlips(prior, current, embed);
    expect(flips).toEqual([]);
  });

  it("does NOT flag a peer new this round (no prior stance to abandon)", async () => {
    const prior = [u("A", "A for"), u("C", "C for")];
    const current = [u("A", "A for"), u("C", "C for"), u("B", "B for")];
    const flips = await detectConformityFlips(prior, current, embed);
    expect(flips).toEqual([]);
  });

  it("fail-safe: empty prior or single-member current → no flips", async () => {
    expect(await detectConformityFlips([], [u("A", "A for"), u("B", "B for")], embed)).toEqual([]);
    expect(await detectConformityFlips([u("A", "A for")], [u("A", "A for")], embed)).toEqual([]);
  });

  it("exports the self-stance floor", () => {
    expect(COUNCIL_SELF_STANCE_FLOOR).toBe(0.5);
  });
});
