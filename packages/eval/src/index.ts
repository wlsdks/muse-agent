import type { ModelMessage, ModelProvider, ModelResponse } from "@muse/model";
import type {
  AgentEvalCaseTable,
  AgentEvalResultTable,
  AgentRunLogTable,
  DebugReplayCaptureTable,
  MuseDatabase
} from "@muse/db";
import { createRunId, type JsonObject, type JsonValue } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

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

export interface AgentEvalStore {
  getCase(id: string): Promise<JsonObject | undefined>;
  getDebugReplayCapture(id: string): Promise<JsonObject | undefined>;
  listCases(options?: { readonly enabledOnly?: boolean; readonly limit?: number; readonly tags?: readonly string[] }): Promise<readonly JsonObject[]>;
  listDebugReplayCaptures(limit?: number): Promise<readonly JsonObject[]>;
  listResults(options?: { readonly caseId?: string; readonly limit?: number; readonly tier?: string }): Promise<readonly JsonObject[]>;
  listRunLogs(limit?: number): Promise<readonly JsonObject[]>;
  purgeExpired(referenceTime?: Date): Promise<AgentEvalRetentionPurgeResult>;
  saveCase(record: JsonObject): Promise<JsonObject>;
  saveDebugReplayCapture(record: JsonObject): Promise<JsonObject>;
  saveResult(record: JsonObject): Promise<JsonObject>;
  saveRunLog(record: JsonObject): Promise<JsonObject>;
}

export interface AgentEvalRetentionPurgeResult extends JsonObject {
  readonly debugReplayCaptures: number;
  readonly runLogs: number;
}

export interface AgentEvalSuiteSummary extends JsonObject {
  readonly behaviorAssertionCount: number;
  readonly casesWithoutBehaviorAssertions: string[];
  readonly totalCases: number;
}

type AgentRunLogRow = Selectable<AgentRunLogTable>;
type AgentRunLogInsert = Insertable<AgentRunLogTable>;
type AgentEvalCaseRow = Selectable<AgentEvalCaseTable>;
type AgentEvalCaseInsert = Insertable<AgentEvalCaseTable>;
type AgentEvalResultRow = Selectable<AgentEvalResultTable>;
type AgentEvalResultInsert = Insertable<AgentEvalResultTable>;
type DebugReplayCaptureRow = Selectable<DebugReplayCaptureTable>;
type DebugReplayCaptureInsert = Insertable<DebugReplayCaptureTable>;

export class InMemoryAgentEvalStore implements AgentEvalStore {
  private readonly cases = new Map<string, JsonObject>();
  private readonly debugReplayCaptures = new Map<string, JsonObject>();
  private readonly results = new Map<string, JsonObject>();
  private readonly runLogs = new Map<string, JsonObject>();

