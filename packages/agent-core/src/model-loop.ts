/**
 * Model invocation loop extracted from packages/agent-core/src/index.ts.
 *
 * Owns the three react-style model-tool-model orchestration entry points:
 *   - executeModelLoop: blocking variant used by AgentRuntime.run.
 *   - executeStreamingModelLoop: streaming variant used by
 *     AgentRuntime.stream — yields text/tool-call/tool-result events.
 *   - streamModelTurn: a single provider-stream pump that buffers
 *     text deltas, captures tool calls, and records token-usage span
 *     attributes when the provider emits a usage event.
 *
 * All three are free functions taking a `ModelLoopRunner` facade so the
 * AgentRuntime keeps ownership of the constructor-bound dependencies
 * (tracer / metrics / tokenUsageSink / maxToolCalls / inner helpers)
 * while the loop control flow lives in its own module.
 */

import type {
  ModelEvent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelToolCall
} from "@muse/model";
import type { AgentMetrics, MuseTracer, TokenUsageSink } from "@muse/observability";
import { renderToolResults } from "@muse/prompts";

import { recordTokenUsageEvent } from "./model-invocation.js";
import { appendSystemSection, recordUsageSpanAttributes } from "./runtime-helpers.js";
import {
  blockedToolResult,
  type ExecutedToolResult,
  type ModelLoopExecution,
  type StreamExecutionOptions,
  type StreamedModelTurn
} from "./runtime-internals.js";
import { ToolCallDeduplicator } from "./tool-call-deduplicator.js";
import type { AgentRunContext } from "./types.js";

export interface ModelLoopRunner {
  readonly maxToolCalls: number;
  readonly tracer: MuseTracer;
  readonly metrics: AgentMetrics;
  readonly tokenUsageSink?: TokenUsageSink;
  generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse>;
  executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: NonNullable<ModelRequest["tools"]>
  ): Promise<ExecutedToolResult>;
}

export type ModelLoopStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result" }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);

export async function executeModelLoop(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest
): Promise<ModelLoopExecution> {
  const intermediateMessages: ModelMessage[] = [];
  const toolResults: ExecutedToolResult[] = [];
  const toolsUsed: string[] = [];
  let messages: readonly ModelMessage[] = [...request.messages];
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();

  while (true) {
    const activeTools = toolCallCount < runner.maxToolCalls ? request.tools : [];
    const response = await runner.generateWithTracing(context, provider, {
      ...request,
      messages,
      tools: activeTools
    });
    const calls = response.toolCalls ?? [];

    if (calls.length === 0 || (activeTools?.length ?? 0) === 0) {
      return {
        finalResponse: response,
        intermediateMessages,
        toolResults,
        toolsUsed: [...new Set(toolsUsed)]
      };
    }

    const assistantMessage: ModelMessage = {
      content: response.output,
      role: "assistant",
      toolCalls: calls
    };
    const toolMessages: ModelMessage[] = [];

    intermediateMessages.push(assistantMessage);
    messages = [...messages, assistantMessage];

    for (const toolCall of calls) {
      const remaining = runner.maxToolCalls - toolCallCount;
      const duplicate = remaining > 0 ? deduplicator.check(toolCall) : undefined;
      const executed = duplicate?.duplicate
        ? { result: duplicate.result, toolCall }
        : remaining > 0
          ? await runner.executeToolCall(context, toolCall, activeTools ?? [])
          : blockedToolResult(toolCall, "Error: max tool call limit reached");

      toolCallCount += remaining > 0 ? 1 : 0;
      deduplicator.record(toolCall, executed.result);
      toolsUsed.push(toolCall.name);
      toolResults.push(executed);
      toolMessages.push({
        content: executed.result.output,
        name: toolCall.name,
        role: "tool",
        toolCallId: toolCall.id
      });
    }

    const toolSummary = renderToolResults(
      toolResults.map((item) => `${item.result.name}: ${item.result.output}`).join("\n\n")
    );
    const nextMessages = [...messages, ...toolMessages];
    messages = toolSummary
      ? appendSystemSection(nextMessages, toolSummary, "tool-results")
      : nextMessages;
    intermediateMessages.push(...toolMessages);
  }
}

