/**
 * Pure response/serialization helpers for the Reactor-compat agent-eval flow.
 *
 * These helpers shape stored eval records and run logs into the API response
 * envelopes, count behavior + total assertions for promotion validation, and
 * mint synthetic run records for replay flows when the history store has not
 * yet recorded the run. They take no options and never touch DB stores —
 * keeping them in their own module makes the route helpers in
 * agent-eval-compat-routes easier to read and lets unit tests target the
 * shape contract directly.
 */

import type { AgentRunResult } from "@muse/agent-core";
import type { AgentRunRecord, ToolCallRecord } from "@muse/runtime-state";
import { createRunId, type JsonObject } from "@muse/shared";
import {
  isRecord,
  nowIso,
  nullableStringResponse,
  readNullableNumber,
  readNumber,
  readStringSet,
  stringField,
  type CompatRecord
} from "./reactor-compat-routes.js";

export function prepareEvalRecord(record: JsonObject, prefix: string): JsonObject {
  const createdAt = nullableStringResponse(record.createdAt) ?? nowIso();
  return {
    ...record,
    createdAt,
    id: stringField(record.id, "") || stringField(record.runId, "") || createRunId(prefix),
    updatedAt: nullableStringResponse(record.updatedAt) ?? nowIso()
  };
}

export function evalStoreRecordToCompat(record: JsonObject, prefix: string): CompatRecord {
  const createdAt = nullableStringResponse(record.createdAt)
    ?? nullableStringResponse(record.evaluatedAt)
    ?? nullableStringResponse(record.startedAt)
    ?? nowIso();
  return {
    ...record,
    createdAt,
    id: stringField(record.id, "") || stringField(record.runId, "") || createRunId(prefix),
    updatedAt: nullableStringResponse(record.updatedAt) ?? createdAt
  };
}

export function toEvalRunLogResponse(log: JsonObject): JsonObject {
  const toolExposure = isRecord(log.toolExposure) ? log.toolExposure : {};
  const toolCalls = Array.isArray(log.toolCalls) ? log.toolCalls : [];
  const retrievedChunks = Array.isArray(log.retrievedChunks) ? log.retrievedChunks : [];
  const errors = Array.isArray(log.errors) ? log.errors : [];
  const finalAnswer = typeof log.finalAnswer === "string" ? log.finalAnswer : "";
  return {
    agentType: typeof log.agentType === "string" ? log.agentType : "standard",
    errorCount: typeof log.errorCount === "number" ? log.errorCount : errors.length,
    evalCaseId: typeof log.evalCaseId === "string" ? log.evalCaseId : null,
    finalAnswerPreview: finalAnswer.slice(0, 240),
    model: typeof log.model === "string" ? log.model : "unknown",
    retrievedChunkCount: typeof log.retrievedChunkCount === "number" ? log.retrievedChunkCount : retrievedChunks.length,
    runId: typeof log.runId === "string" ? log.runId : String(log.id ?? ""),
    toolCallCount: typeof log.toolCallCount === "number" ? log.toolCallCount : toolCalls.length,
    toolExposureCount: typeof toolExposure.count === "number" ? toolExposure.count : 0,
    toolExposureNames: readStringSet(toolExposure.names)
  };
}

export function toEvalToolCall(toolCall: ToolCallRecord): JsonObject {
  return {
    arguments: toolCall.arguments,
    errorCode: toolCall.error ?? null,
    latencyMs: toolCall.startedAt && toolCall.completedAt
      ? Math.max(0, toolCall.completedAt.getTime() - toolCall.startedAt.getTime())
      : 0,
    step: 0,
    success: toolCall.status === "completed",
    toolName: toolCall.name
  };
}

export function toEvalCaseResponse(record: JsonObject): JsonObject {
  return {
    agentType: typeof record.agentType === "string" ? record.agentType : null,
    assertionCount: readNumber(record.assertionCount, countEvalAssertions(record)),
    enabled: record.enabled !== false,
    id: typeof record.id === "string" ? record.id : "",
    minScore: readNumber(record.minScore, 1),
    model: typeof record.model === "string" ? record.model : null,
    name: typeof record.name === "string" ? record.name : "",
    sourceRunId: typeof record.sourceRunId === "string" ? record.sourceRunId : null,
    tags: readStringSet(record.tags)
  };
}

export function countEvalAssertions(value: JsonObject): number {
  return countBehaviorAssertions(value) +
    (typeof value.agentType === "string" && value.agentType.length > 0 ? 1 : 0) +
    (typeof value.model === "string" && value.model.length > 0 ? 1 : 0);
}

export function countBehaviorAssertions(value: JsonObject): number {
  return readStringSet(value.expectedAnswerContains).length +
    readStringSet(value.forbiddenAnswerContains).length +
    readStringSet(value.expectedToolNames).length +
    readStringSet(value.forbiddenToolNames).length +
    readStringSet(value.expectedExposedToolNames).length +
    readStringSet(value.forbiddenExposedToolNames).length +
    (readNullableNumber(value.maxToolExposureCount) === undefined ? 0 : 1);
}

export function agentEvalResult(
  evalCase: JsonObject,
  run: AgentRunRecord,
  passed: boolean,
  score: number,
  reasons: string[]
): JsonObject {
  return {
    caseId: typeof evalCase.id === "string" ? evalCase.id : "",
    forbiddenToolsExposed: [],
    forbiddenToolsUsed: [],
    missingExpectedAnswerContains: [],
    missingExpectedExposedTools: [],
    missingExpectedTools: [],
    passed,
    reasons,
    runId: run.id,
    score,
    toolExposureCountExceeded: false
  };
}

export function replayRunId(evalCaseId: string): string {
  return `replay-${evalCaseId.replace(/[^A-Za-z0-9_-]/gu, "_")}-${Date.now()}`;
}

export function evalCaseRunMode(value: unknown): AgentRunRecord["mode"] {
  return value === "react" || value === "standard" || value === "plan_execute" ? value : "standard";
}

export function syntheticReplayRun(
  evalCase: JsonObject,
  result: AgentRunResult,
  input: string,
  userId: string | undefined
): AgentRunRecord {
  const now = new Date();
  return {
    completedAt: now,
    costUsd: "0",
    createdAt: now,
    id: result.runId,
    input,
    mode: evalCaseRunMode(evalCase.agentType),
    model: result.response.model,
    output: result.response.output,
    provider: "agent_runtime",
    startedAt: now,
    status: "completed",
    tokenUsage: result.response.usage ? { ...result.response.usage } : {},
    updatedAt: now,
    ...(userId ? { userId } : {})
  };
}

export function replayToolCalls(result: AgentRunResult, runId: string): readonly ToolCallRecord[] | undefined {
  if (!result.toolsUsed || result.toolsUsed.length === 0) {
    return undefined;
  }

  const now = new Date();
  return result.toolsUsed.map((name, index) => ({
    arguments: {},
    completedAt: now,
    createdAt: now,
    id: `${runId}:tool:${index + 1}`,
    name,
    risk: "read",
    runId,
    startedAt: now,
    status: "completed"
  }));
}
