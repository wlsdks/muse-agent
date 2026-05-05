import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
import { createRunId, type JsonObject } from "@muse/shared";

export type EvalStatus = "passed" | "failed" | "error";

export interface EvalCase {
  readonly id: string;
  readonly name: string;
  readonly input: readonly ModelMessage[];
  readonly expected?: string;
  readonly metadata: JsonObject;
  readonly rubric?: EvalRubric;
}

export interface EvalRubric {
  readonly criteria: readonly EvalCriterion[];
  readonly passThreshold: number;
}

export interface EvalCriterion {
  readonly name: string;
  readonly weight: number;
  readonly description?: string;
}

export interface EvalJudgeResult {
  readonly score: number;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly criterionScores: Readonly<Record<string, number>>;
}

export interface EvalResult {
  readonly id: string;
  readonly caseId: string;
  readonly caseName: string;
  readonly status: EvalStatus;
  readonly response?: ModelResponse;
  readonly judge?: EvalJudgeResult;
  readonly error?: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export interface EvalJudge {
  judge(testCase: EvalCase, response: ModelResponse): Promise<EvalJudgeResult> | EvalJudgeResult;
}

export interface EvalRunnerOptions {
  readonly provider: ModelProvider;
  readonly judge: EvalJudge;
  readonly model: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class ExactMatchJudge implements EvalJudge {
  judge(testCase: EvalCase, response: ModelResponse): EvalJudgeResult {
    const expected = testCase.expected?.trim();
    const actual = response.output.trim();
    const passed = Boolean(expected) && actual === expected;

    return {
      criterionScores: { exact_match: passed ? 1 : 0 },
      passed,
      reasons: passed ? ["Output exactly matched expected text"] : ["Output did not exactly match expected text"],
      score: passed ? 1 : 0
    };
  }
}

export class KeywordJudge implements EvalJudge {
  judge(testCase: EvalCase, response: ModelResponse): EvalJudgeResult {
    const keywords = stringArray(testCase.metadata.keywords);
    const normalized = response.output.toLowerCase();
    const matched = keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
    const score = keywords.length === 0 ? 1 : matched.length / keywords.length;

    return {
      criterionScores: { keyword_coverage: score },
      passed: score >= (testCase.rubric?.passThreshold ?? 1),
      reasons: [`Matched ${matched.length}/${keywords.length} keyword(s)`],
      score
    };
  }
}

export class WeightedRubricJudge implements EvalJudge {
  constructor(private readonly scoreCriterion: (criterion: EvalCriterion, testCase: EvalCase, response: ModelResponse) => number) {}

  judge(testCase: EvalCase, response: ModelResponse): EvalJudgeResult {
    const rubric = testCase.rubric;

    if (!rubric || rubric.criteria.length === 0) {
      return { criterionScores: {}, passed: true, reasons: ["No rubric criteria"], score: 1 };
    }

    const totalWeight = rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0) || 1;
    const criterionScores = Object.fromEntries(
      rubric.criteria.map((criterion) => [criterion.name, clamp(this.scoreCriterion(criterion, testCase, response), 0, 1)])
    );
    const score = rubric.criteria.reduce(
      (total, criterion) => total + (criterionScores[criterion.name] ?? 0) * criterion.weight,
      0
    ) / totalWeight;

    return {
      criterionScores,
      passed: score >= rubric.passThreshold,
      reasons: [`Weighted rubric score ${score.toFixed(3)} against threshold ${rubric.passThreshold}`],
      score
    };
  }
}

export class EvalRunner {
  private readonly provider: ModelProvider;
  private readonly judge: EvalJudge;
  private readonly model: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: EvalRunnerOptions) {
    this.provider = options.provider;
    this.judge = options.judge;
    this.model = options.model;
    this.idFactory = options.idFactory ?? (() => createRunId("eval_result"));
    this.now = options.now ?? (() => new Date());
  }

  async run(testCase: EvalCase): Promise<EvalResult> {
    const startedAt = this.now();

    try {
      const response = await this.provider.generate({
        messages: testCase.input,
        metadata: testCase.metadata,
        model: this.model
      });
      const judge = await this.judge.judge(testCase, response);

      return {
        caseId: testCase.id,
        caseName: testCase.name,
        completedAt: this.now(),
        id: this.idFactory(),
        judge,
        response,
        startedAt,
        status: judge.passed ? "passed" : "failed"
      };
    } catch (error) {
      return {
        caseId: testCase.id,
        caseName: testCase.name,
        completedAt: this.now(),
        error: error instanceof Error ? error.message : "unknown eval failure",
        id: this.idFactory(),
        startedAt,
        status: "error"
      };
    }
  }

  async runSuite(cases: readonly EvalCase[]): Promise<readonly EvalResult[]> {
    const results: EvalResult[] = [];

    for (const testCase of cases) {
      results.push(await this.run(testCase));
    }

    return results;
  }
}

export function summarizeEvalResults(results: readonly EvalResult[]) {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const errors = results.filter((result) => result.status === "error").length;
  const scored = results.flatMap((result) => result.judge?.score ?? []);
  const averageScore = scored.length === 0 ? 0 : scored.reduce((total, score) => total + score, 0) / scored.length;

  return {
    averageScore,
    errors,
    failed,
    passed,
    total: results.length
  };
}

export function createEvalCase(input: Omit<EvalCase, "id" | "metadata"> & {
  readonly id?: string;
  readonly metadata?: JsonObject;
}): EvalCase {
  return {
    id: input.id ?? createRunId("eval_case"),
    input: input.input,
    metadata: input.metadata ?? {},
    name: input.name,
    expected: input.expected,
    rubric: input.rubric
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