  async saveCase(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "eval_case");
    this.cases.set(saved.id, saved);
    return saved;
  }

  async listCases(options: { readonly enabledOnly?: boolean; readonly limit?: number; readonly tags?: readonly string[] } = {}): Promise<readonly JsonObject[]> {
    const tags = new Set(options.tags ?? []);
    return [...this.cases.values()]
      .filter((item) => !options.enabledOnly || item.enabled !== false)
      .filter((item) => tags.size === 0 || jsonStringArray(item.tags).some((tag) => tags.has(tag)))
      .slice(0, options.limit ?? 100);
  }

  async getCase(id: string): Promise<JsonObject | undefined> {
    return this.cases.get(id);
  }

  async saveRunLog(record: JsonObject): Promise<JsonObject> {
    const id = stringValue(record.runId) || stringValue(record.id) || createRunId("agent_eval_run_log");
    const saved = withIdentity({ ...record, id, runId: id }, "agent_eval_run_log");
    this.runLogs.set(id, saved);
    return saved;
  }

  async listRunLogs(limit = 50): Promise<readonly JsonObject[]> {
    return [...this.runLogs.values()].slice(0, Math.max(0, limit));
  }

  async purgeExpired(referenceTime = new Date()): Promise<AgentEvalRetentionPurgeResult> {
    let runLogs = 0;
    let debugReplayCaptures = 0;

    for (const [id, record] of this.runLogs) {
      const expiresAt = nullableDate(record.expiresAt);

      if (expiresAt && expiresAt.getTime() <= referenceTime.getTime()) {
        this.runLogs.delete(id);
        runLogs += 1;
      }
    }

    for (const [id, record] of this.debugReplayCaptures) {
      const expiresAt = nullableDate(record.expiresAt);

      if (expiresAt && expiresAt.getTime() <= referenceTime.getTime()) {
        this.debugReplayCaptures.delete(id);
        debugReplayCaptures += 1;
      }
    }

    return { debugReplayCaptures, runLogs };
  }

  async saveResult(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "agent_eval_result");
    this.results.set(saved.id, saved);
    return saved;
  }

  async listResults(options: { readonly caseId?: string; readonly limit?: number; readonly tier?: string } = {}): Promise<readonly JsonObject[]> {
    return [...this.results.values()]
      .filter((result) => !options.caseId || result.caseId === options.caseId)
      .filter((result) => !options.tier || result.tier === options.tier)
      .slice(0, options.limit ?? 100);
  }

  async saveDebugReplayCapture(record: JsonObject): Promise<JsonObject> {
    const saved = withIdentity(record, "debug_replay");
    this.debugReplayCaptures.set(saved.id, saved);
    return saved;
  }

  async listDebugReplayCaptures(limit = 50): Promise<readonly JsonObject[]> {
    return [...this.debugReplayCaptures.values()].slice(0, Math.max(0, limit));
  }

  async getDebugReplayCapture(id: string): Promise<JsonObject | undefined> {
    return this.debugReplayCaptures.get(id);
  }
}

