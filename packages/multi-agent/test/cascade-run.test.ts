import { describe, expect, it } from "vitest";

import { runCascade } from "../src/index.js";

const MODELS = { fast: "ollama/qwen3:1.7b", heavy: "ollama/qwen3:8b" } as const;

// A run() that returns the model id it was called with + records call order,
// and a confidenceOf() driven by a per-model confidence map. Deterministic.
function harness(confidenceByModel: Record<string, number | undefined>) {
  const calls: string[] = [];
  return {
    calls,
    confidenceOf: (result: string) => confidenceByModel[result],
    run: async (model: string) => {
      calls.push(model);
      return model;
    }
  };
}

describe("runCascade", () => {
  it("keeps the fast answer and runs the model ONCE when fast is confident (the latency win)", async () => {
    const h = harness({ [MODELS.fast]: -0.2 }); // above default −1.0
    const outcome = await runCascade({ confidenceOf: h.confidenceOf, fast: MODELS.fast, heavy: MODELS.heavy, run: h.run });
    expect(outcome.tier).toBe("fast");
    expect(outcome.escalated).toBe(false);
    expect(outcome.result).toBe(MODELS.fast);
    expect(outcome.fastConfidence).toBe(-0.2);
    expect(h.calls).toEqual([MODELS.fast]); // heavy never ran
  });

  it("escalates to heavy (one extra run) when the fast answer is low-confidence", async () => {
    const h = harness({ [MODELS.fast]: -2.0, [MODELS.heavy]: -0.1 }); // fast below −1.0
    const outcome = await runCascade({ confidenceOf: h.confidenceOf, fast: MODELS.fast, heavy: MODELS.heavy, run: h.run });
    expect(outcome.tier).toBe("heavy");
    expect(outcome.escalated).toBe(true);
    expect(outcome.result).toBe(MODELS.heavy);
    expect(outcome.fastConfidence).toBe(-2.0);
    expect(h.calls).toEqual([MODELS.fast, MODELS.heavy]); // fast THEN heavy, exactly once each
  });

  it("escalates when the fast answer's confidence is unmeasurable (safe direction)", async () => {
    const h = harness({ [MODELS.fast]: undefined, [MODELS.heavy]: -0.1 });
    const outcome = await runCascade({ confidenceOf: h.confidenceOf, fast: MODELS.fast, heavy: MODELS.heavy, run: h.run });
    expect(outcome.escalated).toBe(true);
    expect(outcome.tier).toBe("heavy");
    expect(h.calls).toEqual([MODELS.fast, MODELS.heavy]);
  });

  it("is bounded to ONE escalation — heavy runs at most once, never a loop", async () => {
    const h = harness({ [MODELS.fast]: -2.0, [MODELS.heavy]: -2.0 }); // BOTH low
    const outcome = await runCascade({ confidenceOf: h.confidenceOf, fast: MODELS.fast, heavy: MODELS.heavy, run: h.run });
    // even though heavy is also low-confidence, we do NOT re-escalate — exactly 2 runs
    expect(h.calls).toEqual([MODELS.fast, MODELS.heavy]);
    expect(outcome.tier).toBe("heavy");
    expect(outcome.result).toBe(MODELS.heavy);
  });

  it("honours a custom escalateThreshold", async () => {
    const h = harness({ [MODELS.fast]: -0.5, [MODELS.heavy]: -0.1 });
    // strict threshold −0.1 makes −0.5 escalate
    const outcome = await runCascade({ confidenceOf: h.confidenceOf, fast: MODELS.fast, heavy: MODELS.heavy, run: h.run, threshold: -0.1 });
    expect(outcome.escalated).toBe(true);
    expect(h.calls).toEqual([MODELS.fast, MODELS.heavy]);
  });
});
