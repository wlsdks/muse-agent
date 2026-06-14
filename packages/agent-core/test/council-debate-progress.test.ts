import { describe, expect, it } from "vitest";

import {
  councilConsensusScore,
  debateProgressed,
  DEFAULT_DEBATE_MIN_DELTA,
  type CouncilUtterance
} from "../src/index.js";

// MAST step-repetition / no-termination-awareness guard (arXiv:2503.13657):
// councilConsensusScore exposes the scalar behind hasCouncilConsensusSemantic
// (min member support) so a debate loop can detect a non-converging round.

function utt(peerId: string, reasoning: string): CouncilUtterance {
  return { peerId, reasoning };
}

// 2-dim embedder: AGREE vectors point the same way (cosine 1), DIVERGE points
// orthogonal (cosine 0). Lets us drive the min-support score deterministically.
const VEC = new Map<string, readonly number[]>([
  ["agree-a", [1, 0]],
  ["agree-b", [1, 0]],
  ["diverge", [0, 1]]
]);
const embed = (text: string): Promise<readonly number[]> => Promise.resolve(VEC.get(text) ?? [0, 0]);

describe("councilConsensusScore", () => {
  it("solo/empty panel trivially agrees → 1", async () => {
    expect(await councilConsensusScore([], embed)).toBe(1);
    expect(await councilConsensusScore([utt("p1", "agree-a")], embed)).toBe(1);
  });

  it("an agreeing panel scores high (min support ≈ 1)", async () => {
    const score = await councilConsensusScore([utt("a", "agree-a"), utt("b", "agree-b")], embed);
    expect(score).toBeGreaterThan(0.9);
  });

  it("a divergent member drags the MIN support down (the binding constraint)", async () => {
    // a & b agree (cos 1 to each other) but the diverger is orthogonal to both →
    // its support is low → min support is low even though two members agree.
    const score = await councilConsensusScore(
      [utt("a", "agree-a"), utt("b", "agree-b"), utt("c", "diverge")],
      embed
    );
    expect(score).toBeLessThan(0.5);
  });

  it("fail-soft: an empty-reasoning member gets support 0 → min 0, never throws", async () => {
    const score = await councilConsensusScore([utt("a", "agree-a"), utt("b", "   ")], embed);
    expect(score).toBe(0);
  });
});

describe("debateProgressed", () => {
  it("a round that gains ≥ minDelta consensus → progress (continue)", () => {
    expect(debateProgressed(0.30, 0.30 + DEFAULT_DEBATE_MIN_DELTA)).toBe(true);
    expect(debateProgressed(0.30, 0.50)).toBe(true);
  });

  it("a flat or declining round → non-progress (stop)", () => {
    expect(debateProgressed(0.30, 0.30)).toBe(false);       // flat
    expect(debateProgressed(0.30, 0.25)).toBe(false);       // worse (oscillating)
    expect(debateProgressed(0.30, 0.305)).toBe(false);      // gain below minDelta
  });

  it("custom minDelta respected", () => {
    expect(debateProgressed(0.3, 0.35, 0.1)).toBe(false);   // 0.05 < 0.1
    expect(debateProgressed(0.3, 0.45, 0.1)).toBe(true);    // 0.15 ≥ 0.1
  });

  it("fail-open: a non-finite score → continue (never stops a debate on bad data)", () => {
    expect(debateProgressed(Number.NaN, 0.5)).toBe(true);
    expect(debateProgressed(0.3, Number.POSITIVE_INFINITY)).toBe(true);
  });
});
