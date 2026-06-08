import type { GroundingEvalResult } from "@muse/agent-core";
import { describe, expect, it } from "vitest";
import { buildSquadGroundingCorpus, GROUNDING_THRESHOLDS, renderGroundingDelta, renderGroundingEvalReport } from "./grounding-eval-runner.js";

function result(overrides: Partial<GroundingEvalResult>): GroundingEvalResult {
  return {
    answerable: 12,
    caught: 13,
    drift: 5,
    falseRefusalRate: 0,
    falseRefusals: 0,
    faithfulnessRate: 1,
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
          { detail: "retrieval=confident", kind: "refuse", note: "no spending log", passed: false, query: "groceries last month?" },
          { detail: "verdict=grounded", kind: "answerable", passed: true, query: "rent?" }
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