export class KyselyAgentEvalStore implements AgentEvalStore {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async saveCase(record: JsonObject): Promise<JsonObject> {
    const row = createAgentEvalCaseInsert(record);
    const saved = await this.db
      .insertInto("agent_eval_cases")
      .values(row)
      .onConflict((oc) => oc.column("id").doUpdateSet({
        agent_type: row.agent_type,
        enabled: row.enabled,
        expected_answer_contains_json: row.expected_answer_contains_json,
        expected_tool_names_json: row.expected_tool_names_json,
        forbidden_answer_contains_json: row.forbidden_answer_contains_json,
        forbidden_tool_names_json: row.forbidden_tool_names_json,
        min_score: row.min_score,
        model: row.model,
        name: row.name,
        source_run_id: row.source_run_id,
        tags_json: row.tags_json,
        updated_at: row.updated_at,
        user_input: row.user_input
      }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapAgentEvalCaseRow(saved, record);
  }

  async listCases(options: { readonly enabledOnly?: boolean; readonly limit?: number; readonly tags?: readonly string[] } = {}): Promise<readonly JsonObject[]> {
    let query = this.db.selectFrom("agent_eval_cases").selectAll();
    if (options.enabledOnly) {
      query = query.where("enabled", "=", true);
    }
    const rows = await query.orderBy("updated_at", "desc").limit(options.limit ?? 100).execute();
    const tags = new Set(options.tags ?? []);
    return rows
      .map((row) => mapAgentEvalCaseRow(row))
      .filter((item) => tags.size === 0 || jsonStringArray(item.tags).some((tag) => tags.has(tag)));
  }

  async getCase(id: string): Promise<JsonObject | undefined> {
    const row = await this.db.selectFrom("agent_eval_cases").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapAgentEvalCaseRow(row) : undefined;
  }

  async saveRunLog(record: JsonObject): Promise<JsonObject> {
    const row = createAgentRunLogInsert(record);
    const saved = await this.db
      .insertInto("agent_run_logs")
      .values(row)
      .onConflict((oc) => oc.column("run_id").doUpdateSet({
        agent_type: row.agent_type,
        cost_usd: row.cost_usd,
        ended_at: row.ended_at,
        errors_json: row.errors_json,
        eval_case_id: row.eval_case_id,
        expires_at: row.expires_at,
        final_answer: row.final_answer,
        model: row.model,
        retrieved_chunks_json: row.retrieved_chunks_json,
        started_at: row.started_at,
        token_usage_json: row.token_usage_json,
        tool_calls_json: row.tool_calls_json,
        tool_exposure_json: row.tool_exposure_json,
        user_input: row.user_input
      }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapAgentRunLogRow(saved);
  }

  async listRunLogs(limit = 50): Promise<readonly JsonObject[]> {
    const rows = await this.db.selectFrom("agent_run_logs").selectAll().orderBy("started_at", "desc").limit(limit).execute();
    return rows.map(mapAgentRunLogRow);
  }

  async purgeExpired(referenceTime = new Date()): Promise<AgentEvalRetentionPurgeResult> {
    const runLogDelete = await this.db
      .deleteFrom("agent_run_logs")
      .where("expires_at", "is not", null)
      .where("expires_at", "<=", referenceTime)
      .executeTakeFirst();
    const debugReplayDelete = await this.db
      .deleteFrom("debug_replay_captures")
      .where("expires_at", "<=", referenceTime)
      .executeTakeFirst();

    return {
      debugReplayCaptures: Number(debugReplayDelete.numDeletedRows ?? 0),
      runLogs: Number(runLogDelete.numDeletedRows ?? 0)
    };
  }

  async saveResult(record: JsonObject): Promise<JsonObject> {
    const row = createAgentEvalResultInsert(record);
    const saved = await this.db
      .insertInto("agent_eval_results")
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapAgentEvalResultRow(saved);
  }

  async listResults(options: { readonly caseId?: string; readonly limit?: number; readonly tier?: string } = {}): Promise<readonly JsonObject[]> {
    let query = this.db.selectFrom("agent_eval_results").selectAll();
    if (options.caseId) {
      query = query.where("case_id", "=", options.caseId);
    }
    if (options.tier) {
      query = query.where("tier", "=", options.tier);
    }
    const rows = await query.orderBy("evaluated_at", "desc").limit(options.limit ?? 100).execute();
    return rows.map(mapAgentEvalResultRow);
  }

  async saveDebugReplayCapture(record: JsonObject): Promise<JsonObject> {
    const row = createDebugReplayCaptureInsert(record);
    const saved = await this.db.insertInto("debug_replay_captures").values(row).returningAll().executeTakeFirstOrThrow();
    return mapDebugReplayCaptureRow(saved);
  }

  async listDebugReplayCaptures(limit = 50): Promise<readonly JsonObject[]> {
    const rows = await this.db.selectFrom("debug_replay_captures").selectAll().orderBy("captured_at", "desc").limit(limit).execute();
    return rows.map(mapDebugReplayCaptureRow);
  }

  async getDebugReplayCapture(id: string): Promise<JsonObject | undefined> {
    const row = await this.db.selectFrom("debug_replay_captures").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapDebugReplayCaptureRow(row) : undefined;
  }
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

export function summarizeAgentEvalSuite(cases: readonly JsonObject[]): AgentEvalSuiteSummary {
  let behaviorAssertionCount = 0;
  const casesWithoutBehaviorAssertions: string[] = [];

  for (const testCase of cases) {
    const count = countBehaviorAssertions(testCase);

    behaviorAssertionCount += count;

    if (count === 0) {
      casesWithoutBehaviorAssertions.push(stringValue(testCase.id) || stringValue(testCase.name) || "unknown");
    }
  }

  return {
    behaviorAssertionCount,
    casesWithoutBehaviorAssertions,
    totalCases: cases.length
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

export function createAgentRunLogInsert(record: JsonObject): AgentRunLogInsert {
  const runId = stringValue(record.runId) || stringValue(record.id) || createRunId("agent_eval_run_log");
  return {
    agent_type: stringValue(record.agentType) || "standard",
    cost_usd: stringValue(record.costUsd) || "0",
    created_at: dateValue(record.createdAt),
    ended_at: dateValue(record.endedAt),
    errors_json: jsonArray(record.errors),
    eval_case_id: nullableString(record.evalCaseId),
    expires_at: nullableDate(record.expiresAt),
    final_answer: stringValue(record.finalAnswer),
    model: stringValue(record.model) || "unknown",
    retrieved_chunks_json: jsonArray(record.retrievedChunks),
    run_id: runId,
    started_at: dateValue(record.startedAt),
    token_usage_json: jsonObject(record.tokenUsage),
    tool_calls_json: jsonArray(record.toolCalls),
    tool_exposure_json: jsonObject(record.toolExposure),
    user_input: stringValue(record.userInput)
  };
}

export function mapAgentRunLogRow(row: AgentRunLogRow | AgentRunLogInsert): JsonObject {
  return {
    agentType: row.agent_type,
    costUsd: String(row.cost_usd),
    createdAt: dateValue(row.created_at).toISOString(),
    endedAt: dateValue(row.ended_at).toISOString(),
    errorCount: jsonArray(row.errors_json).length,
    errors: jsonArray(row.errors_json),
    evalCaseId: row.eval_case_id ?? null,
    finalAnswer: row.final_answer,
    id: row.run_id,
    model: row.model,
    retrievedChunkCount: jsonArray(row.retrieved_chunks_json).length,
    retrievedChunks: jsonArray(row.retrieved_chunks_json),
    runId: row.run_id,
    startedAt: dateValue(row.started_at).toISOString(),
    tokenUsage: jsonObject(row.token_usage_json),
    toolCallCount: jsonArray(row.tool_calls_json).length,
    toolCalls: jsonArray(row.tool_calls_json),
    toolExposure: jsonObject(row.tool_exposure_json),
    userInput: row.user_input
  };
}

export function createAgentEvalCaseInsert(record: JsonObject): AgentEvalCaseInsert {
  const prepared = withIdentity(record, "eval_case");
  return {
    agent_type: nullableString(prepared.agentType),
    created_at: dateValue(prepared.createdAt),
    enabled: booleanValue(prepared.enabled, true),
    expected_answer_contains_json: jsonArray(prepared.expectedAnswerContains),
    expected_tool_names_json: jsonArray(prepared.expectedToolNames),
    forbidden_answer_contains_json: jsonArray(prepared.forbiddenAnswerContains),
    forbidden_tool_names_json: jsonArray(prepared.forbiddenToolNames),
    id: prepared.id,
    min_score: numberValue(prepared.minScore, 1),
    model: nullableString(prepared.model),
    name: stringValue(prepared.name),
    source_run_id: nullableString(prepared.sourceRunId),
    tags_json: jsonArray(prepared.tags),
    updated_at: dateValue(prepared.updatedAt),
    user_input: stringValue(prepared.userInput)
  };
}

export function mapAgentEvalCaseRow(row: AgentEvalCaseRow | AgentEvalCaseInsert, source: JsonObject = {}): JsonObject {
  return {
    agentType: row.agent_type ?? null,
    assertionCount: numberValue(source.assertionCount, countPersistedAssertions(row, source)),
    createdAt: dateValue(row.created_at).toISOString(),
    enabled: row.enabled,
    expectedAnswerContains: jsonArray(row.expected_answer_contains_json),
    expectedExposedToolNames: jsonArray(source.expectedExposedToolNames),
    expectedToolNames: jsonArray(row.expected_tool_names_json),
    forbiddenAnswerContains: jsonArray(row.forbidden_answer_contains_json),
    forbiddenExposedToolNames: jsonArray(source.forbiddenExposedToolNames),
    forbiddenToolNames: jsonArray(row.forbidden_tool_names_json),
    id: row.id,
    maxToolExposureCount: source.maxToolExposureCount ?? null,
    minScore: row.min_score,
    model: row.model ?? null,
    name: row.name,
    sourceRunId: row.source_run_id ?? null,
    tags: jsonArray(row.tags_json),
    toolExposureNames: jsonArray(source.toolExposureNames),
    updatedAt: dateValue(row.updated_at).toISOString(),
    userInput: row.user_input
  };
}

export function createAgentEvalResultInsert(record: JsonObject): AgentEvalResultInsert {
  const prepared = withIdentity(record, "agent_eval_result");
  return {
    case_id: stringValue(prepared.caseId),
    evaluated_at: dateValue(prepared.evaluatedAt ?? prepared.createdAt),
    id: prepared.id,
    passed: booleanValue(prepared.passed, false),
    reasons_json: jsonArray(prepared.reasons),
    run_id: nullableString(prepared.runId),
    score: numberValue(prepared.score, 0),
    tier: stringValue(prepared.tier) || "deterministic"
  };
}

export function mapAgentEvalResultRow(row: AgentEvalResultRow | AgentEvalResultInsert): JsonObject {
  return {
    caseId: row.case_id,
    evaluatedAt: dateValue(row.evaluated_at).toISOString(),
    id: row.id,
    passed: row.passed,
    reasons: jsonArray(row.reasons_json),
    runId: row.run_id ?? null,
    score: row.score,
    tier: row.tier
  };
}

export function createDebugReplayCaptureInsert(record: JsonObject): DebugReplayCaptureInsert {
  return {
    captured_at: dateValue(record.capturedAt),
    error_code: nullableString(record.errorCode),
    error_message: nullableString(record.errorMessage),
    expires_at: dateValue(record.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString()),
    id: stringValue(record.id) || undefined,
    metadata_json: jsonObject(record.metadata),
    model_id: nullableString(record.modelId),
    tools_attempted: jsonArray(record.toolsAttempted),
    user_hash: nullableString(record.userHash),
    user_prompt: stringValue(record.userPrompt)
  };
}

export function mapDebugReplayCaptureRow(row: DebugReplayCaptureRow | DebugReplayCaptureInsert): JsonObject {
  return {
    capturedAt: dateValue(row.captured_at).toISOString(),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    expiresAt: dateValue(row.expires_at).toISOString(),
    id: stringValue(row.id),
    metadata: jsonObject(row.metadata_json),
    modelId: row.model_id ?? null,
    toolsAttempted: jsonArray(row.tools_attempted),
    userHash: row.user_hash ?? null,
    userPrompt: row.user_prompt
  };
}

function withIdentity(record: JsonObject, prefix: string): JsonObject & { readonly id: string } {
  const createdAt = dateValue(record.createdAt).toISOString();
  return {
    ...record,
    createdAt,
    id: stringValue(record.id) || createRunId(prefix),
    updatedAt: dateValue(record.updatedAt ?? createdAt).toISOString()
  };
}

function countPersistedAssertions(row: AgentEvalCaseRow | AgentEvalCaseInsert, source: JsonObject): number {
  return jsonArray(row.expected_answer_contains_json).length +
    jsonArray(row.forbidden_answer_contains_json).length +
    jsonArray(row.expected_tool_names_json).length +
    jsonArray(row.forbidden_tool_names_json).length +
    jsonArray(source.expectedExposedToolNames).length +
    jsonArray(source.forbiddenExposedToolNames).length +
    (row.agent_type ? 1 : 0) +
    (row.model ? 1 : 0);
}

function countBehaviorAssertions(record: JsonObject): number {
  return jsonArray(record.expectedAnswerContains).length +
    jsonArray(record.forbiddenAnswerContains).length +
    jsonArray(record.expectedToolNames).length +
    jsonArray(record.forbiddenToolNames).length +
    jsonArray(record.expectedExposedToolNames).length +
    jsonArray(record.forbiddenExposedToolNames).length;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  const normalized = stringValue(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function dateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(typeof value === "string" ? value : Date.now());
}

function nullableDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  return typeof value === "string" && value.trim().length > 0 ? new Date(value) : null;
}

function jsonArray(value: unknown): JsonValue[] {
  if (Array.isArray(value)) {
    return value.filter(isJsonValue);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return jsonArray(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  return [];
}

function jsonStringArray(value: unknown): readonly string[] {
  return jsonArray(value).filter((item): item is string => typeof item === "string");
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)) {
    return value as JsonObject;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      return jsonObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return {};
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return Boolean(value) && typeof value === "object" && Object.values(value).every(isJsonValue);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface CompletenessScore {
  readonly overall: number;
  readonly sampledAt: Date;
}

export interface ResponseCompletenessEvaluatorOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly sampleRate?: number;
  readonly maxPromptChars?: number;
  readonly maxContentChars?: number;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly judgePromptBuilder?: (input: { prompt: string; content: string }) => string;
  readonly randomSource?: () => number;
  readonly now?: () => Date;
  readonly logger?: (message: string, error?: unknown) => void;
}

export interface ResponseCompletenessEvaluator {
  scoreIfSampled(prompt: string, content: string): Promise<CompletenessScore | undefined>;
  scoreNow(prompt: string, content: string): Promise<CompletenessScore | undefined>;
}

const DEFAULT_COMPLETENESS_SAMPLE_RATE = 0.1;
const DEFAULT_COMPLETENESS_MAX_PROMPT_CHARS = 300;
const DEFAULT_COMPLETENESS_MAX_CONTENT_CHARS = 1500;
const COMPLETENESS_SCORE_PATTERN = /\d{1,3}/u;

/**
 * LLM-as-judge response completeness evaluator.
 *
 * Scores how well a response addresses the original user prompt on a 0–100
 * integer scale (higher = more complete). Mirrors Reactor's
 * `ResponseCompletenessEvaluator` semantics: probabilistic sampling
 * (default 10%), short judge prompt with temperature=0, fail-soft on provider
 * errors so the evaluator never blocks a real response.
 */
export function createResponseCompletenessEvaluator(
  options: ResponseCompletenessEvaluatorOptions
): ResponseCompletenessEvaluator {
  const sampleRate = clamp(options.sampleRate ?? DEFAULT_COMPLETENESS_SAMPLE_RATE, 0, 1);
  const maxPromptChars = Math.max(1, options.maxPromptChars ?? DEFAULT_COMPLETENESS_MAX_PROMPT_CHARS);
  const maxContentChars = Math.max(1, options.maxContentChars ?? DEFAULT_COMPLETENESS_MAX_CONTENT_CHARS);
  const randomSource = options.randomSource ?? Math.random;
  const now = options.now ?? (() => new Date());
  const judgePromptBuilder = options.judgePromptBuilder ?? defaultCompletenessJudgePrompt;

  async function scoreNow(prompt: string, content: string): Promise<CompletenessScore | undefined> {
    if (prompt.trim().length === 0 || content.trim().length === 0) {
      return undefined;
    }
    const judgePrompt = judgePromptBuilder({
      content: content.slice(0, maxContentChars),
      prompt: prompt.slice(0, maxPromptChars)
    });
    try {
      const response: ModelResponse = await options.provider.generate({
        messages: [{ content: judgePrompt, role: "user" } satisfies ModelMessage],
        model: options.model,
        ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : { temperature: 0 })
      });
      const raw = (response.output ?? "").trim();
      const match = COMPLETENESS_SCORE_PATTERN.exec(raw);
      if (!match) {
        return undefined;
      }
      const parsed = Number.parseInt(match[0], 10);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      return { overall: clamp(parsed, 0, 100), sampledAt: now() };
    } catch (error) {
      options.logger?.("ResponseCompletenessEvaluator failed (suppressed)", error);
      return undefined;
    }
  }

  async function scoreIfSampled(prompt: string, content: string): Promise<CompletenessScore | undefined> {
    if (sampleRate <= 0 || randomSource() > sampleRate) {
      return undefined;
    }
    return scoreNow(prompt, content);
  }

  return { scoreIfSampled, scoreNow };
}

function defaultCompletenessJudgePrompt(input: { prompt: string; content: string }): string {
  return [
    "Rate how complete and useful the response below is for the given user question, on a 0-100 integer scale.",
    "Criteria: (1) addresses the question intent (40 pts), (2) data/evidence sufficiency (30 pts), (3) clarity (30 pts).",
    "Respond with the integer score only on a single line. No other text.",
    "",
    "[Question]",
    input.prompt,
    "",
    "[Response]",
    input.content,
    "",
    "Score:"
  ].join("\n");
}
