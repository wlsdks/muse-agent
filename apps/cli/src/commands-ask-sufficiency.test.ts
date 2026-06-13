/**
 * Tests for the set-level sufficiency advisory decision
 * (arXiv:2411.06037, Joren/Zhang/Ferng/Juan/Taly/Rashtchian, ICLR 2025).
 *
 * Exercises `sufficiencyAdvisory` — the exact decision the registerAskCommand
 * call site runs (the call site is now a trivial `if (line) io.stderr(line)`).
 * This helper folds in EVERY emission gate (json / refusal / multi-part /
 * length-match) plus the cosine sufficiency check, so the gating is tested on
 * real inputs rather than read-verified inline.
 *
 * Geometry: 3 orthogonal unit basis vectors.
 *   e0 = [1,0,0] → "when" topic axis
 *   e1 = [0,1,0] → "where" topic axis
 *   e2 = [0,0,1] → unrelated axis (covers neither sub-query)
 */
import { describe, expect, it } from "vitest";

import { sufficiencyAdvisory } from "./commands-ask.js";

const e0 = [1, 0, 0] as const;
const e1 = [0, 1, 0] as const;
const e2 = [0, 0, 1] as const;

// A non-refusal answer (answerIsRefusal must return false for it).
const ANSWER = "Your meeting is at 3pm [from notes.md].";

const base = {
  answer: ANSWER,
  json: false,
  subQueries: ["when is my meeting", "where is my meeting"],
  subQueryVecs: [e0, e1] as readonly (readonly number[])[],
  evidenceVecs: [e0, e2] as readonly (readonly number[])[] // covers "when", not "where"
};

describe("sufficiencyAdvisory — emission decision (all gates)", () => {
  describe("fires (insufficient, non-refusal, multi-part, json off)", () => {
    it("names the uncovered sub-query when evidence covers only the first", () => {
      const line = sufficiencyAdvisory(base);
      expect(line).toBeDefined();
      expect(line).toContain("where is my meeting");
      expect(line).toContain("may be unverified");
    });

    it("names ALL uncovered parts when evidence covers none", () => {
      const line = sufficiencyAdvisory({ ...base, evidenceVecs: [e2] });
      expect(line).toBeDefined();
      expect(line).toContain("when is my meeting");
      expect(line).toContain("where is my meeting");
    });
  });

  describe("stays silent — each gate, tested independently", () => {
    it("fully-covered 2-part query → undefined", () => {
      expect(sufficiencyAdvisory({ ...base, evidenceVecs: [e0, e1] })).toBeUndefined();
    });

    it("JSON output requested → undefined (json gate)", () => {
      // Same insufficient inputs that fire above — only json flips.
      expect(sufficiencyAdvisory({ ...base, json: true })).toBeUndefined();
    });

    it("answer is itself a refusal → undefined (no double caveat)", () => {
      // Same insufficient inputs that fire above — only the answer flips to a refusal.
      expect(sufficiencyAdvisory({ ...base, answer: "I'm not sure — I couldn't find that in your notes." })).toBeUndefined();
    });

    it("single-intent query → undefined (multi-part gate)", () => {
      expect(sufficiencyAdvisory({ ...base, subQueries: ["when is my meeting"], subQueryVecs: [e0] })).toBeUndefined();
    });

    it("clause/embedding length mismatch → undefined (fail-open)", () => {
      // 2 clauses but only 1 embedding — a missing per-clause vector.
      expect(sufficiencyAdvisory({ ...base, subQueryVecs: [e0] })).toBeUndefined();
    });
  });

  describe("fail-open on degenerate inputs", () => {
    it("empty subQueries → undefined", () => {
      expect(sufficiencyAdvisory({ ...base, subQueries: [], subQueryVecs: [] })).toBeUndefined();
    });

    it("does not throw on zero-norm vecs", () => {
      const zero = [0, 0, 0] as const;
      expect(() => sufficiencyAdvisory({ ...base, subQueryVecs: [zero, e1], evidenceVecs: [e0, e1] })).not.toThrow();
    });
  });
});