export async function* executeStreamingModelLoop(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  options: StreamExecutionOptions
): AsyncGenerator<ModelLoopStreamEvent, ModelLoopExecution, void> {
  const intermediateMessages: ModelMessage[] = [];
  const toolResults: ExecutedToolResult[] = [];
  const toolsUsed: string[] = [];
  let messages: readonly ModelMessage[] = [...request.messages];
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();

  while (true) {
    const activeTools = toolCallCount < runner.maxToolCalls ? request.tools : [];
    const turnStream = streamModelTurn(runner, context, provider, {
      ...request,
      messages,
      tools: activeTools
    }, options);
    let next = await turnStream.next();

    while (!next.done) {
      yield next.value;
      next = await turnStream.next();
    }

    const response = next.value.response;
    const calls = response.toolCalls ?? [];

    if (calls.length === 0 || (activeTools?.length ?? 0) === 0) {
      return {
        finalResponse: response,
        intermediateMessages,
        toolResults,
        toolsUsed: [...new Set(toolsUsed)]
      };
    }

    const assistantMessage: ModelMessage = {
      content: response.output,
      role: "assistant",
      toolCalls: calls
    };
    const toolMessages: ModelMessage[] = [];

    intermediateMessages.push(assistantMessage);
    messages = [...messages, assistantMessage];

    for (const toolCall of calls) {
      const remaining = runner.maxToolCalls - toolCallCount;
      const duplicate = remaining > 0 ? deduplicator.check(toolCall) : undefined;
      const executed = duplicate?.duplicate
        ? { result: duplicate.result, toolCall }
        : remaining > 0
          ? await runner.executeToolCall(context, toolCall, activeTools ?? [])
          : blockedToolResult(toolCall, "Error: max tool call limit reached");

      yield { runId: context.runId, toolCall, type: "tool-result" };
      toolCallCount += remaining > 0 ? 1 : 0;
      deduplicator.record(toolCall, executed.result);
      toolsUsed.push(toolCall.name);
      toolResults.push(executed);
      toolMessages.push({
        content: executed.result.output,
        name: toolCall.name,
        role: "tool",
        toolCallId: toolCall.id
      });
    }

    const toolSummary = renderToolResults(
      toolResults.map((item) => `${item.result.name}: ${item.result.output}`).join("\n\n")
    );
    const nextMessages = [...messages, ...toolMessages];
    messages = toolSummary
      ? appendSystemSection(nextMessages, toolSummary, "tool-results")
      : nextMessages;
    intermediateMessages.push(...toolMessages);
  }
}

async function* streamModelTurn(
  runner: ModelLoopRunner,
  context: AgentRunContext,
  provider: ModelProvider,
  request: ModelRequest,
  options: StreamExecutionOptions
): AsyncGenerator<ModelLoopStreamEvent, StreamedModelTurn, void> {
  const span = runner.tracer.startSpan("muse.model.stream", {
    "model.id": request.model,
    "provider.id": provider.id,
    "run.id": context.runId
  });
  const toolCalls = new Map<string, ModelToolCall>();
  let streamedOutput = "";
  let response: ModelResponse | undefined;

  try {
    for await (const event of provider.stream(request)) {
      if (event.type === "text-delta") {
        streamedOutput += event.text;
        if (options.forwardTextDeltas) {
          yield { ...event, runId: context.runId };
        }
        continue;
      }

      if (event.type === "tool-call") {
        toolCalls.set(event.toolCall.id, event.toolCall);
        yield { ...event, runId: context.runId };
        continue;
      }

      if (event.type === "error") {
        span.setError(event.error);
        yield { ...event, runId: context.runId };
        throw event.error;
      }

      for (const toolCall of event.response.toolCalls ?? []) {
        if (!toolCalls.has(toolCall.id)) {
          toolCalls.set(toolCall.id, toolCall);
          yield { runId: context.runId, toolCall, type: "tool-call" };
        }
      }

      response = {
        ...event.response,
        output: event.response.output || streamedOutput,
        toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : event.response.toolCalls
      };
      recordUsageSpanAttributes(span, response);

      if (response.usage) {
        runner.metrics.recordTokenUsage(response.usage, context.input.metadata);
        await recordTokenUsageEvent({
          provider,
          response,
          runId: context.runId,
          stepType: "act",
          ...(runner.tokenUsageSink ? { tokenUsageSink: runner.tokenUsageSink } : {}),
          tracer: runner.tracer
        });
      }
    }

    return {
      response: response ?? {
        id: `${context.runId}:stream`,
        model: request.model,
        output: streamedOutput,
        toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : undefined
      }
    };
  } catch (error) {
    span.setError(error);
    throw error;
  } finally {
    span.end();
  }
}
