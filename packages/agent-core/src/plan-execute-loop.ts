/**
 * Plan-execute orchestration extracted from packages/agent-core/src/index.ts.
 *
 * The four plan-execute steps — generate plan, execute steps, synthesize
 * results, and the empty-plan direct-answer fallback — are exposed as
 * free functions that take a small `PlanExecuteRunner` facade so the
 * AgentRuntime keeps the runtime loop wiring without owning the
 * plan-execute control flow.
 */

import { buildPlanningSystemPrompt } from "@muse/prompts";
import type { JsonObject } from "@muse/shared";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelToolCall
} from "@muse/model";

import {
  PlanExecutionError,
  PlanValidationFailedError,
  parsePlan,
  PLAN_RESPONSE_SCHEMA,
  renderPlanResultSummary,
  renderToolDescriptionsForPlanning,
  systemMessageContent,
  validatePlan,
  type PlanStep
} from "./plan-execute.js";
import { renderPlanExemplar, type PlanCacheProvider } from "./plan-cache.js";
import { latestUserPrompt, metadataString } from "./runtime-helpers.js";
import {
  blockedToolResult,
  planExecuteIntermediateMessages,
  type ExecutedToolResult,
  type ModelLoopExecution,
  type PlanExecuteStepRecord
} from "./runtime-internals.js";
import type { AgentRunContext } from "./types.js";

export interface PlanExecuteRunner {
  readonly maxToolCalls: number;
  /** Optional plan-template cache (Agentic Plan Caching) — injects a similar past plan as a planning exemplar and records successful plans. */
  readonly planCacheProvider?: PlanCacheProvider;
  generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse>;
  executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ): Promise<ExecutedToolResult>;
}

export type PlanExecuteStreamEvent =
  | { readonly plan: readonly PlanStep[]; readonly runId: string; readonly type: "plan-generated" }
  | {
      readonly description: string;
      readonly runId: string;
      readonly stepIndex: number;
      readonly tool: string;
      readonly type: "plan-step-executing";
    }
  | { readonly runId: string; readonly stepIndex: number; readonly success: boolean; readonly type: "plan-step-result" }
  | { readonly runId: string; readonly type: "synthesis-started" };

export async function executePlanExecuteLoop(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest
): Promise<ModelLoopExecution> {
  const stream = streamPlanExecute(runner, context, provider, request);
  let next = await stream.next();
  while (!next.done) {
    next = await stream.next();
  }
  return next.value;
}

export async function* streamPlanExecute(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest
): AsyncGenerator<PlanExecuteStreamEvent, ModelLoopExecution> {
  const userPrompt = latestUserPrompt(request.messages);
  const tools = request.tools ?? [];
  const toolDescriptions = renderToolDescriptionsForPlanning(tools);
  const userId = metadataString(context.input.metadata, "userId");

  const plan = await generatePlan(runner, context, provider, request, userPrompt, toolDescriptions, userId);
  if (plan === null) {
    throw new PlanExecutionError("PLAN_GENERATION_FAILED", "Plan generation parsing failed");
  }

  yield { plan, runId: context.runId, type: "plan-generated" };

  if (plan.length === 0) {
    yield { runId: context.runId, type: "synthesis-started" };
    const directResponse = await directAnswerForPlanExecute(runner, context, provider, request);
    return {
      finalResponse: directResponse,
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: []
    };
  }

  const validation = validatePlan({
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    steps: plan
  });
  if (!validation.valid) {
    throw new PlanValidationFailedError(validation.errors, plan);
  }

  const executed: PlanExecuteStepRecord[] = [];
  let toolCallCount = 0;
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    if (!step) {
      continue;
    }

    yield {
      description: step.description,
      runId: context.runId,
      stepIndex: index,
      tool: step.tool,
      type: "plan-step-executing"
    };

    if (toolCallCount >= runner.maxToolCalls) {
      const blocked = blockedToolResult(
        { arguments: step.args, id: `plan-step-${index}`, name: step.tool },
        "Error: max tool call limit reached"
      );
      executed.push({
        executed: blocked,
        step,
        stepResult: {
          description: step.description,
          error: "max tool call limit reached",
          output: null,
          success: false,
          tool: step.tool
        }
      });
      yield { runId: context.runId, stepIndex: index, success: false, type: "plan-step-result" };
      continue;
    }

    const synthesizedCall: ModelToolCall = {
      arguments: step.args,
      id: `plan-step-${index}`,
      name: step.tool
    };
    const toolResult = await runner.executeToolCall(context, synthesizedCall, tools);
    toolCallCount += 1;

    const success = toolResult.result.status === "completed";
    executed.push({
      executed: toolResult,
      step,
      stepResult: {
        description: step.description,
        error: success ? undefined : toolResult.result.error ?? "TOOL_ERROR",
        output: success ? toolResult.result.output : null,
        success,
        tool: step.tool
      }
    });
    yield { runId: context.runId, stepIndex: index, success, type: "plan-step-result" };
  }

  if (executed.length > 0 && executed.every((entry) => !entry.stepResult.success)) {
    throw new PlanExecutionError(
      "PLAN_ALL_STEPS_FAILED",
      "Every plan step failed; refusing synthesis to avoid hallucinated answers"
    );
  }

  yield { runId: context.runId, type: "synthesis-started" };
  const finalResponse = await synthesizePlanResults(
    runner,
    context,
    provider,
    request,
    userPrompt,
    executed
  );

  // Agentic Plan Caching (arXiv 2506.14852): record the plan that just
  // executed so a similar future request can reuse it as a planning exemplar.
  // Reached only after at least one step succeeded (all-failed throws above).
  // Fail-open — a cache write must never break the run.
  if (runner.planCacheProvider && userId && plan.length > 0) {
    try {
      await runner.planCacheProvider.recordPlan(userId, userPrompt, plan);
    } catch {
      // ignore — caching is best-effort
    }
  }

  return {
    finalResponse,
    intermediateMessages: planExecuteIntermediateMessages(plan, executed),
    toolResults: executed.map((entry) => entry.executed),
    toolsUsed: [...new Set(executed.map((entry) => entry.executed.toolCall.name))]
  };
}

