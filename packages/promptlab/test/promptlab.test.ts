import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { createEvalCase } from "@muse/eval";
import {
  PromptExperimentRunner,
  applySystemPrompt,
  createPromptExperiment,
  createPromptVariant,
  rankPromptVariants
} from "../src/index.js";

describe("PromptExperimentRunner", () => {
  it("runs every variant against every case and ranks variants", async () => {
    const seen: string[] = [];
    const runner = new PromptExperimentRunner({
      judge: async (_testCase, response) => ({
        criterionScores: { length: response.output.includes("A") ? 1 : 0 },
        passed: response.output.includes("A"),
        reasons: [],
        score: response.output.includes("A") ? 1 : 0
      }),
      provider: provider(async (request) => {
        seen.push(request.messages[0]?.content ?? "");
        return {
          id: `response-${seen.length}`,
          model: request.model,
          output: request.messages[0]?.content.includes("Variant A") ? "A" : "B"
        };
      })
    });
    const experiment = createPromptExperiment({
      cases: [createEvalCase({ input: [{ content: "Hello", role: "user" }], name: "Case" })],
      id: "experiment-1",
      model: "model-1",
      name: "Prompt test",
      variants: [
        createPromptVariant({ id: "variant-a", name: "A", systemPrompt: "Variant A" }),
        createPromptVariant({ id: "variant-b", name: "B", systemPrompt: "Variant B" })
      ]
    });

    const results = await runner.run(experiment);

    expect(results).toHaveLength(2);
    expect(rankPromptVariants(results)[0]).toMatchObject({ averageScore: 1, variantId: "variant-a" });
    expect(seen).toEqual(["Variant A", "Variant B"]);
  });

  it("prepends system prompt without dropping existing messages", () => {
    expect(applySystemPrompt([{ content: "Hi", role: "user" }], "System")[0]).toEqual({
      content: "System",
      role: "system"
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
