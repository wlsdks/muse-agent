import { scoreGroundingEval } from "@muse/agent-core";
import type { GroundingEvalResult, KnowledgeMatch } from "@muse/agent-core";
import { describe, expect, it } from "vitest";
import { GROUNDING_EVAL_CORPUS } from "./grounding-eval-corpus.js";
import { buildSquadGroundingCorpus, GROUNDING_THRESHOLDS, renderGroundingDelta, renderGroundingEvalReport } from "./grounding-eval-runner.js";

const emptyCalibration: GroundingEvalResult["calibration"] = {
  groups: [],
  pooled: { calibrationCoverage: 1, n: 0, targetCoverage: 0.9, threshold: Number.NEGATIVE_INFINITY }
};

function result(overrides: Partial<GroundingEvalResult>): GroundingEvalResult {
  return {
    answerable: 12,
    calibration: emptyCalibration,
    caught: 13,
    drift: 5,
    falseRefusalRate: 0,
    falseRefusals: 0,
    faithfulnessRate: 1,
    groupCoverageViolations: [],
    groups: [],
    guardable: 13,
    outcomes: [],
    refuse: 8,
    total: 25,
    ...overrides
  };
}

describe("renderGroundingEvalReport", () => {
  it("passes when both rates clear the threshold and prints both", () => {
    const report = renderGroundingEvalReport(
      result({ caught: 12, falseRefusalRate: 0.08, falseRefusals: 1, faithfulnessRate: 0.92 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("ok");
    expect(report.text).toContain("faithfulness   0.92");
    expect(report.text).toContain("false-refusal  0.08");
    expect(report.text).toContain("25 cases (12 answerable, 8 must-refuse, 5 drift)");
  });

  it("fails when faithfulness drops below the floor", () => {
    const report = renderGroundingEvalReport(
      result({ caught: 9, faithfulnessRate: 0.69 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("fail");
    expect(report.text).toContain("✗ below 84%");
  });

  it("fails when false-refusal rises above the ceiling", () => {
    const report = renderGroundingEvalReport(
      result({ falseRefusalRate: 0.5, falseRefusals: 6 }),
      GROUNDING_THRESHOLDS
    );
    expect(report.status).toBe("fail");
    expect(report.text).toContain("✗ above 25%");
  });

  it("lists the flagged cases so a regression is actionable", () => {
    const report = renderGroundingEvalReport(
      result({
        caught: 12,
        faithfulnessRate: 0.92,
        outcomes: [
          { detail: "retrieval=confident", kind: "refuse", note: "no spending log", passed: false, query: "groceries last month?", topScore: 0.9 },
          { detail: "verdict=grounded", kind: "answerable", passed: true, query: "rent?", topScore: 0.8 }
        ]
      }),
      GROUNDING_THRESHOLDS
    );
    expect(report.text).toContain("flagged cases:");
    expect(report.text).toContain('[refuse] "groceries last month?" — retrieval=confident (no spending log)');
    expect(report.text).not.toContain('"rent?"'); // a passing case is not flagged
  });

  it("the shipped floor sits one miss below the measured 0.92 baseline", () => {
    // 11/13 caught = 0.846 must still pass; 10/13 = 0.769 must fail — proving the
    // floor is a regression detector with headroom, not the current quality.
    expect(GROUNDING_THRESHOLDS.minFaithfulness).toBeLessThanOrEqual(11 / 13);
    expect(GROUNDING_THRESHOLDS.minFaithfulness).toBeGreaterThan(10 / 13);
  });

  it("render (non-inert proof): emits ⚠ violation line for a result with groupCoverageViolations", () => {
    const r = result({
      groupCoverageViolations: ["hangul"],
      groups: [
        { answerable: 12, caught: 0, falseRefusalRate: 0, falseRefusals: 0, faithfulnessRate: 1, group: "latin", guardable: 0 },
        { answerable: 4, caught: 0, falseRefusalRate: 1, falseRefusals: 4, faithfulnessRate: 1, group: "hangul", guardable: 0 }
      ]
    });
    const report = renderGroundingEvalReport(r, GROUNDING_THRESHOLDS);
    expect(report.text).toContain("⚠ hangul subgroup coverage below target");
    expect(report.text).toContain("Korean");
    expect(report.text).toContain("arXiv:2407.21057");
  });

  it("render: clean single-group result emits no ⚠ line and no per-group rows (today's output unchanged)", () => {
    const r = result({
      groupCoverageViolations: [],
      groups: [{ answerable: 12, caught: 13, falseRefusalRate: 0, falseRefusals: 0, faithfulnessRate: 1, group: "latin", guardable: 13 }]
    });
    const report = renderGroundingEvalReport(r, GROUNDING_THRESHOLDS);
    expect(report.text).not.toContain("⚠");
    expect(report.text).not.toContain("per-group");
    expect(report.text).not.toContain("arXiv:2407.21057");
  });
});

describe("renderGroundingDelta", () => {
  const meta = { at: "2026-06-08T00:00:00Z", command: "pnpm eval:grounding-delta", corpus: "bundled corpus", model: "ollama/gemma4:12b" };

  it("reports the signed ON−OFF faithfulness delta as the headline", () => {
    const on = result({ caught: 12, falseRefusalRate: 0.08, falseRefusals: 1, faithfulnessRate: 0.92 });
    const off = result({ caught: 0, falseRefusalRate: 0, falseRefusals: 0, faithfulnessRate: 0 });
    const md = renderGroundingDelta(on, off, meta);
    expect(md).toContain("| gate **ON** | 0.92 (12/13) | 0.08 (1/12) |");
    expect(md).toContain("| gate **OFF** | 0.00 (0/13) | 0.00 (0/12) |");
    expect(md).toContain("| **Δ (ON − OFF)** | **+0.92** | +0.08 |");
    expect(md).toContain("lets 13/13 fabrications through"); // off.guardable - off.caught = 13
    expect(md).toContain("`ollama/gemma4:12b`");
  });

  it("renders a non-positive delta honestly (gate earning nothing)", () => {
    const arm = result({ caught: 5, faithfulnessRate: 0.5 });
    const md = renderGroundingDelta(arm, arm, meta);
    expect(md).toContain("| **Δ (ON − OFF)** | **+0.00** | +0.00 |");
  });
});

describe("buildSquadGroundingCorpus", () => {
  const slice = {
    items: [
      { title: "Normans", context: "The Normans were a people in France.", question: "Where were the Normans?", answer: "France" },
      { title: "Complexity", context: "Computational complexity theory studies resource use.", question: "What studies resource use?", answer: "Computational complexity theory" }
    ]
  };

  it("makes one note per paragraph with a slugged, indexed source", () => {
    const corpus = buildSquadGroundingCorpus(slice);
    expect(corpus.notes.map((n) => n.source)).toEqual(["squad-normans-0", "squad-complexity-1"]);
    expect(corpus.notes[0]!.text).toContain("Normans");
  });

  it("emits an answerable case with the REAL cited answer (measures false-refusal)", () => {
    const corpus = buildSquadGroundingCorpus(slice);
    const a = corpus.cases.find((c) => c.kind === "answerable" && c.query === "Where were the Normans?");
    expect(a?.answer).toBe("France [from squad-normans-0]");
  });

  it("emits a drift case citing THIS source but a DIFFERENT paragraph's answer (must be caught ungrounded)", () => {
    const corpus = buildSquadGroundingCorpus(slice);
    const d = corpus.cases.find((c) => c.kind === "drift" && c.query === "Where were the Normans?");
    // the next item's answer ("Computational complexity theory"), cited to squad-normans-0 → unsupported there.
    expect(d?.answer).toBe("Computational complexity theory [from squad-normans-0]");
    expect(corpus.cases.filter((c) => c.kind === "drift")).toHaveLength(2);
  });
});

describe("GROUNDING_EVAL_CORPUS (production corpus) — non-inert multi-script proof", () => {
  // Stub deps: every answerable answer is treated as grounded, every drift as ungrounded,
  // every refuse gets a low-cosine match (non-confident). No Ollama needed.
  const stubMatch = (cosine: number): KnowledgeMatch => ({ cosine, score: cosine, source: "stub.md", text: "stub" });
  const refuseQueries = new Set(
    GROUNDING_EVAL_CORPUS.cases.filter((c) => c.kind === "refuse").map((c) => c.query)
  );

  it("hangul group has ≥10 answerable cases (enough for its own conformal tau)", async () => {
    const result = await scoreGroundingEval(GROUNDING_EVAL_CORPUS, {
      classify: (matches) => ((matches[0]?.cosine ?? 1) < 0.5 ? "ambiguous" : "confident"),
      rank: (query) => Promise.resolve([stubMatch(refuseQueries.has(query) ? 0.2 : 0.8)]),
      verify: (_answer, _matches, query) =>
        Promise.resolve({
          invalidCitations: [],
          reason: "stub",
          rubric: { answerability: 1, citationValidity: 1, confidence: 1, coverage: 1 },
          verdict: refuseQueries.has(query) ? ("ungrounded" as const) : ("grounded" as const)
        })
    });

    const hangul = result.groups.find((g) => g.group === "hangul");
    expect(hangul).toBeDefined();
    expect(hangul!.answerable).toBeGreaterThanOrEqual(10);

    expect(result.groups.length).toBeGreaterThanOrEqual(2);

    const hangulCal = result.calibration.groups.find((g) => g.group === "hangul");
    expect(hangulCal).toBeDefined();
    expect(hangulCal!.pooledFallback).toBe(false);
  });
});
