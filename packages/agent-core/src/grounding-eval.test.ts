import { describe, expect, it } from "vitest";
import { scoreGroundingEval } from "./grounding-eval.js";
import type { GroundingEvalCorpus, GroundingEvalDeps } from "./grounding-eval.js";
import type { GroundingVerdict, GroundingVerification, KnowledgeMatch } from "./knowledge-recall.js";

const verdict = (v: GroundingVerdict): GroundingVerification => ({
  invalidCitations: [],
  reason: v,
  rubric: { answerability: 1, citationValidity: 1, confidence: 1, coverage: 1 },
  verdict: v
});

const match = (cosine: number): KnowledgeMatch => ({ cosine, score: cosine, source: "n.md", text: "t" });

/** Build deps where retrieval + verdict are keyed off the query, so each case is deterministic. */
function deps(opts: {
  readonly matchesByQuery?: Record<string, readonly KnowledgeMatch[]>;
  readonly verdictByQuery?: Record<string, GroundingVerdict>;
}): GroundingEvalDeps {
  return {
    rank: (query) => Promise.resolve(opts.matchesByQuery?.[query] ?? [match(0.7)]),
    verify: (_answer, _matches, query) => Promise.resolve(verdict(opts.verdictByQuery?.[query] ?? "grounded"))
  };
}

describe("scoreGroundingEval", () => {
  it("a clean corpus scores false-refusal 0 and faithfulness 1", async () => {
    const corpus: GroundingEvalCorpus = {
      cases: [
        { answer: "a1", kind: "answerable", query: "q-ans" },
        { kind: "refuse", query: "q-refuse" },
        { answer: "bad", kind: "drift", query: "q-drift" }
      ],
      notes: []
    };
    const result = await scoreGroundingEval(corpus, deps({
      matchesByQuery: { "q-refuse": [match(0.2)] }, // low cosine ⇒ not confident ⇒ caught
      verdictByQuery: { "q-ans": "grounded", "q-drift": "ungrounded" }
    }));
    expect(result.falseRefusalRate).toBe(0);
    expect(result.faithfulnessRate).toBe(1);
    expect(result.answerable).toBe(1);
    expect(result.guardable).toBe(2);
    expect(result.outcomes.every((o) => o.passed)).toBe(true);
  });

  it("counts a wrongly-refused answerable case as a false refusal", async () => {
    const corpus: GroundingEvalCorpus = {
      cases: [
        { answer: "a1", kind: "answerable", query: "q1" },
        { answer: "a2", kind: "answerable", query: "q2" }
      ],
      notes: []
    };
    const result = await scoreGroundingEval(corpus, deps({
      verdictByQuery: { q1: "grounded", q2: "weak" } // weak ⇒ not grounded ⇒ false refusal
    }));
    expect(result.falseRefusals).toBe(1);
    expect(result.falseRefusalRate).toBe(0.5);
    expect(result.faithfulnessRate).toBe(1); // no guardable cases
    expect(result.outcomes.find((o) => o.query === "q2")?.passed).toBe(false);
  });

  it("counts a drift answer the gate fails to catch as a faithfulness miss", async () => {
    const corpus: GroundingEvalCorpus = {
      cases: [
        { answer: "bad1", kind: "drift", query: "d1" },
        { answer: "bad2", kind: "drift", query: "d2" }
      ],
      notes: []
    };
    const result = await scoreGroundingEval(corpus, deps({
      verdictByQuery: { d1: "ungrounded", d2: "grounded" } // d2 slipped through (the #3 hole)
    }));
    expect(result.caught).toBe(1);
    expect(result.faithfulnessRate).toBe(0.5);
    expect(result.outcomes.find((o) => o.query === "d2")?.passed).toBe(false);
  });

  it("a refuse case with a CONFIDENT near-miss retrieval is a faithfulness miss", async () => {
    const corpus: GroundingEvalCorpus = {
      cases: [{ kind: "refuse", query: "off-corpus" }],
      notes: []
    };
    const result = await scoreGroundingEval(corpus, deps({
      matchesByQuery: { "off-corpus": [match(0.9)] } // high cosine ⇒ confident ⇒ NOT caught
    }));
    expect(result.caught).toBe(0);
    expect(result.faithfulnessRate).toBe(0);
    expect(result.outcomes[0]?.detail).toContain("retrieval=confident");
  });

  it("honours an injected classify override for the refuse gate", async () => {
    const corpus: GroundingEvalCorpus = { cases: [{ kind: "refuse", query: "x" }], notes: [] };
    const result = await scoreGroundingEval(corpus, {
      classify: () => "ambiguous",
      rank: () => Promise.resolve([match(0.99)]), // would be confident by cosine, but override says ambiguous
      verify: () => Promise.resolve(verdict("grounded"))
    });
    expect(result.faithfulnessRate).toBe(1);
  });

  it("an empty corpus yields neutral rates, never NaN", async () => {
    const result = await scoreGroundingEval({ cases: [], notes: [] }, deps({}));
    expect(result.total).toBe(0);
    expect(result.falseRefusalRate).toBe(0);
    expect(result.faithfulnessRate).toBe(1);
    expect(Number.isNaN(result.falseRefusalRate)).toBe(false);
    expect(Number.isNaN(result.faithfulnessRate)).toBe(false);
  });
});
