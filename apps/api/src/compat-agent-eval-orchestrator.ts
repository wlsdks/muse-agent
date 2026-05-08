/**
 * Reactor-compat agent-eval orchestrators extracted from
 * reactor-compat-routes.ts. These compose the agent-eval store CRUD,
 * pure shape helpers, and the LLM-as-judge pipeline into the four
 * top-level operations the routes invoke:
 *
 *   - runLogRecord     persist a current run as an eval run-log
 *   - runLogResponse   convenience: runLogRecord + toEvalRunLogResponse
 *   - evaluateRunAgainstCase  deterministic grading against an eval case
 *   - replayEvalCase   replay a case through agentRuntime + record run-log
 *   - storeEvalResult  persist deterministic + optional llm-judge results
 */

import type { AgentRunRecord, ToolCallRecord } from "@muse/runtime-state";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyRequest } from "fastify";
import {
  agentEvalResult,
  countBehaviorAssertions,
  countEvalAssertions,
  replayRunId,
  replayToolCalls,
  syntheticReplayRun,
  toEvalRunLogResponse,
  toEvalToolCall
} from "./compat-agent-eval-shape.js";
import {
  saveAgentEvalResult,
  saveAgentEvalRunLog
} from "./compat-agent-eval-store.js";
import { judgeEvalWithModel } from "./compat-eval-judge.js";
import {
  containsIgnoreCase,
  nowIso,
  readAuthUserId,
  readNullableNumber,
  readNumber,
  readStringSet,
  type CompatRecord,
  type ReactorCompatibilityRouteOptions
} from "./reactor-compat-routes.js";

export async function runLogRecord(
  run: AgentRunRecord,
  options: ReactorCompatibilityRouteOptions,
  toolCallsOverride?: readonly ToolCallRecord[]
): Promise<CompatRecord> {
  const toolCalls = toolCallsOverride ?? await (options.historyStore?.listToolCalls(run.id) ?? []);
  const toolExposureNames = [...new Set(toolCalls.map((toolCall) => toolCall.name))];
  return saveAgentEvalRunLog(options, {
    agentType: run.mode,
    costUsd: run.costUsd,
    endedAt: run.completedAt?.toISOString() ?? run.updatedAt.toISOString(),
    errorCount: run.error ? 1 : 0,
    errors: run.error ? [{ message: run.error }] : [],
    evalCaseId: null,
    finalAnswer: run.output ?? "",
    model: run.model,
    retrievedChunkCount: 0,
    retrievedChunks: [],
    id: run.id,
    runId: run.id,
    startedAt: run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
    tokenUsage: run.tokenUsage,
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.map(toEvalToolCall),
    toolExposure: {
      count: toolExposureNames.length,
      names: toolExposureNames
    },
    userInput: run.input
  });
}

export async function runLogResponse(run: AgentRunRecord, options: ReactorCompatibilityRouteOptions): Promise<JsonObject> {
  return toEvalRunLogResponse(await runLogRecord(run, options));
}

