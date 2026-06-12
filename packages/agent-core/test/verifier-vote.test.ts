import { describe, expect, it } from "vitest";

import { orchestrateAnswer, type OrchestrateOptions } from "../src/orchestrate.js";
import {
  aggregateVerifierVotes,
  DEFAULT_ASPECT_VERIFIERS,
  type AspectVerifier,
  type OrchestrationProposal
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Unit tests for aggregateVerifierVotes
// ---------------------------------------------------------------------------

describe("aggregateVerifierVotes — score formula", () => {
  it("candidate approved by 2 of 3 verifiers → score 2/3", () => {
    const verifiers: AspectVerifier[] = [
      { id: "v1", approve: () => true },
      { id: "v2", approve: () => true },
      { id: "v3", approve: () => false }
    ];
    const candidates: OrchestrationProposal[] = [{ id: "a", text: "hello world test case" }];
    const { ranked } = aggregateVerifierVotes(candidates, verifiers, "test");
    expect(ranked[0]?.score).toBeCloseTo(2 / 3);
    expect(ranked[0]?.approvals).toEqual(["v1", "v2"]);
  });

  it("argmax: 3/3-approved candidate beats a 1/3 one regardless of input order", () => {
    const verifiers: AspectVerifier[] = [
      { id: "v1", approve: (c) => c.id === "best" },
      { id: "v2", approve: (c) => c.id === "best" },
      { id: "v3", approve: (c) => c.id === "best" }
    ];
    // put "weak" first to confirm input order does not win
    const candidates: OrchestrationProposal[] = [
      { id: "weak", text: "weak answer" },
      { id: "best", text: "best answer" }
    ];
    const { selected } = aggregateVerifierVotes(candidates, verifiers, "question");
    expect(selected.id).toBe("best");
  });
});

describe("aggregateVerifierVotes — tie-break", () => {
  it("top-score tie → preferOnTie id wins when present", () => {
    const verifiers: AspectVerifier[] = [];
    const candidates: OrchestrationProposal[] = [
      { id: "alpha", text: "alpha" },
      { id: "preferred", text: "preferred" },
      { id: "gamma", text: "gamma" }
    ];
    const { selected } = aggregateVerifierVotes(candidates, verifiers, "q", "preferred");
    expect(selected.id).toBe("preferred");
  });

  it("top-score tie → first in input order when preferOnTie absent", () => {
    const verifiers: AspectVerifier[] = [];
    const candidates: OrchestrationProposal[] = [
      { id: "first", text: "first" },
      { id: "second", text: "second" }
    ];
    const { selected } = aggregateVerifierVotes(candidates, verifiers, "q");
    expect(selected.id).toBe("first");
  });

  it("same input twice → identical output (determinism)", () => {
    const verifiers: AspectVerifier[] = [
      { id: "v", approve: (c) => c.id === "b" }
    ];
    const candidates: OrchestrationProposal[] = [
      { id: "a", text: "aaa" },
      { id: "b", text: "bbb" }
    ];
    const r1 = aggregateVerifierVotes(candidates, verifiers, "q");
    const r2 = aggregateVerifierVotes(candidates, verifiers, "q");
    expect(r1.selected.id).toBe(r2.selected.id);
    expect(r1.ranked.map((s) => s.id)).toEqual(r2.ranked.map((s) => s.id));
  });
});

describe("aggregateVerifierVotes — empty verifier list", () => {
  it("all scores 0, no NaN → tie-break path (preferOnTie / input order)", () => {
    const candidates: OrchestrationProposal[] = [
      { id: "x", text: "x" },
      { id: "y", text: "y" }
    ];
    const { ranked, selected } = aggregateVerifierVotes(candidates, [], "q", "y");
    expect(ranked.every((s) => s.score === 0)).toBe(true);
    expect(ranked.every((s) => !Number.isNaN(s.score))).toBe(true);
    expect(selected.id).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// on-topic verifier
// ---------------------------------------------------------------------------

describe("on-topic verifier", () => {
  const onTopic = DEFAULT_ASPECT_VERIFIERS.find((v) => v.id === "on-topic")!;

  it("zero question-token-overlap → reject", () => {
    const candidate: OrchestrationProposal = { id: "c", text: "bread baking sourdough levain" };
    expect(onTopic.approve(candidate, "how do I write TypeScript code?")).toBe(false);
  });

  it("overlapping tokens → approve", () => {
    const candidate: OrchestrationProposal = { id: "c", text: "use TypeScript strict mode for better code" };
    expect(onTopic.approve(candidate, "how do I write TypeScript code?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// non-hedging verifier
// ---------------------------------------------------------------------------

describe("non-hedging verifier", () => {
  const nonHedging = DEFAULT_ASPECT_VERIFIERS.find((v) => v.id === "non-hedging")!;
  const substantive = DEFAULT_ASPECT_VERIFIERS.find((v) => v.id === "substantive")!;

  it("substantive candidate ranks above a pure-hedge one", () => {
    const hedgeCandidate: OrchestrationProposal = {
      id: "hedge",
      text: "I'm not sure, I cannot answer this question as an AI"
    };
    const realCandidate: OrchestrationProposal = {
      id: "real",
      text: "Use TypeScript strict mode and enable all compiler checks"
    };
    expect(nonHedging.approve(realCandidate, "q")).toBe(true);
    expect(nonHedging.approve(hedgeCandidate, "q")).toBe(false);
  });

  it("ALL-hedge field still returns a selection (no throw, no abstention)", () => {
    const candidates: OrchestrationProposal[] = [
      { id: "a", text: "I'm not sure I cannot answer this" },
      { id: "b", text: "Not sure as an AI I cannot answer" }
    ];
    // Both fail non-hedging; substantive + on-topic may differ; aggregation must not throw
    let result: ReturnType<typeof aggregateVerifierVotes> | undefined;
    expect(() => {
      result = aggregateVerifierVotes(candidates, DEFAULT_ASPECT_VERIFIERS, "q");
    }).not.toThrow();
    expect(result?.selected).toBeDefined();
    expect(result?.selected.id).toMatch(/^[ab]$/u);
  });

  it("zero-token hedge candidate → both substantive and non-hedging verifiers handle it", () => {
    const empty: OrchestrationProposal = { id: "e", text: "" };
    expect(substantive.approve(empty, "q")).toBe(false);
    expect(nonHedging.approve(empty, "q")).toBe(true); // 0/0 words → 0 density < floor
  });
});

// ---------------------------------------------------------------------------
// Integration: orchestrateAnswer with aggregator-failure + BoN-MAV selection
// ---------------------------------------------------------------------------

describe("orchestrateAnswer — BoN-MAV fallback (integration)", () => {
  const substantiveQ = "How do I write a TypeScript generic function?";

  /**
   * Behavior delta test (arXiv:2502.20379):
   * - aggregator throws
   * - "thorough" proposal is OFF-topic (bread/baking — zero question-token overlap)
   * - "skeptic" proposal is ON-topic (TypeScript generic function tokens present)
   *
   * BoN-MAV: on-topic verifier rejects "thorough", approves "skeptic" → skeptic selected.
   * Without BoN-MAV (old blind fallback): "thorough" would be picked unconditionally.
   */
  it("selects the on-topic skeptic over the off-topic thorough when aggregator throws", async () => {
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        // aggregator throws
        if (sys.includes("candidate answers")) throw new Error("aggregator flaked");
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "practical bread baking sourdough levain starter" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "thorough bread baking sourdough levain starter culture" };
        // skeptic is on-topic: contains TypeScript + generic + function tokens
        return { id: "x", model: "fake", output: "use TypeScript generic function with type parameter constraints" };
      }
    };

    const res = await orchestrateAnswer(substantiveQ, {
      model: "fake",
      modelProvider: provider,
      shouldOrchestrate: () => true
    });

    expect(res.mode).toBe("orchestrated");
    // BoN-MAV should select skeptic (on-topic)
    expect(res.contributors).toEqual(["skeptic"]);
    expect(res.answer).toContain("TypeScript");
    // Confirm it is NOT the thorough (off-topic) text
    expect(res.answer).not.toContain("bread baking");
  });

  it("regression: aggregator-throws with equal-scoring candidates falls back to thorough (tie-break)", async () => {
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("candidate answers")) throw new Error("aggregator flaked");
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-practical" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-thorough" };
        return { id: "x", model: "fake", output: "proposal-from-skeptic" };
      }
    };
    await expect(
      orchestrateAnswer(substantiveQ, {
        model: "fake",
        modelProvider: provider,
        shouldOrchestrate: () => true
      })
    ).resolves.toMatchObject({
      mode: "orchestrated",
      answer: "proposal-from-thorough",
      contributors: ["thorough"]
    });
  });

  it("regression: aggregator empty-string with equal-scoring candidates falls back to thorough (tie-break)", async () => {
    const provider: OrchestrateOptions["modelProvider"] = {
      async generate(request) {
        const sys = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (sys.includes("candidate answers")) return { id: "x", model: "fake", output: "" };
        if (/practical/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-practical" };
        if (/thorough/u.test(sys)) return { id: "x", model: "fake", output: "proposal-from-thorough" };
        return { id: "x", model: "fake", output: "proposal-from-skeptic" };
      }
    };
    const res = await orchestrateAnswer(substantiveQ, {
      model: "fake",
      modelProvider: provider,
      shouldOrchestrate: () => true
    });
    expect(res.mode).toBe("orchestrated");
    expect(res.answer).toBe("proposal-from-thorough");
    expect(res.contributors).toEqual(["thorough"]);
  });
});
