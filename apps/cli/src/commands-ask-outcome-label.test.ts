import { describe, expect, it } from "vitest";

import { askOutcomeLabel } from "./commands-ask.js";

describe("askOutcomeLabel (cli.local trace outcome label)", () => {
  it("labels a refusal as abstain regardless of the verdict", () => {
    expect(askOutcomeLabel({ refusal: true, verdict: null })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: true, verdict: "grounded" })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: true, verdict: "ungrounded" })).toBe("abstain");
  });

  it("passes the rubric verdict through on a non-refusal answer", () => {
    expect(askOutcomeLabel({ refusal: false, verdict: "grounded" })).toBe("grounded");
    expect(askOutcomeLabel({ refusal: false, verdict: "ungrounded" })).toBe("ungrounded");
  });

  it("stays null when the verdict never ran (json mode / vision skip)", () => {
    expect(askOutcomeLabel({ refusal: false, verdict: null })).toBeNull();
  });
});

describe("askOutcomeLabel coverage for the --json verdict field", () => {
  it("every payload value the json consumer can receive is produced by the label fn", () => {
    expect(askOutcomeLabel({ refusal: false, verdict: "grounded" })).toBe("grounded");
    expect(askOutcomeLabel({ refusal: false, verdict: "ungrounded" })).toBe("ungrounded");
    expect(askOutcomeLabel({ refusal: true, verdict: null })).toBe("abstain");
    expect(askOutcomeLabel({ refusal: false, verdict: null })).toBeNull();
  });
});

describe("createStageTimer", () => {
  it("accumulates per-stage deltas and a running total", async () => {
    const { createStageTimer } = await import("./commands-ask.js");
    let t = 1000;
    const timer = createStageTimer(() => t);
    t = 1500; timer.mark("retrievalMs");
    t = 4000; timer.mark("generationMs");
    t = 4200; timer.mark("verdictMs");
    expect(timer.timings()).toEqual({ generationMs: 2500, retrievalMs: 500, totalMs: 3200, verdictMs: 200 });
  });
});