export async function evaluateRunAgainstCase(
  evalCase: JsonObject,
  run: AgentRunRecord,
  options: ReactorCompatibilityRouteOptions,
  toolCallsOverride?: readonly ToolCallRecord[]
): Promise<JsonObject> {
  const assertionCount = countEvalAssertions(evalCase);
  const behaviorAssertionCount = countBehaviorAssertions(evalCase);

  if (evalCase.enabled === false) {
    return agentEvalResult(evalCase, run, true, 1, ["case disabled"]);
  }

  if (assertionCount === 0) {
    return agentEvalResult(evalCase, run, false, 0, ["case has no assertions"]);
  }

  if (behaviorAssertionCount === 0) {
    return agentEvalResult(evalCase, run, false, 0, ["case has no behavior assertions"]);
  }

  const toolCalls = toolCallsOverride ?? await (options.historyStore?.listToolCalls(run.id) ?? []);
  const toolNames = toolCalls.map((toolCall) => toolCall.name);
  const successfulToolNames = toolCalls
    .filter((toolCall) => toolCall.status === "completed")
    .map((toolCall) => toolCall.name);
  const exposedToolNames = readStringSet(evalCase.toolExposureNames).length > 0
    ? readStringSet(evalCase.toolExposureNames)
    : [...new Set(toolNames)];
  const finalAnswer = run.output ?? "";
  const expectedAnswerContains = readStringSet(evalCase.expectedAnswerContains);
  const forbiddenAnswerContains = readStringSet(evalCase.forbiddenAnswerContains);
  const expectedToolNames = readStringSet(evalCase.expectedToolNames);
  const forbiddenToolNames = readStringSet(evalCase.forbiddenToolNames);
  const expectedExposedToolNames = readStringSet(evalCase.expectedExposedToolNames);
  const forbiddenExposedToolNames = readStringSet(evalCase.forbiddenExposedToolNames);
  const maxToolExposureCount = readNullableNumber(evalCase.maxToolExposureCount);
  const missingExpectedAnswerContains = expectedAnswerContains.filter((needle) =>
    !containsIgnoreCase(finalAnswer, needle)
  );
  const matchedForbiddenAnswerContains = forbiddenAnswerContains.filter((needle) =>
    containsIgnoreCase(finalAnswer, needle)
  );
  const missingExpectedTools = expectedToolNames.filter((name) => !toolNames.includes(name));
  const failedExpectedTools = expectedToolNames.filter((name) =>
    toolNames.includes(name) && !successfulToolNames.includes(name)
  );
  const forbiddenToolsUsed = forbiddenToolNames.filter((name) => toolNames.includes(name));
  const missingExpectedExposedTools = expectedExposedToolNames.filter((name) => !exposedToolNames.includes(name));
  const forbiddenToolsExposed = forbiddenExposedToolNames.filter((name) => exposedToolNames.includes(name));
  const toolExposureCountExceeded = maxToolExposureCount === undefined ? false : exposedToolNames.length > maxToolExposureCount;
  const reasons = [
    ...missingExpectedAnswerContains.map((item) => `missing expected answer fragment: ${item}`),
    ...matchedForbiddenAnswerContains.map((item) => `forbidden answer fragment present: ${item}`),
    ...missingExpectedTools.map((item) => `expected tool not used: ${item}`),
    ...failedExpectedTools.map((item) => `expected tool failed: ${item}`),
    ...forbiddenToolsUsed.map((item) => `forbidden tool used: ${item}`),
    ...missingExpectedExposedTools.map((item) => `expected exposed tool missing: ${item}`),
    ...forbiddenToolsExposed.map((item) => `forbidden exposed tool present: ${item}`),
    ...(toolExposureCountExceeded ? [
      `tool exposure count exceeded: max=${maxToolExposureCount}, actual=${exposedToolNames.length}`
    ] : []),
    ...(typeof evalCase.agentType === "string" && evalCase.agentType !== run.mode
      ? [`agentType mismatch: expected=${evalCase.agentType}, actual=${run.mode}`]
      : []),
    ...(typeof evalCase.model === "string" && evalCase.model !== run.model
      ? [`model mismatch: expected=${evalCase.model}, actual=${run.model}`]
      : [])
  ];
  const effectiveAssertionCount = Math.max(1, readNumber(evalCase.assertionCount, assertionCount));
  const score = ((effectiveAssertionCount - reasons.length) / effectiveAssertionCount).toFixed(6);
  const numericScore = Math.max(0, Math.min(1, Number(score)));
  return {
    caseId: typeof evalCase.id === "string" ? evalCase.id : "",
    forbiddenToolsExposed,
    forbiddenToolsUsed,
    missingExpectedAnswerContains,
    missingExpectedExposedTools,
    missingExpectedTools,
    passed: numericScore >= readNumber(evalCase.minScore, 1),
    reasons: reasons.length === 0 ? ["all assertions passed"] : reasons,
    runId: run.id,
    score: numericScore,
    toolExposureCountExceeded
  };
}

export async function replayEvalCase(
  evalCase: JsonObject,
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions
): Promise<{ readonly run: AgentRunRecord; readonly toolCalls?: readonly ToolCallRecord[] }> {
  const id = typeof evalCase.id === "string" ? evalCase.id : createRunId("eval_case");
  const userInput = typeof evalCase.userInput === "string" ? evalCase.userInput : "";
  const model = typeof evalCase.model === "string" && evalCase.model.length > 0
    ? evalCase.model
    : options.defaultModel ?? "default";
  const actor = readAuthUserId(request);
  const metadata: JsonObject = {
    agentEvalReplay: true,
    evalCaseId: id,
    ...(actor ? { userId: actor } : {})
  };

  const result = await options.agentRuntime?.run({
    messages: [
      {
        content: "You are an eval replay agent. Follow the user's request exactly.",
        role: "system"
      },
      {
        content: userInput,
        role: "user"
      }
    ],
    metadata,
    model,
    runId: replayRunId(id)
  });

  if (!result) {
    throw new Error("AgentRuntime is not configured");
  }

  const recordedRun = await options.historyStore?.findRun(result.runId);
  const run = recordedRun ?? syntheticReplayRun(evalCase, result, userInput, actor);
  const toolCalls = recordedRun ? undefined : replayToolCalls(result, run.id);
  await runLogRecord(run, options, toolCalls);
  return { run, ...(toolCalls ? { toolCalls } : {}) };
}

export async function storeEvalResult(
  result: JsonObject,
  includeLlmJudge: boolean,
  options: ReactorCompatibilityRouteOptions,
  evalCase: JsonObject,
  run: AgentRunRecord
): Promise<readonly JsonObject[]> {
  const deterministic = await saveAgentEvalResult(options, {
    caseId: typeof result.caseId === "string" ? result.caseId : "",
    evaluatedAt: nowIso(),
    passed: result.passed === true,
    reasons: readStringSet(result.reasons),
    runId: typeof result.runId === "string" ? result.runId : null,
    score: readNumber(result.score, 0),
    tier: "deterministic"
  });

  if (!includeLlmJudge) {
    return [deterministic];
  }

  const llmJudge = await saveAgentEvalResult(options, await judgeEvalWithModel(evalCase, run, options));
  return [deterministic, llmJudge];
}
