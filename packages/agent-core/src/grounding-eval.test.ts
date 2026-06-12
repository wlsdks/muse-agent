import { describe, expect, it } from "vitest";
import { scoreGroundingEval } from "./grounding-eval.js";
import type { GroundingEvalCorpus, GroundingEvalDeps } from "./grounding-eval.js";
import { dominantScriptFamily } from "./script-family.js";
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

describe("dominantScriptFamily routing (arXiv:2407.21057 group key)", () => {
  it("pure Korean query → hangul", () => {
    expect(dominantScriptFamily("내 월세 얼마야?")).toBe("hangul");
  });

  it("pure English query → latin", () => {
    expect(dominantScriptFamily("what is my rent?")).toBe("latin");
  });

  it("Korean with Latin loanword → hangul (loanword doesn't flip the family)", () => {
    expect(dominantScriptFamily("JSON 형식으로 답해줘")).toBe("hangul");
  });
});

describe("scoreGroundingEval — per-group / multivalid fields (arXiv:2407.21057)", () => {
  it("assembled path: mixed EN/KO corpus produces correct per-group tallies and calibration", async () => {
    // 4 EN answerable (all grounded), 4 KO answerable (all refused = false-refusals)
    const corpus: GroundingEvalCorpus = {
      cases: [
        { answer: "a1", kind: "answerable", query: "what is my rent?" },
        { answer: "a2", kind: "answerable", query: "what is my salary?" },
        { answer: "a3", kind: "answerable", query: "what is my lease?" },
        { answer: "a4", kind: "answerable", query: "what is my address?" },
        { answer: "a5", kind: "answerable", query: "내 월세 얼마야?" },
        { answer: "a6", kind: "answerable", query: "내 급여는 얼마야?" },
        { answer: "a7", kind: "answerable", query: "내 계약 기간은?" },
        { answer: "a8", kind: "answerable", query: "내 주소는?" }
      ],
      notes: []
    };
    const enQueries = new Set(["what is my rent?", "what is my salary?", "what is my lease?", "what is my address?"]);
    const d: GroundingEvalDeps = {
      rank: (query) => Promise.resolve([match(enQueries.has(query) ? 0.85 : 0.35)]),
      verify: (_answer, _matches, query) =>
        Promise.resolve(verdict(enQueries.has(query) ? "grounded" : "weak"))
    };
    const result = await scoreGroundingEval(corpus, d);

    // Overall pooled rates
    expect(result.falseRefusals).toBe(4);
    expect(result.answerable).toBe(8);

    // Per-group: latin group should have 0 false-refusals, hangul group should have 4
    const latin = result.groups.find((g) => g.group === "latin")!;
    const hangul = result.groups.find((g) => g.group === "hangul")!;
    expect(latin.falseRefusalRate).toBe(0);
    expect(hangul.falseRefusals).toBe(4);
    expect(hangul.answerable).toBe(4);

    // calibration.groups should have a hangul entry with its own threshold ≠ pooled (if n ≥ 10)
    // With only 4 KO items, hangul falls back to pooled.
    const hangulCal = result.calibration.groups.find((g) => g.group === "hangul");
    expect(hangulCal).toBeDefined();
    expect(hangulCal!.pooledFallback).toBe(true); // n=4 < minGroupN=10

    // groupCoverageViolations: hangul's 4 scores (0.35 each) may be below pooled tau — check it exists in result
    expect(Array.isArray(result.groupCoverageViolations)).toBe(true);
  });

  it("constructed skew — groupCoverageViolations names hangul when scores are low (n ≥ minGroupN=10)", async () => {
    // EN scores are all high (0.95), KO scores are all low (0.10).
    // pooled tau = floor(0.1 * (24+1)) = 2nd smallest = 0.10 (a KO score).
    // BUT we need KO scores strictly below pooled tau.
    // Use: 20 EN at 0.80 each, 10 KO at 0.10 each.
    // sorted all 30: 10×0.10, 20×0.80. rank = floor(0.1*31) = 3 → tau = 0.10.
    // hangul coverage under 0.10: all 10 KO scores = 0.10 ≥ 0.10 → 1.0. Still passes.
    //
    // Instead use: 20 EN at 0.80, 10 KO — 9 at 0.10, 1 at 0.50.
    // sorted: 9×0.10, 1×0.50, 20×0.80. rank=3 → tau=0.10. KO coverage = 10/10=1.0. Still passes.
    //
    // To truly violate: need KO scores where MOST are below pooled tau.
    // Use 20 EN at [0.7..0.89], 10 KO at [0.1..0.19].
    // sorted 30 values: 0.10..0.19 (10 KO), then 0.70..0.89 (20 EN).
    // rank = floor(0.1 * 31) = 3 → tau = 0.12.
    // KO coverage under 0.12: scores 0.10, 0.11, 0.12, 0.13 ... 0.19 — only ≥0.12: 8/10 = 0.8 < 0.9. VIOLATION!
    const enAnswerable = Array.from({ length: 20 }, (_, i) => ({
      answer: `a${i.toString()}`,
      kind: "answerable" as const,
      query: `en query ${i.toString()}`
    }));
    const koAnswerable = Array.from({ length: 10 }, (_, i) => ({
      answer: `k${i.toString()}`,
      kind: "answerable" as const,
      query: `한국어 질문 ${i.toString()}`
    }));
    const corpus: GroundingEvalCorpus = { cases: [...enAnswerable, ...koAnswerable], notes: [] };

    const enSet = new Set(enAnswerable.map((c) => c.query));
    // EN scores: 0.70, 0.71, ..., 0.89 (n=20)
    // KO scores: 0.10, 0.11, ..., 0.19 (n=10)
    let enIdx = 0;
    let koIdx = 0;
    const d: GroundingEvalDeps = {
      rank: (query) => {
        if (enSet.has(query)) {
          const s = 0.70 + (enIdx % 20) * 0.01;
          enIdx += 1;
          return Promise.resolve([match(s)]);
        }
        const s = 0.10 + (koIdx % 10) * 0.01;
        koIdx += 1;
        return Promise.resolve([match(s)]);
      },
      verify: () => Promise.resolve(verdict("grounded"))
    };
    const result = await scoreGroundingEval(corpus, d);

    // pooled tau = 3rd smallest of 30 scores = 0.12; KO coverage = 8/10 = 0.8 < 0.9 → violation.
    expect(result.groupCoverageViolations).toContain("hangul");
    expect(result.groupCoverageViolations).not.toContain("latin");
  });

  it("regression: single-group all-EN corpus — groups length 1, groupCoverageViolations empty, pooled rates byte-identical", async () => {
    const corpus: GroundingEvalCorpus = {
      cases: [
        { answer: "a1", kind: "answerable", query: "what is my rent?" },
        { kind: "refuse", query: "what is my secret?" },
        { answer: "bad", kind: "drift", query: "what is my balance?" }
      ],
      notes: []
    };
    const result = await scoreGroundingEval(corpus, deps({
      matchesByQuery: { "what is my secret?": [match(0.2)] },
      verdictByQuery: { "what is my balance?": "ungrounded", "what is my rent?": "grounded" }
    }));

    // Groups: only "latin" (or "none" for queries with no letters, but these have latin)
    expect(result.groups).toHaveLength(1);
    expect(result.groupCoverageViolations).toHaveLength(0);

    // Pooled rates byte-identical to pre-change behaviour
    expect(result.falseRefusalRate).toBe(0);
    expect(result.falseRefusals).toBe(0);
    expect(result.faithfulnessRate).toBe(1);
    expect(result.caught).toBe(2);
    expect(result.guardable).toBe(2);
    expect(result.answerable).toBe(1);
  });
});
