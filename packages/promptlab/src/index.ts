import type { EvalCase, EvalJudgeResult } from "@muse/eval";
import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
import { createRunId, type JsonObject } from "@muse/shared";

export interface PromptVariant {
  readonly id: string;
  readonly name: string;
  readonly systemPrompt: string;
  readonly metadata: JsonObject;
}

export interface PromptExperiment {
  readonly id: string;
  readonly name: string;
  readonly variants: readonly PromptVariant[];
  readonly cases: readonly EvalCase[];
  readonly model: string;
  readonly metadata: JsonObject;
}

export interface PromptExperimentResult {
  readonly experimentId: string;
  readonly variantId: string;
  readonly caseId: string;
  readonly response: ModelResponse;
  readonly judge?: EvalJudgeResult;
}

export interface PromptExperimentRunnerOptions {
  readonly provider: ModelProvider;
  readonly model?: string;
  readonly judge?: (testCase: EvalCase, response: ModelResponse) => EvalJudgeResult | Promise<EvalJudgeResult>;
}

export class PromptExperimentRunner {
  constructor(private readonly options: PromptExperimentRunnerOptions) {}

  async run(experiment: PromptExperiment): Promise<readonly PromptExperimentResult[]> {
    const results: PromptExperimentResult[] = [];
    const model = this.options.model ?? experiment.model;

    for (const variant of experiment.variants) {
      for (const testCase of experiment.cases) {
        const response = await this.options.provider.generate({
          messages: applySystemPrompt(testCase.input, variant.systemPrompt),
          metadata: {
            ...experiment.metadata,
            caseId: testCase.id,
            experimentId: experiment.id,
            variantId: variant.id
          },
          model
        });
        const judge = this.options.judge ? await this.options.judge(testCase, response) : undefined;
        results.push({
          caseId: testCase.id,
          experimentId: experiment.id,
          judge,
          response,
          variantId: variant.id
        });
      }
    }

    return results;
  }
}

export function createPromptVariant(input: Omit<PromptVariant, "id" | "metadata"> & {
  readonly id?: string;
  readonly metadata?: JsonObject;
}): PromptVariant {
  return {
    id: input.id ?? createRunId("prompt_variant"),
    metadata: input.metadata ?? {},
    name: input.name,
    systemPrompt: input.systemPrompt
  };
}

export function createPromptExperiment(input: Omit<PromptExperiment, "id" | "metadata"> & {
  readonly id?: string;
  readonly metadata?: JsonObject;
}): PromptExperiment {
  return {
    cases: input.cases,
    id: input.id ?? createRunId("prompt_experiment"),
    metadata: input.metadata ?? {},
    model: input.model,
    name: input.name,
    variants: input.variants
  };
}

export function rankPromptVariants(results: readonly PromptExperimentResult[]): readonly {
  readonly averageScore: number;
  readonly total: number;
  readonly variantId: string;
}[] {
  const grouped = new Map<string, number[]>();

  for (const result of results) {
    const scores = grouped.get(result.variantId) ?? [];
    scores.push(result.judge?.score ?? 0);
    grouped.set(result.variantId, scores);
  }

  return [...grouped.entries()]
    .map(([variantId, scores]) => ({
      averageScore: scores.reduce((total, score) => total + score, 0) / scores.length,
      total: scores.length,
      variantId
    }))
    .sort((left, right) => right.averageScore - left.averageScore);
}

export function applySystemPrompt(messages: readonly ModelMessage[], systemPrompt: string): readonly ModelMessage[] {
  const [first, ...rest] = messages;

  if (first?.role === "system") {
    return [{ ...first, content: `${systemPrompt}\n\n${first.content}` }, ...rest];
  }

  return [{ content: systemPrompt, role: "system" }, ...messages];
}
