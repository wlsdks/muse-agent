import { describe, expect, it } from "vitest";

import { defaultShouldOrchestrate, orchestrateAnswer, type OrchestrateOptions } from "../src/orchestrate.js";

// A deterministic fake model: a role proposer (system prompt mentions a lens)
// echoes its role; the aggregator (council synthesis) returns council JSON.
function fakeProvider(failLenses: readonly string[] = []): OrchestrateOptions["modelProvider"] {
  return {
    async generate(request) {
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      const isProposer = /assistant\. Answer the user's question|fact-checker/u.test(system);
      if (isProposer) {
        const lens = /practical/u.test(system) ? "practical" : /thorough/u.test(system) ? "thorough" : "skeptic";
        if (failLenses.includes(lens)) throw new Error(`proposer ${lens} failed`);
        return { id: "x", model: "fake", output: `proposal-from-${lens}` };
      }
      // aggregator (MoA merge) → the single merged answer as plain text
      return { id: "x", model: "fake", output: "merged best answer" };
    }
  };
}

const opts = (over: Partial<OrchestrateOptions> = {}): OrchestrateOptions => ({
  model: "fake",
  modelProvider: fakeProvider(),
  ...over
});

describe("defaultShouldOrchestrate", () => {
  it("keeps trivial / greeting turns single", () => {
    expect(defaultShouldOrchestrate("안녕")).toBe(false);
    expect(defaultShouldOrchestrate("hi")).toBe(false);
    expect(defaultShouldOrchestrate("ㅇㅋ")).toBe(false);
  });
  it("orchestrates substantive questions", () => {
    expect(defaultShouldOrchestrate("좋은 하루 보내는 방법 3가지 알려줘")).toBe(true);
    expect(defaultShouldOrchestrate("How do I parallelize agents?")).toBe(true);
    expect(defaultShouldOrchestrate("이 코드를 리팩터링하는 가장 좋은 방법을 설명해줘")).toBe(true);
  });
});

describe("orchestrateAnswer", () => {
  it("takes the single fast path for a trivial turn", async () => {
    const res = await orchestrateAnswer("안녕", opts());
    expect(res.mode).toBe("single");
    expect(res.proposals).toHaveLength(1);
  });

  it("runs all proposers then synthesizes for a substantive turn", async () => {
    const seen: string[] = [];
    const res = await orchestrateAnswer("에이전트를 병렬화하는 가장 좋은 방법은 무엇인가요?", opts({
      onProposal: (p) => seen.push(p.id)
    }));
    expect(res.mode).toBe("orchestrated");
    expect(res.proposals.map((p) => p.id)).toEqual(["practical", "thorough", "skeptic"]);
    expect(seen.sort()).toEqual(["practical", "skeptic", "thorough"]); // all proposers ran (order may vary)
    expect(res.answer).toBe("merged best answer");
    expect(res.contributors).toEqual(["practical", "thorough", "skeptic"]);
  });

  it("respects an explicit shouldOrchestrate override", async () => {
    const res = await orchestrateAnswer("a long substantive question that would normally orchestrate?", opts({
      shouldOrchestrate: () => false
    }));
    expect(res.mode).toBe("single");
  });

  const substantive = "에이전트를 병렬화하는 가장 좋은 방법은 무엇인가요?";

  it("degrades to the surviving proposers when one fails, and surfaces the failed role", async () => {
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["thorough"]) }));
    expect(res.mode).toBe("orchestrated");
    expect(res.proposals.map((p) => p.id)).toEqual(["practical", "skeptic"]);
    expect(res.failedRoles).toEqual(["thorough"]);
    expect(res.answer).toBe("merged best answer"); // survivors still aggregated
  });

  it("with a single survivor returns its answer directly (no wasted merge call)", async () => {
    const res = await orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["practical", "thorough"]) }));
    expect(res.mode).toBe("orchestrated");
    expect(res.contributors).toEqual(["skeptic"]);
    expect(res.failedRoles).toEqual(["practical", "thorough"]);
    expect(res.answer).toBe("proposal-from-skeptic"); // NOT "merged best answer" → aggregate was skipped
  });

  it("throws (fail-close) when every proposer fails — never returns an empty answer", async () => {
    await expect(
      orchestrateAnswer(substantive, opts({ modelProvider: fakeProvider(["practical", "thorough", "skeptic"]) }))
    ).rejects.toThrow(/all 3 proposers failed/u);
  });

  it("reports no failedRoles on a clean run", async () => {
    const res = await orchestrateAnswer(substantive, opts());
    expect(res.failedRoles).toBeUndefined();
  });
});
