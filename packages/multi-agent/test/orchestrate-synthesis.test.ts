import { describe, expect, it } from "vitest";

import { MultiAgentOrchestrator, RuleBasedAgentWorker, createWorkerResult } from "../src/index.js";

function twoWorkers() {
  const a = new RuleBasedAgentWorker("Generalist", "Generalist", [], (input) =>
    createWorkerResult("Generalist", "Redis caching is fast.", input)
  );
  const b = new RuleBasedAgentWorker("Critic", "Critic", [], (input) =>
    createWorkerResult("Critic", "Risks & gaps: stale data, cache poisoning.", input)
  );
  return [a, b];
}

describe("MultiAgentOrchestrator — final-answer synthesis (SB next: one coherent answer)", () => {
  it("when synthesizeFinalAnswer is provided, response.output is the synthesized answer (not the ## Name concat)", async () => {
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "o1", workers: twoWorkers() });
    const seen: Array<{ workerId: string; output: string }> = [];
    const result = await orchestrator.run(
      { messages: [{ content: "should we cache in redis?", role: "user" }], model: "m" },
      {
        synthesizeFinalAnswer: async (parts) => {
          for (const p of parts) seen.push(p);
          return "FINAL: cache in Redis but guard against stale data.";
        }
      }
    );
    expect(result.response.output).toBe("FINAL: cache in Redis but guard against stale data.");
    // synthesizer receives every completed worker's output, in order
    expect(seen.map((p) => p.workerId)).toEqual(["Generalist", "Critic"]);
    expect(seen[1]!.output).toContain("Risks & gaps");
    // worker-level fidelity is preserved on results even when synthesized
    expect(result.results.map((r) => r.workerId)).toEqual(["Generalist", "Critic"]);
  });

  it("without a synthesizer, falls back to the existing ## Name concatenation (back-compat)", async () => {
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "o2", workers: twoWorkers() });
    const result = await orchestrator.run({ messages: [{ content: "x", role: "user" }], model: "m" });
    expect(result.response.output).toContain("## Generalist");
    expect(result.response.output).toContain("## Critic");
  });

  it("a throwing synthesizer falls back to the concatenation (fail-soft, never loses the answer)", async () => {
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "o3", workers: twoWorkers() });
    const result = await orchestrator.run(
      { messages: [{ content: "x", role: "user" }], model: "m" },
      { synthesizeFinalAnswer: async () => { throw new Error("synth down"); } }
    );
    expect(result.response.output).toContain("## Generalist");
  });
});