async function generatePlan(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  userPrompt: string,
  toolDescriptions: string,
  userId: string | undefined
): Promise<readonly PlanStep[] | null> {
  // Agentic Plan Caching (arXiv 2506.14852): inject a similar past plan as a
  // few-shot exemplar so the small local model plans better in one shot.
  // Fail-open — a cache miss/error just means no exemplar.
  let priorPlanExemplar: string | undefined;
  if (runner.planCacheProvider && userId) {
    try {
      const similar = await runner.planCacheProvider.findSimilarPlan(userId, userPrompt);
      if (similar) {
        priorPlanExemplar = renderPlanExemplar(similar);
      }
    } catch {
      priorPlanExemplar = undefined;
    }
  }
  const planningPrompt = buildPlanningSystemPrompt({
    toolDescriptions,
    userPrompt,
    ...(priorPlanExemplar ? { priorPlanExemplar } : {})
  });

  const planRequest: ModelRequest = {
    ...request,
    messages: [
      { content: planningPrompt, role: "system" },
      { content: userPrompt, role: "user" }
    ],
    // Constrain the plan to the schema where the provider supports it (Ollama);
    // parsePlan/extractJsonArray below stays the fallback for others.
    responseFormat: PLAN_RESPONSE_SCHEMA as unknown as JsonObject,
    tools: []
  };

  const response = await runner.generateWithTracing(context, provider, planRequest);
  return parsePlan(response.output ?? "");
}

async function synthesizePlanResults(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  userPrompt: string,
  executed: readonly PlanExecuteStepRecord[]
): Promise<ModelResponse> {
  const summary = renderPlanResultSummary(executed.map((entry) => entry.stepResult));
  const synthesisPrompt = [
    `사용자 요청: ${userPrompt}`,
    "",
    "수집된 정보:",
    summary,
    "",
    "위 정보를 바탕으로 사용자 요청에 답하세요."
  ].join("\n");

  const baseSystem = systemMessageContent(request.messages);
  const synthesisRequest: ModelRequest = {
    ...request,
    messages: [
      ...(baseSystem ? [{ content: baseSystem, role: "system" as const }] : []),
      { content: synthesisPrompt, role: "user" as const }
    ],
    tools: []
  };

  const response = await runner.generateWithTracing(context, provider, synthesisRequest);
  if (!response.output || response.output.trim().length === 0) {
    throw new PlanExecutionError(
      "RESPONSE_SYNTHESIS_FAILED",
      "Plan synthesis LLM returned an empty response"
    );
  }

  return response;
}

async function directAnswerForPlanExecute(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest
): Promise<ModelResponse> {
  const directRequest: ModelRequest = {
    ...request,
    tools: []
  };
  const response = await runner.generateWithTracing(context, provider, directRequest);
  if (!response.output || response.output.trim().length === 0) {
    throw new PlanExecutionError(
      "RESPONSE_SYNTHESIS_FAILED",
      "Plan direct-answer fallback returned an empty response"
    );
  }
  return response;
}
