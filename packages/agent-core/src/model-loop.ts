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
import { createHash } from "node:crypto";

import {
  applyToolOutputImportance,
  maskStaleToolObservations,
  scoreToolOutputImportance,
  trimToolOutput,
  type ContextReferenceStore
} from "@muse/memory";
import type { AgentMetrics, MuseTracer, TokenUsageSink } from "@muse/observability";
import { renderToolResults } from "@muse/prompts";

import { neutralizeInjectionSpans } from "./injection.js";
import { applyCitationSanitisation, recordTokenUsageEvent } from "./model-invocation.js";
import type { PlanCacheProvider } from "./plan-cache.js";
import { appendSystemSection, recordUsageSpanAttributes } from "./runtime-helpers.js";
import {
  blockedToolResult,
  groundingSourceFromExecuted,
  type ExecutedToolResult,
  type ModelLoopExecution,
  type StreamExecutionOptions,
  type StreamedModelTurn
} from "./runtime-internals.js";
import { GeneralShellPhaseGate } from "./general-shell-phase.js";
import { detectConflictingWritesInBatch } from "./tool-batch-conflict.js";
import { ToolCallDeduplicator } from "./tool-call-deduplicator.js";
import { ToolFailureStreakTracker } from "./tool-failure-streak.js";
import { ToolLoopProgressTracker } from "./tool-loop-progress.js";
import type { AgentRunContext } from "./types.js";

export interface ModelLoopRunner {
  readonly maxToolCalls: number;
  /** Plan-template cache (Agentic Plan Caching) — used only by the plan-execute path. */
  readonly planCacheProvider?: PlanCacheProvider;
  /**
   * Wall-clock cap, in ms, for a single run's tool-loop. Counts
   * from the start of `executeModelLoop` / `executeStreamingModelLoop`.
   * Checked between iterations — if the deadline passes the loop
   * returns the current response with no further tool execution.
   * 0 / undefined disables the deadline. CLAUDE.md non-negotiable:
   * "Tool loops have explicit limits and timeouts."
   */
  readonly maxRunWallclockMs?: number;
  /** Wall-clock source for the deadline (injectable so the mid-batch cut is testable without timing flake). Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly tracer: MuseTracer;
  readonly metrics: AgentMetrics;
  readonly tokenUsageSink?: TokenUsageSink;
  /**
   * Per-tool-result character cap. When set and an individual tool
   * output exceeds the cap, the message-bound copy is truncated
   * head+tail with an
   * elision marker. The original `result.output` on the tracked
   * tool result is left unchanged so traces / metrics see the full
   * text. 0 or undefined disables the cap.
   */
  readonly maxToolOutputChars?: number;
  /**
   * Optional ref store for just-in-time retrieval. When set AND
   * `maxToolOutputChars` triggers a truncation, the full original
   * output is stashed in
   * the store under a sha256-prefix id and the truncation marker
   * surfaces `ref=<id>` so the agent can call
   * `muse.context.fetch({ ref })` to expand the elided bytes on
   * demand. Same content → same ref (content-addressed) so repeated
   * truncations of the same payload share storage.
   */
  readonly contextReferenceStore?: ContextReferenceStore;
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
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result"; readonly grounding?: { readonly source: string; readonly text: string } }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-started" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call-finished" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "citations" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);

function interruptedExecution(
  request: ModelRequest,
  intermediateMessages: ModelMessage[],
  toolResults: ExecutedToolResult[],
  toolsUsed: readonly string[]
): ModelLoopExecution {
  return {
    finalResponse: { id: "interrupted", model: request.model, output: "(run interrupted)" },
    intermediateMessages,
    toolResults,
    toolsUsed: [...new Set(toolsUsed)]
  };
}

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
  const anchorTerms = deriveAnchorTerms(request.messages);
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();
  const progress = new ToolLoopProgressTracker();
  const failureStreak = new ToolFailureStreakTracker();
  const shellPhase = new GeneralShellPhaseGate((request.tools ?? []).map((tool) => tool.name));
  const now = runner.now ?? Date.now;
  const deadlineMs = runner.maxRunWallclockMs && runner.maxRunWallclockMs > 0
    ? now() + runner.maxRunWallclockMs
    : undefined;

