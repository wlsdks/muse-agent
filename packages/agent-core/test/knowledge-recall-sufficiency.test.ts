import { describe, expect, it } from "vitest";

import { assessContextSufficiency } from "../src/knowledge-recall.js";

// Orthogonal unit vectors (3-dimensional) for deterministic geometry.
const e0 = [1, 0, 0] as const;
const e1 = [0, 1, 0] as const;
const e2 = [0, 0, 1] as const;
const zero = [0, 0, 0] as const;

const sq = (text: string, vec: readonly number[]) => ({ text, vec });

describe("assessContextSufficiency (arXiv:2411.06037 set-level sufficiency)", () => {
  describe("sufficient — every sub-query has a covering passage", () => {
    it("returns sufficient:true and empty uncovered when 2 sub-queries each have a covering evidence vec", () => {
      const result = assessContextSufficiency(
        [sq("when is my meeting", e0), sq("where is my meeting", e1)],
        [e0, e1],
        { coverAt: 0.55 }
      );
      expect(result.sufficient).toBe(true);
      expect(result.coveredFraction).toBe(1);
      expect(result.uncovered).toEqual([]);
    });
  });

  describe("insufficient (non-vacuity / counterfactual)", () => {
    it("returns sufficient:false, coveredFraction:0.5, and names the uncovered sub-query when evidence covers only the first", () => {
      // e0 covers "when" (cosine 1.0 ≥ 0.55), e2 does NOT cover "where" (cosine 0.0 < 0.55).
      const result = assessContextSufficiency(
        [sq("when is my meeting", e0), sq("where is my meeting", e1)],
        [e0, e2], // evidence: aligned with e0 (when) but NOT e1 (where)
        { coverAt: 0.55 }
      );
      expect(result.sufficient).toBe(false);
      expect(result.coveredFraction).toBe(0.5);
      expect(result.uncovered).toEqual(["where is my meeting"]);
    });
  });

  describe("single sub-query no-op (multi-part gate)", () => {
    it("returns sufficient:true regardless of evidence when subQueries.length < 2", () => {
      // Single-intent queries are the confidence gate's job; no-op here.
      const result = assessContextSufficiency(
        [sq("when is my meeting", e0)],
        [] // empty evidence — would be insufficient for 2+ sub-queries
      );
      expect(result.sufficient).toBe(true);
      expect(result.coveredFraction).toBe(1);
      expect(result.uncovered).toEqual([]);
    });

    it("returns sufficient:true for an empty subQueries array", () => {
      const result = assessContextSufficiency([], [e0, e1]);
      expect(result.sufficient).toBe(true);
    });
  });

  describe("empty evidence (fail-open → all uncovered)", () => {
    it("marks all sub-queries uncovered and returns sufficient:false when evidence is empty", () => {
      const result = assessContextSufficiency(
        [sq("when is my meeting", e0), sq("where is my meeting", e1)],
        [],
        { coverAt: 0.55 }
      );
      expect(result.sufficient).toBe(false);
      expect(result.coveredFraction).toBe(0);
      expect(result.uncovered).toEqual(["when is my meeting", "where is my meeting"]);
    });
  });

  describe("threshold boundary", () => {
    it("covers a sub-query whose best evidence cosine is exactly at coverAt", () => {
      // Cosine of [1,0,0]·[1,0,0] = 1.0. Using coverAt=1.0: exactly at bar → covered.
      const result = assessContextSufficiency(
        [sq("q1", e0), sq("q2", e1)],
        [e0, e1],
        { coverAt: 1.0, sufficientAt: 1.0 }
      );
      expect(result.sufficient).toBe(true);
      expect(result.uncovered).toEqual([]);
    });

    it("does NOT cover a sub-query whose best evidence cosine is just below coverAt", () => {
      // e0 · e2 = 0 (below any positive coverAt).
      // e1 · e1 = 1.0 ≥ 0.55: second sub-query is covered.
      const result = assessContextSufficiency(
        [sq("q1", e0), sq("q2", e1)],
        [e2, e1], // e2 doesn't cover q1 (e0); e1 covers q2
        { coverAt: 0.55 }
      );
      expect(result.sufficient).toBe(false);
      expect(result.uncovered).toEqual(["q1"]);
    });
  });

  describe("never throws on degenerate / edge-case input", () => {
    it("handles zero-norm sub-query vec without throwing (cosineSimilarity returns 0)", () => {
      expect(() => assessContextSufficiency(
        [sq("q1", zero), sq("q2", e1)],
        [e0, e1]
      )).not.toThrow();
    });

    it("handles zero-norm evidence vec without throwing", () => {
      expect(() => assessContextSufficiency(
        [sq("q1", e0), sq("q2", e1)],
        [zero, e1]
      )).not.toThrow();
    });

    it("handles length-mismatched vecs without throwing (cosineSimilarity returns 0 for mismatched)", () => {
      expect(() => assessContextSufficiency(
        [sq("q1", [1, 0]), sq("q2", [0, 1])],
        [[1, 0, 0], [0, 1, 0]] // 3-dim evidence vs 2-dim sub-queries
      )).not.toThrow();
    });

    it("handles empty sub-query vec ([]) without throwing", () => {
      expect(() => assessContextSufficiency(
        [sq("q1", []), sq("q2", e1)],
        [e0, e1]
      )).not.toThrow();
    });

    it("preserves sub-query order in the uncovered array", () => {
      const result = assessContextSufficiency(
        [sq("alpha", e0), sq("beta", e1), sq("gamma", e2)],
        [e1], // only beta is covered
        { coverAt: 0.55 }
      );
      expect(result.uncovered).toEqual(["alpha", "gamma"]);
      expect(result.coveredFraction).toBeCloseTo(1 / 3);
    });
  });
});
