import {
  EvalRunner,
  ExactMatchJudge,
  KeywordJudge,
  createEvalCase,
  summarizeEvalResults,
  type EvalCase,
  type EvalJudge,
  type EvalJudgeResult
} from "@muse/eval";
import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
import {
  PromptExperimentRunner,
  createPromptExperiment,
  createPromptVariant,
  rankPromptVariants
} from "@muse/promptlab";
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";

export interface QualityRouteOptions {
  readonly authorizeAdmin: (
    request: unknown,
    reply: { status(statusCode: number): { send(payload: ApiError): void } }
  ) => boolean;
  readonly defaultModel?: string;
  readonly modelProvider?: ModelProvider;
}

interface ApiError {
  readonly code: string;
  readonly message: string;
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

export function registerQualityRoutes(server: FastifyInstance, options: QualityRouteOptions): void {
  for (const prefix of ["/api", ""]) {
    server.post(`${prefix}/eval/run`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      if (!options.modelProvider) {
        return sendQualityUnavailable(reply);
      }

      const parsed = parseEvalRunRequest(request.body, options.defaultModel);

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      const runner = new EvalRunner({
        judge: createJudge(parsed.value.judge),
        model: parsed.value.model,
        provider: options.modelProvider
      });
      const results = await runner.runSuite(parsed.value.cases);

      return {
        results,
        summary: summarizeEvalResults(results)
      };
    });

    server.post(`${prefix}/promptlab/run`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      if (!options.modelProvider) {
        return sendQualityUnavailable(reply);
      }

      const parsed = parsePromptLabRunRequest(request.body, options.defaultModel);

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      const judge = createPromptJudge(parsed.value.judge);
      const runner = new PromptExperimentRunner({
        judge,
        model: parsed.value.experiment.model,
        provider: options.modelProvider
      });
      const results = await runner.run(parsed.value.experiment);

      return {
        ranking: rankPromptVariants(results),
        results
      };
    });
  }
}

function parseEvalRunRequest(
  value: unknown,
  defaultModel: string | undefined
): ParseResult<{
  readonly cases: readonly EvalCase[];
  readonly judge?: string;
  readonly model: string;
}> {
  if (!isRecord(value)) {
    return invalid("INVALID_EVAL_REQUEST", "Body must be an object");
  }

  const model = readString(value, "model", defaultModel);
  const cases = parseEvalCases(value.cases);

  if (!model || model.trim().length === 0) {
    return invalid("INVALID_EVAL_REQUEST", "Body must include model or server defaultModel");
  }

  if (!cases) {
    return invalid("INVALID_EVAL_REQUEST", "Body must include cases");
  }

  return {
    ok: true,
    value: {
      cases,
      judge: readString(value, "judge"),
      model
    }
  };
}

function parsePromptLabRunRequest(
  value: unknown,
  defaultModel: string | undefined
): ParseResult<{
  readonly experiment: ReturnType<typeof createPromptExperiment>;
  readonly judge?: string;
}> {
  if (!isRecord(value)) {
    return invalid("INVALID_PROMPTLAB_REQUEST", "Body must be an object");
  }

  const model = readString(value, "model", defaultModel);
  const name = readString(value, "name") ?? "Prompt experiment";
  const variants = parsePromptVariants(value.variants);
  const cases = parseEvalCases(value.cases);

  if (!model || model.trim().length === 0) {
    return invalid("INVALID_PROMPTLAB_REQUEST", "Body must include model or server defaultModel");
  }

  if (!variants || !cases) {
    return invalid("INVALID_PROMPTLAB_REQUEST", "Body must include variants and cases");
  }

  return {
    ok: true,
    value: {
      experiment: createPromptExperiment({
        cases,
        id: readString(value, "id"),
        metadata: readJsonObject(value, "metadata") ?? {},
        model,
        name,
        variants
      }),
      judge: readString(value, "judge")
    }
  };
}

function parseEvalCases(value: unknown): readonly EvalCase[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const cases = value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readString(entry, "name", `Case ${index + 1}`);
    const input = parseMessages(entry.input);

    if (!name || !input) {
      return [];
    }

    return [createEvalCase({
      expected: readString(entry, "expected"),
      id: readString(entry, "id"),
      input,
      metadata: readJsonObject(entry, "metadata") ?? {},
      name,
      rubric: parseRubric(entry.rubric)
    })];
  });

  return cases.length === value.length ? cases : undefined;
}

function parsePromptVariants(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const variants = value.flatMap((entry, index) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readString(entry, "name", `Variant ${index + 1}`);
    const systemPrompt = readString(entry, "systemPrompt");

    if (!name || !systemPrompt) {
      return [];
    }

    return [createPromptVariant({
      id: readString(entry, "id"),
      metadata: readJsonObject(entry, "metadata") ?? {},
      name,
      systemPrompt
    })];
  });

  return variants.length === value.length ? variants : undefined;
}

function parseMessages(value: unknown): readonly ModelMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const messages = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string" || !isRole(entry.role)) {
      return [];
    }

    return [{
      content: entry.content,
      role: entry.role
    }];
  });

  return messages.length === value.length ? messages : undefined;
}

function parseRubric(value: unknown): EvalCase["rubric"] | undefined {
  if (!isRecord(value) || !Array.isArray(value.criteria)) {
    return undefined;
  }

  const criteria = value.criteria.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.weight !== "number") {
      return [];
    }

    return [{
      description: readString(entry, "description"),
      name: entry.name,
      weight: entry.weight
    }];
  });

  return {
    criteria,
    passThreshold: typeof value.passThreshold === "number" ? value.passThreshold : 1
  };
}

function createJudge(name: string | undefined): EvalJudge {
  return name === "exact" ? new ExactMatchJudge() : new KeywordJudge();
}

function createPromptJudge(
  name: string | undefined
): ((testCase: EvalCase, response: ModelResponse) => EvalJudgeResult | Promise<EvalJudgeResult>) | undefined {
  if (!name) {
    return undefined;
  }

  const judge = createJudge(name);
  return (testCase, response) => judge.judge(testCase, response);
}

function sendQualityUnavailable(reply: { status(statusCode: number): { send(payload: ApiError): void } }) {
  return reply.status(404).send({
    code: "MODEL_PROVIDER_UNAVAILABLE",
    message: "Model provider is not configured"
  });
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

function isRole(value: unknown): value is ModelMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function readString(value: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "string" ? value[key] : undefined;
}

function readJsonObject(value: Record<string, unknown>, key: string): JsonObject | undefined {
  return hasOwn(value, key) && isJsonObject(value[key]) ? value[key] : undefined;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}