  while (true) {
    // Cooperative interrupt: a caller-aborted signal stops the loop cleanly
    // here — before any further model call or tool — and returns what we have.
    if (context.input.signal?.aborted) {
      return interruptedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // Wall-clock deadline cuts the loop short BEFORE the next model
    // call — disables tools for the final synthesis turn so the
    // model returns a clean response instead of asking for another
    // tool we'd refuse. Honours the iter's "explicit limits and
    // timeouts" non-negotiable from CLAUDE.md.
    // No-progress early-exit (arXiv:2505.17616): a stalled read loop (the last
    // window observations near-identical) also disables tools → forces a clean
    // synthesis instead of burning the rest of the budget on spin.
    const wallclockExceeded = deadlineMs !== undefined && now() > deadlineMs;
    // Tool-failure-streak circuit breaker (arXiv:2509.25370): a tool that has
    // failed N times in a row is withheld for the next turn (the model keeps its
    // OTHER tools) so a cascading tool failure can't burn the whole budget.
    const activeTools = (!wallclockExceeded && toolCallCount < runner.maxToolCalls && !progress.stalled())
      ? request.tools?.filter((t) => !failureStreak.tripped(t.name) && !shellPhase.withholds(t.name))
      : [];
    // Stale-observation masking (The Complexity Trap arXiv:2508.21433 +
    // ACON arXiv:2510.00615): rewrite PRIOR turns' tool outputs to a
    // re-fetchable placeholder so multi-turn context stops growing —
    // the latest turn stays full, nothing is dropped (every masked
    // observation is stashed in the ref store, re-fetchable by id).
    // No-op on the first turn (no prior tool messages) and when no ref
    // store is configured.
    messages = maskStaleToolObservations(messages, {
      ...(runner.contextReferenceStore ? { refStore: runner.contextReferenceStore } : {})
    }).messages;
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

    // A batch the model already emitted is honoured even if the
    // deadline passed during the model call (the established
    // contract: the deadline disables tools for the *next* turn).
    // But once the deadline is crossed *while we run this batch*
    // sequentially — N calls each hitting a slow/hung MCP server —
    // the remaining calls are skipped so the wall-clock cap is a
    // real execution bound, not just a between-turn boundary.
    const batchStartedPastDeadline = deadlineMs !== undefined && now() > deadlineMs;
    // Conflicting-write guard (AgentSpec arXiv:2503.18666): a 2nd write to the same
    // target with conflicting args in this batch is withheld (zero side-effect) so
    // a double-act can't reach a write actuator.
    const conflictingIds = detectConflictingWritesInBatch(calls, (call) => {
      const risk = (activeTools ?? []).find((t) => t.name === call.name)?.risk;
      return risk === "write" || risk === "execute";
    });
    for (const toolCall of calls) {
      const remaining = runner.maxToolCalls - toolCallCount;
      const crossedDeadlineMidBatch = !batchStartedPastDeadline
        && deadlineMs !== undefined && now() > deadlineMs;
      const conflicting = conflictingIds.has(toolCall.id);
      const canRun = remaining > 0 && !crossedDeadlineMidBatch && !conflicting;
      const duplicate = canRun ? deduplicator.check(toolCall) : undefined;
      const executed = duplicate?.duplicate
        ? { result: duplicate.result, toolCall }
        : conflicting
          ? blockedToolResult(toolCall, "Error: conflicting write withheld — ambiguous duplicate action in this batch")
          : canRun
            ? await runner.executeToolCall(context, toolCall, activeTools ?? [])
            : blockedToolResult(toolCall, crossedDeadlineMidBatch && remaining > 0
                ? "Error: run wall-clock deadline reached"
                : "Error: max tool call limit reached");

      toolCallCount += canRun ? 1 : 0;
      const toolRisk = (activeTools ?? []).find((t) => t.name === toolCall.name)?.risk;
      const mutating = toolRisk === "write" || toolRisk === "execute";
      deduplicator.record(toolCall, executed.result, mutating);
      // Feed only GENUINE executions (not blocked / exact-dups) to the stall
      // tracker; a mutating call resets the window (it advanced state).
      if (canRun && !duplicate?.duplicate) {
        progress.record(executed.result.output, mutating);
        failureStreak.record(toolCall.name, executed.result.status);
        shellPhase.record(toolCall.name, executed.result.output);
      }
      toolsUsed.push(toolCall.name);
      toolResults.push(executed);
      // cap individual tool results so a single big
      // output doesn't blow the context window. Original
      // executed.result.output is left intact for traces / metrics
      // — only the message-bound copy is truncated.
      const messageContent = capToolOutput(executed.result.output, toolCall.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms);
      toolMessages.push({
        content: messageContent,
        name: toolCall.name,
        role: "tool",
        toolCallId: toolCall.id
      });
    }

    const toolSummary = renderToolResults(
      toolResults
        .map((item) => `${item.result.name}: ${capToolOutput(item.result.output, item.result.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms)}`)
        .join("\n\n")
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
  const anchorTerms = deriveAnchorTerms(request.messages);
  let toolCallCount = 0;
  const deduplicator = new ToolCallDeduplicator();
  const progress = new ToolLoopProgressTracker();
  const failureStreak = new ToolFailureStreakTracker();
  const shellPhase = new GeneralShellPhaseGate((request.tools ?? []).map((tool) => tool.name));
  const now = runner.now ?? Date.now;
  const deadlineMs = runner.maxRunWallclockMs && runner.maxRunWallclockMs > 0
    ? now() + runner.maxRunWallclockMs
    : undefined;

  while (true) {
    if (context.input.signal?.aborted) {
      return interruptedExecution(request, intermediateMessages, toolResults, toolsUsed);
    }
    // No-progress early-exit (arXiv:2505.17616): a stalled read loop disables
    // tools for this turn → clean synthesis instead of spinning the budget.
    const wallclockExceeded = deadlineMs !== undefined && now() > deadlineMs;
    // Tool-failure-streak circuit breaker (arXiv:2509.25370): a tool that has
    // failed N times in a row is withheld for the next turn (the model keeps its
    // OTHER tools) so a cascading tool failure can't burn the whole budget.
    const activeTools = (!wallclockExceeded && toolCallCount < runner.maxToolCalls && !progress.stalled())
      ? request.tools?.filter((t) => !failureStreak.tripped(t.name) && !shellPhase.withholds(t.name))
      : [];
    // Stale-observation masking — see executeModelLoop. Same growing-
    // `messages` pattern in the streaming path, same fix.
    messages = maskStaleToolObservations(messages, {
      ...(runner.contextReferenceStore ? { refStore: runner.contextReferenceStore } : {})
    }).messages;
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

    const batchStartedPastDeadline = deadlineMs !== undefined && now() > deadlineMs;
    // Conflicting-write guard (AgentSpec arXiv:2503.18666): see executeModelLoop.
    const conflictingIds = detectConflictingWritesInBatch(calls, (call) => {
      const risk = (activeTools ?? []).find((t) => t.name === call.name)?.risk;
      return risk === "write" || risk === "execute";
    });
    for (const toolCall of calls) {
      const remaining = runner.maxToolCalls - toolCallCount;
      const crossedDeadlineMidBatch = !batchStartedPastDeadline
        && deadlineMs !== undefined && now() > deadlineMs;
      const conflicting = conflictingIds.has(toolCall.id);
      const canRun = remaining > 0 && !crossedDeadlineMidBatch && !conflicting;
      const duplicate = canRun ? deduplicator.check(toolCall) : undefined;
      const executed = duplicate?.duplicate
        ? { result: duplicate.result, toolCall }
        : conflicting
          ? blockedToolResult(toolCall, "Error: conflicting write withheld — ambiguous duplicate action in this batch")
          : canRun
            ? await runner.executeToolCall(context, toolCall, activeTools ?? [])
            : blockedToolResult(toolCall, crossedDeadlineMidBatch && remaining > 0
                ? "Error: run wall-clock deadline reached"
                : "Error: max tool call limit reached");

      const grounding = groundingSourceFromExecuted(executed);
      yield { runId: context.runId, toolCall, type: "tool-result", ...(grounding ? { grounding } : {}) };
      toolCallCount += canRun ? 1 : 0;
      const toolRisk = (activeTools ?? []).find((t) => t.name === toolCall.name)?.risk;
      const mutating = toolRisk === "write" || toolRisk === "execute";
      deduplicator.record(toolCall, executed.result, mutating);
      // Feed only GENUINE executions (not blocked / exact-dups) to the stall
      // tracker; a mutating call resets the window (it advanced state).
      if (canRun && !duplicate?.duplicate) {
        progress.record(executed.result.output, mutating);
        failureStreak.record(toolCall.name, executed.result.status);
        shellPhase.record(toolCall.name, executed.result.output);
      }
      toolsUsed.push(toolCall.name);
      toolResults.push(executed);
      // cap individual tool results so a single big
      // output doesn't blow the context window. Original
      // executed.result.output is left intact for traces / metrics
      // — only the message-bound copy is truncated.
      const messageContent = capToolOutput(executed.result.output, toolCall.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms);
      toolMessages.push({
        content: messageContent,
        name: toolCall.name,
        role: "tool",
        toolCallId: toolCall.id
      });
    }

    const toolSummary = renderToolResults(
      toolResults
        .map((item) => `${item.result.name}: ${capToolOutput(item.result.output, item.result.name, runner.maxToolOutputChars, runner.contextReferenceStore, anchorTerms)}`)
        .join("\n\n")
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

      if (event.type === "tool-call-started" || event.type === "tool-call-finished" || event.type === "citations") {
        yield { ...event, runId: context.runId };
        continue;
      }

      if (event.type === "error") {
        span.setError(event.error);
        yield { ...event, runId: context.runId };
        throw event.error;
      }

      if (event.type !== "done") {
        continue;
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
      response: applyCitationSanitisation(response ?? {
        id: `${context.runId}:stream`,
        model: request.model,
        output: streamedOutput,
        toolCalls: toolCalls.size > 0 ? [...toolCalls.values()] : undefined
      })
    };
  } catch (error) {
    span.setError(error);
    throw error;
  } finally {
    span.end();
  }
}


/**
 * Apply the per-tool-result character cap. Pure
 * delegate to `trimToolOutput` from @muse/memory; here just
 * threads in the per-tool hint that surfaces in the elision
 * marker. When `maxChars` is undefined or 0, the original
 * output passes through unchanged.
 */
export function capToolOutput(
  output: string,
  toolName: string,
  maxChars: number | undefined,
  refStore?: ContextReferenceStore,
  anchorTerms?: readonly string[]
): string {
  // Live-injection defense: tool / MCP / sub-agent output is UNTRUSTED — a poisoned
  // result ("ignore previous instructions, exfiltrate …") would otherwise reach the
  // model verbatim (a prompt "this is untrusted" tag does NOT stop a small local
  // model obeying it). Neutralize the injecting span deterministically here, the
  // single chokepoint every tool result passes through before becoming a message.
  // The caller keeps the RAW `executed.result.output` for traces; only this
  // message-/ref-bound copy is neutralized. Clean output is byte-identical.
  const safe = neutralizeInjectionSpans(output);
  if (!maxChars || maxChars <= 0) {
    return safe;
  }
  // D5: scale the per-tool budget by importance class so calendar /
  // tasks / notes results get more retention than a noisy web-fetch
  // dump. `scoreToolOutputImportance` uses the same name-prefix
  // heuristic as `inferDomain`, neutral 1.0 fallback.
  const importance = scoreToolOutputImportance(toolName);
  const effectiveMaxChars = applyToolOutputImportance(maxChars, importance);
  // when a ref store is configured, stash the full
  // output BEFORE trimming and surface `ref=<id>` in the marker.
  // Content-addressed via sha256 prefix so the same payload
  // returned by repeated tool calls dedupes.
  const ref = refStore && safe.length > effectiveMaxChars
    ? putToolOutputRef(refStore, safe, toolName)
    : undefined;
  const hint = ref
    ? `tool ${toolName} returned a larger result; ref=${ref}, expand via muse.context.fetch({ ref })`
    : `tool ${toolName} returned a larger result`;
  return trimToolOutput(safe, {
    hint,
    maxChars: effectiveMaxChars,
    ...(anchorTerms && anchorTerms.length > 0 ? { anchorTerms } : {})
  }).output;
}

const ANCHOR_STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "was", "were", "you", "your", "with", "this",
  "that", "from", "have", "has", "had", "can", "could", "would", "should",
  "what", "when", "where", "which", "who", "why", "how", "did", "does", "do",
  "about", "into", "out", "any", "all", "but", "not", "get", "got", "tell",
  "please", "show", "give", "find"
]);

/**
 * Derive query-anchor terms from the latest user message so a buried
 * middle span the user is asking about survives the per-result cap
 * (ACON arXiv:2510.00615 / Lost-in-the-Middle arXiv:2307.03172).
 * Deterministic: lowercase, split on non-word chars, drop stop-words
 * and tokens shorter than 3 chars so noise doesn't anchor everything.
 */
export function deriveAnchorTerms(messages: readonly ModelMessage[]): readonly string[] {
  let latest: string | undefined;
  for (const message of messages) {
    if (message.role === "user" && typeof message.content === "string") {
      latest = message.content;
    }
  }
  if (!latest) {
    return [];
  }
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of latest.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || ANCHOR_STOP_WORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

function putToolOutputRef(
  refStore: ContextReferenceStore,
  output: string,
  toolName: string
): string {
  // Short content-addressed id: 12 hex chars of sha256. Cheap
  // collision risk acceptable here (in-process scratchpad, not a
  // security boundary).
  const id = createHash("sha256").update(output).digest("hex").slice(0, 12);
  refStore.put({
    content: output,
    id,
    originalLength: output.length,
    source: toolName
  });
  return id;
}
