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
  classifyStepEffect,
  dedupeExactSteps,
  PlanExecutionError,
  PlanValidationFailedError,
  parsePlan,
  PLAN_RESPONSE_SCHEMA,
  renderPlanResultSummary,
  renderToolDescriptionsForPlanning,
  systemMessageContent,
  validatePlan,
  type PlanStep,
  type StepEffectVerdict,
  type StepExecutionResult
} from "./plan-execute.js";

/**
 * Bounded per-step attempts for a failed READ (idempotent) step — 2 = one
 * recovery retry. Keeps a flaky lookup from killing a whole multi-step plan
 * while staying well under the run's `maxToolCalls` budget; write/execute steps
 * are pinned to a single attempt (no double-act).
 */
const PLAN_STEP_MAX_ATTEMPTS = 2;
import { renderPlanExemplar, selectSuccessfulPlanSteps, type PlanCacheProvider } from "./plan-cache.js";
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

  // ISR-LLM (arXiv:2308.13724): deterministic dedup first (no model call),
  // then validate before any tool executes. A bad plan never reaches execution.
  const PLAN_REPAIR_MAX_ROUNDS = 1;
  let steps = dedupeExactSteps(plan);

  yield { plan: steps, runId: context.runId, type: "plan-generated" };

  if (steps.length === 0) {
    yield { runId: context.runId, type: "synthesis-started" };
    const directResponse = await directAnswerForPlanExecute(runner, context, provider, request);
    return {
      finalResponse: directResponse,
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: []
    };
  }

  const toolSchemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema as import("@muse/shared").JsonValue]));
  const availableToolNames = new Set(tools.map((tool) => tool.name));

  let validation = validatePlan({ availableToolNames, steps, toolSchemas });
  if (!validation.valid && PLAN_REPAIR_MAX_ROUNDS > 0) {
    const errorBullets = validation.errors
      .map((error) => `- step ${(error.stepIndex + 1).toString()} (${error.tool || "?"}): ${error.reason}`)
      .join("\n");
    const repairPrompt = [
      `The original request was: ${userPrompt}`,
      "",
      "The plan you produced has the following errors:",
      errorBullets,
      "",
      "Produce a corrected plan that fixes all errors listed above."
    ].join("\n");
    const repairedRaw = await generatePlan(runner, context, provider, request, repairPrompt, toolDescriptions, userId);
    if (repairedRaw !== null) {
      steps = dedupeExactSteps(repairedRaw);
      validation = validatePlan({ availableToolNames, steps, toolSchemas });
    }
  }
  if (!validation.valid) {
    throw new PlanValidationFailedError(validation.errors, steps);
  }

  const executed: PlanExecuteStepRecord[] = [];
  let toolCallCount = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
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
    // Recovery (carry-to-done): a FAILED step is retried — but ONLY when its tool
    // is read-risk (idempotent). A non-idempotent write/execute step is NEVER
    // plan-retried: a retried send / booking / actuator call could double-act
    // (outbound-safety), and its transient case is already handled 429-only-safe
    // at the HTTP layer. A step is a real success only if the tool COMPLETED
    // (didn't throw) AND its post-condition holds (`classifyStepEffect`) —
    // otherwise a non-throwing failure (an MCP `isError` rendered "Error: …" with
    // status "completed", a `{ ok:false }` envelope) is silently counted as done.
    const retryable = tools.find((tool) => tool.name === step.tool)?.risk === "read";
    const maxAttempts = retryable ? PLAN_STEP_MAX_ATTEMPTS : 1;
    let toolResult: ExecutedToolResult;
    let completed: boolean;
    let effect: StepEffectVerdict;
    let success: boolean;
    let attempts = 0;
    do {
      toolResult = await runner.executeToolCall(context, synthesizedCall, tools);
      toolCallCount += 1;
      attempts += 1;
      completed = toolResult.result.status === "completed";
      effect = completed ? classifyStepEffect(toolResult.result.output) : { effectFailed: false };
      success = completed && !effect.effectFailed;
    } while (!success && attempts < maxAttempts && toolCallCount < runner.maxToolCalls);
    // ADAPTIVE RE-DECOMPOSITION (carry-to-done): a READ step that still failed
    // after the bounded retry gets ONE alternative read-only sub-plan to reach
    // the same intent a different way. Only a read-step failure triggers this
    // (`retryable`) — a write failure is never replanned (it may have committed →
    // double-act); the re-plan is filtered to read-risk tools, so recovery can't
    // act on the world. Skipped on the happy path (a succeeding step never
    // replans → no latency added to the common case).
    if (!success && retryable && toolCallCount < runner.maxToolCalls) {
      const recovered = await replanFailedReadStep(runner, context, provider, request, userPrompt, step, effect.reason ?? "STEP_EFFECT_FAILED", tools, toolCallCount);
      if (recovered) {
        toolCallCount = recovered.toolCallCount;
        executed.push({ executed: recovered.executed, step, stepResult: recovered.stepResult });
        yield { runId: context.runId, stepIndex: index, success: true, type: "plan-step-result" };
        continue;
      }
    }
    executed.push({
      executed: toolResult,
      step,
      stepResult: {
        description: step.description,
        error: success ? undefined : (completed ? effect.reason ?? "STEP_EFFECT_FAILED" : toolResult.result.error ?? "TOOL_ERROR"),
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
  // AWM (arXiv:2409.07429): outcome-conditioned — cache only the steps that
  // actually succeeded so later retrievals don't teach failed tool sequences.
  // Fail-open — a cache write must never break the run.
  if (runner.planCacheProvider && userId) {
    const successfulSteps = selectSuccessfulPlanSteps(executed);
    if (successfulSteps.length > 0) {
      try {
        await runner.planCacheProvider.recordPlan(userId, userPrompt, successfulSteps);
      } catch {
        // ignore — caching is best-effort
      }
    }
  }

  return {
    finalResponse,
    intermediateMessages: planExecuteIntermediateMessages(steps, executed),
    toolResults: executed.map((entry) => entry.executed),
    toolsUsed: [...new Set(executed.map((entry) => entry.executed.toolCall.name))]
  };
}

/** A re-plan explores at most this many alternative steps for a failed read. */
const PLAN_REPLAN_MAX_STEPS = 2;

/**
 * Adaptive re-decomposition (carry-to-done): when a READ step's effect fails even
 * after the bounded retry, generate an ALTERNATIVE plan to obtain the same
 * information a different way, and run it. SAFETY (the whole reason this is
 * read-only): the caller triggers this ONLY for a read-risk step (a write may
 * have committed → it is NEVER replanned, no double-act), AND the alternative
 * plan is FILTERED to read-risk tools here — any write/execute step the model
 * proposes in the re-plan is DROPPED, so recovery can never act on the world.
 * Bounded to `PLAN_REPLAN_MAX_STEPS` alternative steps and the run's
 * `maxToolCalls`. Returns the recovered result (the step's intent achieved via
 * the alternative) or undefined when no read alternative succeeded.
 */
async function replanFailedReadStep(
  runner: PlanExecuteRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  userPrompt: string,
  failedStep: PlanStep,
  reason: string,
  tools: readonly ModelTool[],
  toolCallCount: number
): Promise<{ readonly executed: ExecutedToolResult; readonly stepResult: StepExecutionResult; readonly toolCallCount: number } | undefined> {
  const readTools = tools.filter((tool) => tool.risk === "read");
  if (readTools.length === 0 || toolCallCount >= runner.maxToolCalls) {
    return undefined;
  }
  const replanPrompt = [
    `The original request was: ${userPrompt}`,
    `A planned step failed and could not be retried: "${failedStep.description}" (tool ${failedStep.tool}) — ${reason}.`,
    "Produce a SHORT alternative plan (1-2 steps) that obtains the SAME information a DIFFERENT way, using ONLY the available tools. Do not repeat the failed call verbatim."
  ].join("\n");
  let altPlan: readonly PlanStep[] | null;
  try {
    altPlan = await generatePlan(runner, context, provider, request, replanPrompt, renderToolDescriptionsForPlanning(readTools), undefined);
  } catch {
    return undefined;
  }
  if (!altPlan || altPlan.length === 0) {
    return undefined;
  }
  const readToolNames = new Set(readTools.map((tool) => tool.name));
  let count = toolCallCount;
  for (const altStep of altPlan.slice(0, PLAN_REPLAN_MAX_STEPS)) {
    if (count >= runner.maxToolCalls) {
      break;
    }
    if (!readToolNames.has(altStep.tool)) {
      continue; // SAFETY: drop any non-read step the re-plan proposed — recovery is read-only.
    }
    const call: ModelToolCall = { arguments: altStep.args, id: `plan-replan-${count.toString()}`, name: altStep.tool };
    const toolResult = await runner.executeToolCall(context, call, tools);
    count += 1;
    const completed = toolResult.result.status === "completed";
    const effect = completed ? classifyStepEffect(toolResult.result.output) : { effectFailed: false };
    if (completed && !effect.effectFailed) {
      return {
        executed: toolResult,
        stepResult: {
          description: `${failedStep.description} (recovered via ${altStep.tool})`,
          output: toolResult.result.output,
          success: true,
          tool: altStep.tool
        },
        toolCallCount: count
      };
    }
  }
  return undefined;
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
