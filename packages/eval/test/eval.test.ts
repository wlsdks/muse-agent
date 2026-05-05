import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import {
  EvalRunner,
  ExactMatchJudge,
  KeywordJudge,
  WeightedRubricJudge,
  createEvalCase,
  summarizeEvalResults
} from "../src/index.js";

describe("EvalRunner", () => {
  it("runs eval cases and summarizes results", async () => {
    const runner = new EvalRunner({
      idFactory: () => "result-1",
      judge: new KeywordJudge(),
      model: "model-1",
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      provider: provider(async () => ({ id: "response-1", model: "model-1", output: "alpha beta" }))
    });
    const testCase = createEvalCase({
      input: [{ content: "say alpha", role: "user" }],
      metadata: { keywords: ["alpha", "beta"] },
      name: "Keyword case"
    });

    const results = await runner.runSuite([testCase]);

    expect(results[0]).toMatchObject({ id: "result-1", status: "passed" });
    expect(summarizeEvalResults(results)).toMatchObject({ averageScore: 1, passed: 1, total: 1 });
  });

  it("supports exact match and weighted rubric judges", async () => {
    const exact = new ExactMatchJudge().judge(
      createEvalCase({ expected: "answer", input: [], name: "Exact" }),
      { id: "response-1", model: "model-1", output: "answer" }
    );
    const rubric = new WeightedRubricJudge(() => 0.5).judge(
      createEvalCase({
        input: [],
        name: "Rubric",
        rubric: { criteria: [{ name: "grounded", weight: 2 }], passThreshold: 0.5 }
      }),
      { id: "response-1", model: "model-1", output: "answer" }
    );

    expect(exact.passed).toBe(true);
    expect(rubric).toMatchObject({ passed: true, score: 0.5 });
  });

  it("captures provider failures as eval errors", async () => {
    const runner = new EvalRunner({
      judge: new ExactMatchJudge(),
      model: "model-1",
      provider: provider(async () => {
        throw new Error("provider down");
      })
    });

    await expect(runner.run(createEvalCase({ input: [], name: "Error" }))).resolves.toMatchObject({
      error: "provider down",
      status: "error"
    });
  });
});

function provider(generate: (request: ModelRequest) => Promise<ModelResponse>): ModelProvider {
  return {
    generate,
    id: "provider-1",
    listModels: async () => [],
    stream: async function* () {}
  };
}
