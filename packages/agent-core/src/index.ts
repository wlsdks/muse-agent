import type { AgentSpecResolution } from "@muse/agent-specs";
import {
  buildCacheKey,
  cacheableModelRequest,
  cachedResponseFromModelResponse,
  type CacheMetricsRecorder,
  type ResponseCache
} from "@muse/cache";
import {
  ModelProviderRegistry,
  parseModelName,
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  type ModelToolCall
} from "@muse/model";
import {
  createNoOpAgentMetrics,
  createNoOpMuseTracer,
  type AgentMetrics,
  type MuseTracer,
  type SpanHandle
} from "@muse/observability";
import { renderRetrievedContext, renderToolResults } from "@muse/prompts";
import type { RagPipeline } from "@muse/rag";
import {
  retry,
  withTimeout,
  type CircuitBreaker,
  type FallbackStrategy,
  type RetryOptions
} from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  AgentRunMode,
  HookLifecycle,
  HookTraceStore,
  PendingApprovalStore
} from "@muse/runtime-state";
import { trimConversationMessages, type ConversationTrimOptions } from "@muse/memory";
import {
  detectSystemPromptLeakage,
  findInjectionPatterns,
  maskPii,
  normalizeStructuredOutput,
  sanitizeSourceBlocks,
  type StructuredOutputFormat,
  type ToolApprovalPolicy
} from "@muse/policy";
import { createRunId, type JsonObject } from "@muse/shared";
import { ToolExecutor, ToolRegistry, type ToolExecutionResult } from "@muse/tools";

type Awaitable<T> = T | Promise<T>;

export interface AgentRunInput {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly runId?: string;
  readonly metadata?: JsonObject;
}

export interface AgentRunContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly startedAt: Date;
  readonly agentSpec?: AgentSpecResolution;
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly code?: string };

export interface GuardStage {
  readonly id: string;
  evaluate(context: AgentRunContext): Awaitable<GuardDecision>;
}

export interface HookStage {
  readonly id: string;
  beforeStart?(context: AgentRunContext): Awaitable<void>;
  afterComplete?(context: AgentRunContext, response: ModelResponse): Awaitable<void>;
  onError?(context: AgentRunContext, error: unknown): Awaitable<void>;
}

export type OutputGuardDecision =
  | { readonly action: "allow" }
  | { readonly action: "modify"; readonly content: string; readonly reason: string }
  | { readonly action: "reject"; readonly reason: string; readonly code?: string };

export interface OutputGuardContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
}

export interface OutputGuardStage {
  readonly id: string;
  check(content: string, context: OutputGuardContext): Awaitable<OutputGuardDecision>;
}

export interface ResponseFilterContext {
  readonly runId: string;
  readonly input: AgentRunInput;
  readonly response: ModelResponse;
  readonly toolsUsed?: readonly string[];
}

export interface ResponseFilterStage {
  readonly id: string;
  apply(response: ModelResponse, context: ResponseFilterContext): Awaitable<ModelResponse>;
}

export interface AgentSpecResolver {
  resolve(text: string): Awaitable<AgentSpecResolution | undefined>;
}

export interface AgentRuntimeOptions {
  readonly modelProvider?: ModelProvider;
  readonly modelRegistry?: ModelProviderRegistry;
  readonly agentSpecResolver?: AgentSpecResolver;
  readonly historyStore?: AgentRunHistoryStore;
  readonly hookRegistry?: HookRegistry;
  readonly hookTraceStore?: HookTraceStore;
  readonly responseCache?: ResponseCache;
  readonly cacheMetrics?: CacheMetricsRecorder;
  readonly ragPipeline?: RagPipeline;
  readonly toolRegistry?: ToolRegistry;
  readonly toolExecutor?: ToolExecutor;
  readonly toolApprovalPolicy?: ToolApprovalPolicy;
  readonly toolApprovalStore?: PendingApprovalStore;
  readonly maxToolCalls?: number;
  readonly circuitBreaker?: CircuitBreaker;
  readonly fallbackStrategy?: FallbackStrategy;
  readonly retry?: RetryOptions;
  readonly requestTimeoutMs?: number;
  readonly contextWindow?: ConversationTrimOptions;
  readonly metrics?: AgentMetrics;
  readonly tracer?: MuseTracer;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly outputGuards?: readonly OutputGuardStage[];
  readonly responseFilters?: readonly ResponseFilterStage[];
  readonly defaults?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
}

export interface AgentRunResult {
  readonly runId: string;
  readonly response: ModelResponse;
  readonly agentSpec?: AgentSpecRunReport;
  readonly contextWindow?: AgentContextWindowReport;
  readonly fromCache?: boolean;
  readonly toolsUsed?: readonly string[];
}

export type AgentRuntimeStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result" }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "done" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);

export interface AgentSpecRunReport {
  readonly name: string;
  readonly confidence: number;
  readonly matchedKeywords: readonly string[];
  readonly toolNames: readonly string[];
}

export interface AgentContextWindowReport {
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
}

export class GuardBlockedError extends Error {
  readonly guardId: string;
  readonly code?: string;

  constructor(guardId: string, reason: string, code?: string) {
    super(reason);
    this.name = "GuardBlockedError";
    this.guardId = guardId;
    this.code = code;
  }
}

export class OutputGuardBlockedError extends Error {
  readonly stageId: string;
  readonly code?: string;

  constructor(stageId: string, reason: string, code?: string) {
    super(reason);
    this.name = "OutputGuardBlockedError";
    this.stageId = stageId;
    this.code = code;
  }
}

export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class HookRegistry {
  private readonly hooks = new Map<string, HookStage>();

  constructor(hooks: Iterable<HookStage> = []) {
    for (const hook of hooks) {
      this.register(hook);
    }
  }

  register(hook: HookStage): void {
    this.hooks.set(hook.id, hook);
  }

  unregister(id: string): boolean {
    return this.hooks.delete(id);
  }

  list(): readonly HookStage[] {
    return [...this.hooks.values()];
  }
}

export class AgentRuntime {
  private readonly modelProvider?: ModelProvider;
  private readonly modelRegistry?: ModelProviderRegistry;
  private readonly agentSpecResolver?: AgentSpecResolver;
  private readonly historyStore?: AgentRunHistoryStore;
  private readonly hookRegistry?: HookRegistry;
  private readonly hookTraceStore?: HookTraceStore;
  private readonly responseCache?: ResponseCache;
  private readonly cacheMetrics?: CacheMetricsRecorder;
  private readonly ragPipeline?: RagPipeline;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly maxToolCalls: number;
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly fallbackStrategy?: FallbackStrategy;
  private readonly retry?: RetryOptions;
  private readonly requestTimeoutMs?: number;
  private readonly contextWindow?: ConversationTrimOptions;
  private readonly metrics: AgentMetrics;
  private readonly tracer: MuseTracer;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly responseFilters: readonly ResponseFilterStage[];
  private readonly defaults: AgentRuntimeOptions["defaults"];

  constructor(options: AgentRuntimeOptions) {
    this.modelProvider = options.modelProvider;
    this.modelRegistry = options.modelRegistry;
    this.agentSpecResolver = options.agentSpecResolver;
    this.historyStore = options.historyStore;
    this.hookRegistry = options.hookRegistry;
    this.hookTraceStore = options.hookTraceStore;
    this.responseCache = options.responseCache;
    this.cacheMetrics = options.cacheMetrics;
    this.ragPipeline = options.ragPipeline;
    this.toolRegistry = options.toolRegistry;
    this.toolExecutor = options.toolExecutor ??
      (options.toolRegistry
        ? new ToolExecutor({
            approvalPolicy: options.toolApprovalPolicy,
            approvalStore: options.toolApprovalStore,
            registry: options.toolRegistry
          })
        : undefined);
    this.maxToolCalls = Math.max(0, options.maxToolCalls ?? 10);
    this.circuitBreaker = options.circuitBreaker;
    this.fallbackStrategy = options.fallbackStrategy;
    this.retry = options.retry;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.contextWindow = options.contextWindow;
    this.metrics = options.metrics ?? createNoOpAgentMetrics();
    this.tracer = options.tracer ?? createNoOpMuseTracer();
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.responseFilters = options.responseFilters ?? [];
    this.defaults = options.defaults;

    if (!this.modelProvider && !this.modelRegistry) {
      throw new ModelRoutingError("AgentRuntime requires either modelProvider or modelRegistry");
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const specApplied = await this.applyAgentSpec(input);
    const context: AgentRunContext = {
      agentSpec: specApplied.agentSpec,
      input: specApplied.input,
      runId: input.runId ?? createRunId(),
      startedAt: new Date()
    };
    const runSpan = this.tracer.startSpan("muse.agent.run", {
      "model.requested": input.model,
      "run.id": context.runId
    });

    try {
      await this.evaluateGuards(context);
      await this.invokeHooks("beforeStart", context);

      const selected = this.resolveProvider(context.input.model);
      runSpan.setAttribute("model.selected", selected.model);
      await this.recordRunStart(context, selected.provider.id, selected.model);

      const contextualizedInput = await this.applyRetrievedContext(context);
      const preparedRequest = this.prepareModelRequest(contextualizedInput, selected.model);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      const tools = this.modelTools();
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await this.applyResponseFilters(context, cachedResponse, cached.toolsUsed);
        const guardedCachedResponse = await this.applyOutputGuards(context, filteredCachedResponse);

        await this.recordRunComplete(context, {
          finalResponse: guardedCachedResponse,
          intermediateMessages: [],
          toolResults: [],
          toolsUsed: cached.toolsUsed
        });
        await this.invokeHooks("afterComplete", context, guardedCachedResponse);
        this.recordAgentRun(context, guardedCachedResponse.model, "completed", startedAtMs);
        return createRunResult(
          context.runId,
          guardedCachedResponse,
          preparedRequest.contextWindow,
          context.agentSpec,
          { fromCache: true, toolsUsed: cached.toolsUsed }
        );
      }

      const execution = await this.executeModelLoop(context, selected.provider, {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools
      });
      const filteredResponse = await this.applyResponseFilters(context, execution.finalResponse, execution.toolsUsed);
      const guardedResponse = await this.applyOutputGuards(context, filteredResponse);

      await this.recordRunComplete(context, { ...execution, finalResponse: guardedResponse });
      await this.writeCache(cacheKey, guardedResponse, execution.toolsUsed);
      await this.invokeHooks("afterComplete", context, guardedResponse);
      this.recordAgentRun(context, guardedResponse.model, "completed", startedAtMs);
      return createRunResult(
        context.runId,
        guardedResponse,
        preparedRequest.contextWindow,
        context.agentSpec,
        { toolsUsed: execution.toolsUsed }
      );
    } catch (error) {
      runSpan.setError(error);
      await this.recordRunFailure(context, error);
      this.recordAgentRun(context, context.input.model, "failed", startedAtMs);
      await this.invokeHooks("onError", context, error);
      throw error;
    } finally {
      runSpan.end();
    }
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentRuntimeStreamEvent> {
    const startedAtMs = Date.now();
    const specApplied = await this.applyAgentSpec(input);
    const context: AgentRunContext = {
      agentSpec: specApplied.agentSpec,
      input: specApplied.input,
      runId: input.runId ?? createRunId(),
      startedAt: new Date()
    };
    const runSpan = this.tracer.startSpan("muse.agent.stream", {
      "model.requested": input.model,
      "run.id": context.runId
    });

    try {
      await this.evaluateGuards(context);
      await this.invokeHooks("beforeStart", context);

      const selected = this.resolveProvider(context.input.model);
      runSpan.setAttribute("model.selected", selected.model);
      await this.recordRunStart(context, selected.provider.id, selected.model);

      const contextualizedInput = await this.applyRetrievedContext(context);
      const preparedRequest = this.prepareModelRequest(contextualizedInput, selected.model);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      const tools = this.modelTools();
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await this.applyResponseFilters(context, cachedResponse, cached.toolsUsed);
        const guardedCachedResponse = await this.applyOutputGuards(context, filteredCachedResponse);

        await this.recordRunComplete(context, {
          finalResponse: guardedCachedResponse,
          intermediateMessages: [],
          toolResults: [],
          toolsUsed: cached.toolsUsed
        });
        await this.invokeHooks("afterComplete", context, guardedCachedResponse);
        this.recordAgentRun(context, guardedCachedResponse.model, "completed", startedAtMs);
        yield { runId: context.runId, text: guardedCachedResponse.output, type: "text-delta" };
        yield { response: guardedCachedResponse, runId: context.runId, type: "done" };
        return;
      }

      const forwardTextDeltas = this.canForwardRawStreamText();
      const stream = this.executeStreamingModelLoop(context, selected.provider, {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools
      }, { forwardTextDeltas });

      let next = await stream.next();

      while (!next.done) {
        yield next.value;
        next = await stream.next();
      }

      const execution = next.value;
      const filteredResponse = await this.applyResponseFilters(context, execution.finalResponse, execution.toolsUsed);
      const response = await this.applyOutputGuards(context, filteredResponse);
      await this.recordRunComplete(context, {
        ...execution,
        finalResponse: response
      });
      await this.writeCache(cacheKey, response, execution.toolsUsed);
      await this.invokeHooks("afterComplete", context, response);
      this.recordAgentRun(context, response.model, "completed", startedAtMs);
      if (!forwardTextDeltas && response.output.length > 0) {
        yield { runId: context.runId, text: response.output, type: "text-delta" };
      }
      yield { response, runId: context.runId, type: "done" };
    } catch (error) {
      runSpan.setError(error);
      await this.recordRunFailure(context, error);
      this.recordAgentRun(context, context.input.model, "failed", startedAtMs);
      await this.invokeHooks("onError", context, error);
      throw error;
    } finally {
      runSpan.end();
    }
  }

  private async applyAgentSpec(input: AgentRunInput): Promise<{
    readonly agentSpec?: AgentSpecResolution;
    readonly input: AgentRunInput;
  }> {
    if (!this.agentSpecResolver) {
      return { input };
    }

    try {
      const resolution = await this.agentSpecResolver.resolve(joinUserMessages(input.messages));

      if (!resolution) {
        return {
          input: {
            ...input,
            metadata: {
              ...input.metadata,
              agentSpecResolutionAttempted: true
            }
          }
        };
      }

      return {
        agentSpec: resolution,
        input: {
          ...input,
          messages: applyAgentSpecSystemPrompt(input.messages, resolution),
          metadata: {
            ...input.metadata,
            agentSpecConfidence: resolution.confidence,
            agentSpecMatchedKeywords: [...resolution.matchedKeywords],
            agentSpecName: resolution.spec.name,
            agentSpecResolutionAttempted: true,
            agentSpecToolNames: [...resolution.spec.toolNames]
          }
        }
      };
    } catch {
      return {
        input: {
          ...input,
          metadata: {
            ...input.metadata,
            agentSpecResolutionAttempted: true,
            agentSpecResolutionFailed: true
          }
        }
      };
    }
  }

  private resolveProvider(model: string): { readonly provider: ModelProvider; readonly model: string } {
    if (this.modelRegistry) {
      return {
        model: parseModelName(model).modelId,
        provider: this.modelRegistry.getProvider(model)
      };
    }

    return {
      model,
      provider: this.modelProvider ?? failMissingProvider()
    };
  }

  private prepareModelRequest(
    input: AgentRunInput,
    model: string
  ): {
    readonly contextWindow?: AgentContextWindowReport;
    readonly request: Pick<ModelRequest, "messages" | "metadata" | "model">;
  } {
    if (!this.contextWindow) {
      return {
        request: {
          messages: input.messages,
          metadata: input.metadata,
          model
        }
      };
    }

    const trimResult = trimConversationMessages(input.messages, this.contextWindow);

    return {
      contextWindow: {
        budgetTokens: trimResult.budgetTokens,
        estimatedTokens: trimResult.estimatedTokens,
        removedCount: trimResult.removedCount,
        summaryInserted: trimResult.summaryInserted
      },
      request: {
        messages: trimResult.messages,
        metadata: input.metadata,
        model
      }
    };
  }

  private async applyRetrievedContext(context: AgentRunContext): Promise<AgentRunInput> {
    if (!this.ragPipeline) {
      return context.input;
    }

    try {
      const query = joinUserMessages(context.input.messages);

      if (query.trim().length === 0) {
        return context.input;
      }

      const ragContext = await this.ragPipeline.retrieve({
        filters: ragFilters(context.input.metadata),
        query
      });
      const retrieved = renderRetrievedContext(ragContext.context);

      if (!retrieved) {
        return context.input;
      }

      return {
        ...context.input,
        messages: appendSystemSection(context.input.messages, retrieved),
        metadata: {
          ...context.input.metadata,
          ragDocumentCount: ragContext.documents.length,
          ragTotalTokens: ragContext.totalTokens
        }
      };
    } catch {
      return {
        ...context.input,
        metadata: {
          ...context.input.metadata,
          ragRetrievalFailed: true
        }
      };
    }
  }

  private modelTools(): readonly ModelTool[] {
    return this.toolRegistry?.toModelTools() ?? [];
  }

  private async readCache(key: string, model: string) {
    if (!this.responseCache) {
      return undefined;
    }

    try {
      const cached = await this.responseCache.get(key);

      if (cached) {
        this.cacheMetrics?.recordExactHit(model);
      } else {
        this.cacheMetrics?.recordMiss(model);
      }

      return cached;
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    key: string,
    response: ModelResponse,
    toolsUsed: readonly string[]
  ): Promise<void> {
    if (!this.responseCache) {
      return;
    }

    try {
      await this.responseCache.put(key, cachedResponseFromModelResponse(response, toolsUsed));
    } catch {
      // Response cache is a performance feature and must fail open.
    }
  }

  private async executeModelLoop(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelLoopExecution> {
    const intermediateMessages: ModelMessage[] = [];
    const toolResults: ExecutedToolResult[] = [];
    const toolsUsed: string[] = [];
    let messages: readonly ModelMessage[] = [...request.messages];
    let toolCallCount = 0;

    while (true) {
      const activeTools = toolCallCount < this.maxToolCalls ? request.tools : [];
      const response = await this.generateWithTracing(context, provider, {
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
        const remaining = this.maxToolCalls - toolCallCount;
        const executed = remaining > 0
          ? await this.executeToolCall(context, toolCall)
          : blockedToolResult(toolCall, "Error: max tool call limit reached");

        toolCallCount += remaining > 0 ? 1 : 0;
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

  private async *executeStreamingModelLoop(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest,
    options: StreamExecutionOptions
  ): AsyncGenerator<AgentRuntimeStreamEvent, ModelLoopExecution, void> {
    const intermediateMessages: ModelMessage[] = [];
    const toolResults: ExecutedToolResult[] = [];
    const toolsUsed: string[] = [];
    let messages: readonly ModelMessage[] = [...request.messages];
    let toolCallCount = 0;

    while (true) {
      const activeTools = toolCallCount < this.maxToolCalls ? request.tools : [];
      const turnStream = this.streamModelTurn(context, provider, {
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
        const remaining = this.maxToolCalls - toolCallCount;
        const executed = remaining > 0
          ? await this.executeToolCall(context, toolCall)
          : blockedToolResult(toolCall, "Error: max tool call limit reached");

        yield { runId: context.runId, toolCall, type: "tool-result" };
        toolCallCount += remaining > 0 ? 1 : 0;
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

  private async *streamModelTurn(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest,
    options: StreamExecutionOptions
  ): AsyncGenerator<AgentRuntimeStreamEvent, StreamedModelTurn, void> {
    const span = this.tracer.startSpan("muse.model.stream", {
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
          this.metrics.recordTokenUsage(response.usage, context.input.metadata);
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

  private async executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall
  ): Promise<ExecutedToolResult> {
    if (!this.toolExecutor) {
      return blockedToolResult(toolCall, "Error: tool executor is not configured");
    }

    const result = await this.toolExecutor.execute({
      arguments: toolCall.arguments,
      context: {
        runId: context.runId,
        userId: metadataString(context.input.metadata, "userId"),
        workspaceId: metadataString(context.input.metadata, "workspaceId")
      },
      id: toolCall.id,
      name: toolCall.name
    });

    return { result, toolCall };
  }

  private async evaluateGuards(context: AgentRunContext): Promise<void> {
    for (const guard of this.guards) {
      let decision: GuardDecision;
      const span = this.tracer.startSpan("muse.guard.evaluate", {
        "guard.id": guard.id,
        "run.id": context.runId
      });

      try {
        decision = await guard.evaluate(context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Guard failed closed";
        span.setError(error);
        span.setAttribute("guard.allowed", false);
        span.setAttribute("guard.reason", message);
        span.end();
        this.metrics.recordGuardRejection(guard.id, message, context.input.metadata);
        throw new GuardBlockedError(guard.id, message, "GUARD_ERROR");
      }

      if (!decision.allowed) {
        span.setAttribute("guard.allowed", false);
        span.setAttribute("guard.reason", decision.reason);
        span.end();
        this.metrics.recordGuardRejection(guard.id, decision.reason, context.input.metadata);
        throw new GuardBlockedError(guard.id, decision.reason, decision.code);
      }

      span.setAttribute("guard.allowed", true);
      span.end();
    }
  }

  private async generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse> {
    const span = this.tracer.startSpan("muse.model.generate", {
      "model.id": request.model,
      "provider.id": provider.id,
      "run.id": context.runId
    });

    try {
      const generate = () => this.generateWithFallback(provider, request);
      const response = await (this.circuitBreaker ? this.circuitBreaker.execute(generate) : generate());
      recordUsageSpanAttributes(span, response);

      if (response.usage) {
        this.metrics.recordTokenUsage(response.usage, context.input.metadata);
      }

      return response;
    } catch (error) {
      span.setError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async generateWithFallback(provider: ModelProvider, request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.generateWithResilience(provider, request);
    } catch (error) {
      const fallback = await this.fallbackStrategy?.execute(
        {
          maxOutputTokens: request.maxOutputTokens,
          messages: request.messages,
          metadata: request.metadata,
          temperature: request.temperature
        },
        error
      );

      if (fallback) {
        return fallback;
      }

      throw error;
    }
  }

  private async generateWithResilience(provider: ModelProvider, request: ModelRequest): Promise<ModelResponse> {
    const operation = () => {
      if (this.requestTimeoutMs === undefined) {
        return provider.generate(request);
      }

      return withTimeout(() => provider.generate(request), this.requestTimeoutMs);
    };

    if (!this.retry) {
      return operation();
    }

    return retry(operation, this.retry);
  }

  private async applyResponseFilters(
    context: AgentRunContext,
    response: ModelResponse,
    toolsUsed: readonly string[] = []
  ): Promise<ModelResponse> {
    let filtered = response;

    for (const stage of this.responseFilters) {
      const span = this.tracer.startSpan("muse.response_filter.apply", {
        "response_filter.id": stage.id,
        "run.id": context.runId
      });

      try {
        filtered = await stage.apply(filtered, {
          input: context.input,
          response: filtered,
          runId: context.runId,
          toolsUsed
        });
        span.setAttribute("response_filter.applied", true);
      } catch (error) {
        span.setError(error);
        span.setAttribute("response_filter.applied", false);
      } finally {
        span.end();
      }
    }

    return filtered;
  }

  private async applyOutputGuards(context: AgentRunContext, response: ModelResponse): Promise<ModelResponse> {
    let guarded = response;

    for (const stage of this.outputGuards) {
      let decision: OutputGuardDecision;
      const span = this.tracer.startSpan("muse.output_guard.check", {
        "output_guard.id": stage.id,
        "run.id": context.runId
      });

      try {
        decision = await stage.check(guarded.output, {
          input: context.input,
          response: guarded,
          runId: context.runId
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Output guard failed closed";
        span.setError(error);
        span.setAttribute("output_guard.action", "rejected");
        span.setAttribute("output_guard.reason", message);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "rejected", message, context.input.metadata);
        throw new OutputGuardBlockedError(stage.id, message, "OUTPUT_GUARD_ERROR");
      }

      if (decision.action === "reject") {
        span.setAttribute("output_guard.action", "rejected");
        span.setAttribute("output_guard.reason", decision.reason);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "rejected", decision.reason, context.input.metadata);
        throw new OutputGuardBlockedError(stage.id, decision.reason, decision.code);
      }

      if (decision.action === "modify") {
        span.setAttribute("output_guard.action", "modified");
        span.setAttribute("output_guard.reason", decision.reason);
        span.end();
        this.metrics.recordOutputGuardAction(stage.id, "modified", decision.reason, context.input.metadata);
        guarded = { ...guarded, output: decision.content };
        continue;
      }

      span.setAttribute("output_guard.action", "allowed");
      span.end();
      this.metrics.recordOutputGuardAction(stage.id, "allowed", "", context.input.metadata);
    }

    return guarded;
  }

  private canForwardRawStreamText(): boolean {
    return this.responseFilters.length === 0 && this.outputGuards.length === 0;
  }

  private async invokeHooks(name: "beforeStart", context: AgentRunContext): Promise<void>;
  private async invokeHooks(
    name: "afterComplete",
    context: AgentRunContext,
    response: ModelResponse
  ): Promise<void>;
  private async invokeHooks(name: "onError", context: AgentRunContext, error: unknown): Promise<void>;
  private async invokeHooks(name: keyof HookStage, context: AgentRunContext, value?: unknown): Promise<void> {
    for (const hook of this.hooksForInvocation()) {
      const invoke = hookInvocation(hook, name, context, value);

      if (!invoke) {
        continue;
      }

      const startedAt = new Date();
      const startedAtMs = Date.now();

      try {
        await invoke();
        await this.recordHookTrace(context, hook.id, name as HookLifecycle, "completed", startedAt, startedAtMs);
      } catch (error) {
        await this.recordHookTrace(context, hook.id, name as HookLifecycle, "failed", startedAt, startedAtMs, error);
        // Hooks are extension points and must fail open.
      }
    }
  }

  private hooksForInvocation(): readonly HookStage[] {
    const hooksById = new Map<string, HookStage>();

    for (const hook of this.hooks) {
      hooksById.set(hook.id, hook);
    }

    for (const hook of this.hookRegistry?.list() ?? []) {
      hooksById.set(hook.id, hook);
    }

    return [...hooksById.values()];
  }

  private async recordHookTrace(
    context: AgentRunContext,
    hookId: string,
    lifecycle: HookLifecycle,
    status: "completed" | "failed",
    startedAt: Date,
    startedAtMs: number,
    error?: unknown
  ): Promise<void> {
    if (!this.hookTraceStore) {
      return;
    }

    try {
      await this.hookTraceStore.record({
        completedAt: new Date(),
        durationMs: Math.max(0, Date.now() - startedAtMs),
        ...(error ? { error: error instanceof Error ? error.message : "unknown hook failure" } : {}),
        hookId,
        lifecycle,
        ...(context.input.metadata ? { metadata: context.input.metadata } : {}),
        runId: context.runId,
        startedAt,
        status
      });
    } catch {
      // Hook trace recording must not block agent execution.
    }
  }

  private recordAgentRun(
    context: AgentRunContext,
    model: string,
    status: "completed" | "failed",
    startedAtMs: number
  ): void {
    this.metrics.recordAgentRun({
      durationMs: Date.now() - startedAtMs,
      metadata: context.input.metadata,
      model,
      runId: context.runId,
      status
    });
  }

  private async recordRunStart(
    context: AgentRunContext,
    provider: string,
    model: string
  ): Promise<void> {
    if (!this.historyStore) {
      return;
    }

    try {
      await this.historyStore.createRun({
        id: context.runId,
        input: joinUserMessages(context.input.messages),
        mode: toAgentRunMode(context.agentSpec?.spec.mode),
        model,
        provider,
        startedAt: context.startedAt,
        status: "running",
        userId: metadataString(context.input.metadata, "userId"),
        workspaceId: metadataString(context.input.metadata, "workspaceId")
      });

      for (const message of context.input.messages) {
        await this.historyStore.appendMessage({
          content: message.content,
          metadata: message.toolCalls ? toolCallsMetadata(message.toolCalls) : {},
          name: message.name,
          role: message.role,
          runId: context.runId,
          toolCallId: message.toolCallId
        });
      }
    } catch {
      // History is observability state and must not block agent execution.
    }
  }

  private async recordRunComplete(context: AgentRunContext, execution: ModelLoopExecution): Promise<void> {
    if (!this.historyStore) {
      return;
    }

    try {
      for (const message of execution.intermediateMessages) {
        await this.historyStore.appendMessage({
          content: message.content,
          metadata: message.toolCalls ? toolCallsMetadata(message.toolCalls) : {},
          name: message.name,
          role: message.role,
          runId: context.runId,
          toolCallId: message.toolCallId
        });
      }

      await this.historyStore.appendMessage({
        content: execution.finalResponse.output,
        metadata: execution.finalResponse.toolCalls ? toolCallsMetadata(execution.finalResponse.toolCalls) : {},
        role: "assistant",
        runId: context.runId
      });

      for (const executed of execution.toolResults) {
        await this.historyStore.recordToolCall({
          arguments: executed.toolCall.arguments,
          id: executed.toolCall.id,
          name: executed.toolCall.name,
          risk: this.resolveToolRisk(executed.toolCall.name),
          runId: context.runId,
          status: toHistoryToolStatus(executed.result.status)
        });
      }

      const recordedToolCallIds = new Set(execution.toolResults.map((executed) => executed.toolCall.id));

      for (const toolCall of execution.finalResponse.toolCalls ?? []) {
        if (recordedToolCallIds.has(toolCall.id)) {
          continue;
        }

        await this.historyStore.recordToolCall({
          arguments: toolCall.arguments,
          id: toolCall.id,
          name: toolCall.name,
          risk: this.resolveToolRisk(toolCall.name),
          runId: context.runId,
          status: "queued"
        });
      }

      await this.historyStore.updateRun({
        completedAt: new Date(),
        output: execution.finalResponse.output,
        runId: context.runId,
        status: "completed",
        tokenUsage: execution.finalResponse.usage ? { ...execution.finalResponse.usage } : undefined
      });
    } catch {
      // History is observability state and must not block agent execution.
    }
  }

  private resolveToolRisk(name: string): "read" | "write" | "execute" {
    return this.toolRegistry?.get(name)?.definition.risk ?? "read";
  }

  private async recordRunFailure(context: AgentRunContext, error: unknown): Promise<void> {
    if (!this.historyStore) {
      return;
    }

    try {
      await this.historyStore.updateRun({
        completedAt: new Date(),
        error: error instanceof Error ? error.message : "unknown error",
        runId: context.runId,
        status: "failed"
      });
    } catch {
      // History is observability state and must not block agent execution.
    }
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}

interface ModelLoopExecution {
  readonly finalResponse: ModelResponse;
  readonly intermediateMessages: readonly ModelMessage[];
  readonly toolResults: readonly ExecutedToolResult[];
  readonly toolsUsed: readonly string[];
}

interface ExecutedToolResult {
  readonly toolCall: ModelToolCall;
  readonly result: ToolExecutionResult;
}

interface StreamedModelTurn {
  readonly response: ModelResponse;
}

interface StreamExecutionOptions {
  readonly forwardTextDeltas: boolean;
}

function blockedToolResult(toolCall: ModelToolCall, output: string): ExecutedToolResult {
  return {
    result: {
      id: toolCall.id,
      name: toolCall.name,
      output,
      status: "blocked"
    },
    toolCall
  };
}

function hookInvocation(
  hook: HookStage,
  name: keyof HookStage,
  context: AgentRunContext,
  value: unknown
): (() => Awaitable<void>) | undefined {
  const beforeStart = hook.beforeStart;
  const afterComplete = hook.afterComplete;
  const onError = hook.onError;

  if (name === "beforeStart" && beforeStart) {
    return () => beforeStart(context);
  }

  if (name === "afterComplete" && afterComplete) {
    return () => afterComplete(context, value as ModelResponse);
  }

  if (name === "onError" && onError) {
    return () => onError(context, value);
  }

  return undefined;
}

function appendSystemSection(
  messages: readonly ModelMessage[],
  section: string,
  sectionId = "context"
): readonly ModelMessage[] {
  const marker = `<!-- muse:${sectionId} -->`;
  const content = `${marker}\n${section}`;
  const systemIndex = messages.findIndex((message) => message.role === "system");

  if (systemIndex < 0) {
    return [{ content, role: "system" }, ...messages];
  }

  return messages.map((message, index) => {
    if (index !== systemIndex) {
      return message;
    }

    const withoutPrevious = message.content
      .split(marker)[0]
      ?.trimEnd();

    return {
      ...message,
      content: [withoutPrevious, content].filter(Boolean).join("\n\n")
    };
  });
}

function toHistoryToolStatus(status: ToolExecutionResult["status"]): "blocked" | "completed" | "failed" {
  return status;
}

function createRunResult(
  runId: string,
  response: ModelResponse,
  contextWindow: AgentContextWindowReport | undefined,
  agentSpec: AgentSpecResolution | undefined,
  execution: {
    readonly fromCache?: boolean;
    readonly toolsUsed?: readonly string[];
  } = {}
): AgentRunResult {
  const agentSpecReport = agentSpec ? toAgentSpecRunReport(agentSpec) : undefined;
  const base = {
    ...(execution.fromCache ? { fromCache: true } : {}),
    ...(execution.toolsUsed && execution.toolsUsed.length > 0 ? { toolsUsed: execution.toolsUsed } : {}),
    response,
    runId
  };

  if (!contextWindow) {
    return agentSpecReport ? { ...base, agentSpec: agentSpecReport } : base;
  }

  return agentSpecReport
    ? { ...base, agentSpec: agentSpecReport, contextWindow }
    : { ...base, contextWindow };
}

function recordContextWindowSpanAttributes(
  span: SpanHandle,
  contextWindow: AgentContextWindowReport | undefined
): void {
  if (!contextWindow) {
    return;
  }

  span.setAttribute("context.budget_tokens", contextWindow.budgetTokens);
  span.setAttribute("context.estimated_tokens", contextWindow.estimatedTokens);
  span.setAttribute("context.removed_count", contextWindow.removedCount);
  span.setAttribute("context.summary_inserted", contextWindow.summaryInserted);
}

function recordUsageSpanAttributes(span: SpanHandle, response: ModelResponse): void {
  if (!response.usage) {
    return;
  }

  const usage = response.usage;

  if (usage.inputTokens !== undefined) {
    span.setAttribute("usage.input_tokens", usage.inputTokens);
  }

  if (usage.outputTokens !== undefined) {
    span.setAttribute("usage.output_tokens", usage.outputTokens);
  }

  if (usage.reasoningTokens !== undefined) {
    span.setAttribute("usage.reasoning_tokens", usage.reasoningTokens);
  }
}

export function createInjectionInputGuard(): GuardStage {
  return {
    evaluate: (context) => {
      const findings = findInjectionPatterns(joinMessages(context.input.messages));

      if (findings.length === 0) {
        return { allowed: true };
      }

      return {
        allowed: false,
        code: "INJECTION_DETECTED",
        reason: `Input guard detected injection patterns: ${findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "injection-input-guard"
  };
}

export function createPiiInputGuard(): GuardStage {
  return {
    evaluate: (context) => {
      const result = maskPii(joinMessages(context.input.messages));

      if (result.findings.length === 0) {
        return { allowed: true };
      }

      return {
        allowed: false,
        code: "PII_DETECTED",
        reason: `Input guard detected private identifiers: ${result.findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "pii-input-guard"
  };
}

export function createPiiMaskingOutputGuard(): OutputGuardStage {
  return {
    check: (content) => {
      const result = maskPii(content);

      if (result.findings.length === 0) {
        return { action: "allow" };
      }

      return {
        action: "modify",
        content: result.text,
        reason: `Output guard masked private identifiers: ${result.findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "pii-output-mask"
  };
}

export function createSystemPromptLeakageOutputGuard(options: {
  readonly canaryTokens?: readonly string[];
} = {}): OutputGuardStage {
  return {
    check: (content) => {
      const findings = detectSystemPromptLeakage(content, {
        canaryTokens: options.canaryTokens
      });

      if (findings.length === 0) {
        return { action: "allow" };
      }

      return {
        action: "reject",
        code: "SYSTEM_PROMPT_LEAKAGE",
        reason: `Output guard detected system prompt leakage: ${findings.map((finding) => finding.name).join(", ")}`
      };
    },
    id: "system-prompt-leakage-output-guard"
  };
}

export function createSourceBlockResponseFilter(): ResponseFilterStage {
  return {
    apply: (response) => {
      const result = sanitizeSourceBlocks(response.output);

      if (!result.removed) {
        return response;
      }

      return {
        ...response,
        output: result.content,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "source-block-response-filter",
            reason: result.reason
          }
        }
      };
    },
    id: "source-block-response-filter"
  };
}

export function createMaxLengthResponseFilter(options: { readonly maxLength?: number } = {}): ResponseFilterStage {
  const maxLength = Math.max(0, Math.floor(options.maxLength ?? 0));

  return {
    apply: (response) => {
      if (maxLength <= 0 || response.output.length <= maxLength) {
        return response;
      }

      return {
        ...response,
        output: `${response.output.slice(0, maxLength)}\n\n[Response truncated]`,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "max-length-response-filter",
            maxLength
          }
        }
      };
    },
    id: "max-length-response-filter"
  };
}

export function createSanitizedTextResponseFilter(): ResponseFilterStage {
  return {
    apply: (response) => {
      if (!response.output.includes("[SANITIZED]")) {
        return response;
      }

      const output = response.output
        .replace(/^\s*\[SANITIZED]\s*$\n?/gm, "")
        .replaceAll("[SANITIZED]", "(보안 처리됨)")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "sanitized-text-response-filter")
      };
    },
    id: "sanitized-text-response-filter"
  };
}

export function createMarkdownStripResponseFilter(): ResponseFilterStage {
  return {
    apply: (response) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = splitOnCodeFences(response.output)
        .map((segment) => (segment.isCode ? segment.text : transformMarkdownText(segment.text)))
        .join("");

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "markdown-strip-response-filter")
      };
    },
    id: "markdown-strip-response-filter"
  };
}

export function createSlackUserIdMaskResponseFilter(): ResponseFilterStage {
  const rawSlackUserIdPattern = /(?<![@\w])`?(U[A-Z0-9]{8,})`?(?![A-Za-z0-9])/g;

  return {
    apply: (response) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = response.output.replace(rawSlackUserIdPattern, "<@$1>");

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "slack-user-id-mask-response-filter"
          }
        }
      };
    },
    id: "slack-user-id-mask-response-filter"
  };
}

export function createGreetingStripResponseFilter(): ResponseFilterStage {
  const leadingGreetingPattern =
    /^(안녕하세요|안녕|반가워요|반갑습니다|반갑네요|하이)(?:[,，]?\s*[^\n!?.]{0,25}[님씨])?[!?.]\s*/;
  const followupGreetingPattern =
    /^(반갑습니다|반가워요|반갑네요|만나서\s*반가워요|만나서\s*반갑습니다|만나서\s*정말\s*반가워요|만나서\s*정말\s*기쁩니다|좋은\s*아침이에요|좋은\s*저녁이에요)[!?.]\s*/;

  return {
    apply: (response) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      const output = response.output
        .replace(leadingGreetingPattern, "")
        .replace(followupGreetingPattern, "")
        .trimStart();

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "greeting-strip-response-filter")
      };
    },
    id: "greeting-strip-response-filter"
  };
}

export function createInternalBrandMaskResponseFilter(): ResponseFilterStage {
  const patterns: readonly (readonly [RegExp, string])[] = [
    [/\*\*?Reactor\s*\(\s*Reactor\s*\)\*\*?/g, "*Reactor*"],
    [/Reactor\s*\(\s*Reactor\s*\)/g, "Reactor"],
    [/^\s*[*\-•]\s*\*{0,2}(?:언어|프레임워크|Language|Framework)[\s:]*\*{0,2}[^\n]*Kotlin[^\n]*$/gm, ""],
    [/^\s*[*\-•]\s*\*{0,2}(?:언어|프레임워크|Language|Framework)[\s:]*\*{0,2}[^\n]*(?:Spring)[^\n]*$/gm, ""],
    [/\*{0,2}(?:Kotlin\s*\/\s*Spring\s*Boot|Kotlin과\s*Spring\s*Boot)(?:\s*기반(?:의|으로)?)?\*{0,2}/g, ""],
    [/\*{0,2}(?:Spring\s*AI|Spring\s*Boot)(?:\s*기반(?:의|으로)?)?\*{0,2}\s*/g, ""],
    [/,\s*,/g, ","],
    [/\s+\./g, "."]
  ];

  return {
    apply: (response) => {
      if (response.output.trim().length === 0) {
        return response;
      }

      let output = response.output;

      for (const [pattern, replacement] of patterns) {
        output = output.replace(pattern, replacement);
      }

      output = output.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trimEnd();

      if (output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            id: "internal-brand-mask-response-filter"
          }
        }
      };
    },
    id: "internal-brand-mask-response-filter"
  };
}

export function createFabricationRequestRefusalFilter(): ResponseFilterStage {
  return {
    apply: (response, context) => {
      const prompt = joinUserMessages(context.input.messages).toLowerCase();
      const asksToInvent = ["지어서", "지어내", "임의로", "만들어서", "make up", "fabricate"].some((term) =>
        prompt.includes(term)
      );
      const admitsMissing = ["없는", "문서에 없는", "근거 없이", "without source", "not in docs"].some((term) =>
        prompt.includes(term)
      );
      const asksSecret = ["비밀 문서", "비공개 문서", "secret document"].some((term) => prompt.includes(term));
      const missingOrDiscovery = ["없는", "찾아", "검색", "요약"].some((term) => prompt.includes(term));

      if (!(asksToInvent && admitsMissing) && !(asksSecret && missingOrDiscovery)) {
        return response;
      }

      return {
        ...response,
        output: [
          "요청하신 내용은 확인된 공식 문서나 접근 권한이 있는 출처가 없으면 제공할 수 없습니다.",
          "존재하지 않거나 비공개일 수 있는 문서는 찾아내거나 지어내서 요약하지 않습니다."
        ].join(" "),
        raw: withResponseFilterRaw(response, "fabrication-request-refusal-filter")
      };
    },
    id: "fabrication-request-refusal-filter"
  };
}

export function createZeroResultOverclaimResponseFilter(): ResponseFilterStage {
  const zeroResultPattern = /(0\s*건|검색 결과 0건|조회된 이슈가 없어|이슈는 없습니다|이슈가 없습니다)/i;
  const overclaimPattern =
    /(순조|원활|잘\s*(?:관리|되고)|모든\s*(?:작업|이슈)[^.\n]*(?:완료|정리)|활발한\s*작업이\s*진행되고\s*있지|활동\s*중인\s*이슈가\s*없는)/i;

  return {
    apply: (response, context) => {
      const toolsUsed = context.toolsUsed ?? [];
      const hasWorkspaceTool = toolsUsed.some((tool) =>
        ["jira_", "work_", "bitbucket_", "confluence_"].some((prefix) => tool.startsWith(prefix))
      );

      if (!hasWorkspaceTool || !zeroResultPattern.test(response.output) || !overclaimPattern.test(response.output)) {
        return response;
      }

      const output = response.output
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed.length === 0 || !overclaimPattern.test(trimmed);
        })
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();

      if (output.length === 0 || output === response.output) {
        return response;
      }

      return {
        ...response,
        output,
        raw: withResponseFilterRaw(response, "zero-result-overclaim-response-filter")
      };
    },
    id: "zero-result-overclaim-response-filter"
  };
}

export function createReleaseRiskDataGapResponseFilter(): ResponseFilterStage {
  const cautionMessage = "Bitbucket 데이터 집계 경고가 있어 전체 릴리스 위험도는 확정하지 않습니다.";
  const dataGapPattern =
    /(Bitbucket|비트버킷)[^\n.]*(집계|데이터|조회)[^\n.]*(실패|경고|문제|오류)|(실패|경고|문제|오류)[^\n.]*(Bitbucket|비트버킷)[^\n.]*(집계|데이터|조회)/i;
  const overconfidentRiskPattern =
    /(위험(?:도|도가| 점수)?[^\n.]*(?:낮|0\s*점)|위험\s*수준[^\n.]*(?:낮|low)|특별한\s*위험\s*신호[^\n.]*(?:없|감지되지)|심각한\s*위험\s*신호[^\n.]*(?:없|감지되지)|Jira\s*이슈와\s*Bitbucket\s*PR\s*활동[^\n.]*(?:없|없는)|특이사항[^\n.]*(?:없|발견되지)[^\n.]*(?:큰\s*문제|문제\s*없)|경고[^\n.]*(?:전체\s*)?위험도[^\n.]*(?:영향을?\s*미치지\s*않|영향\s*없)|릴리스\s*준비[^\n.]*(?:완료|끝)|(?:계획된\s*)?릴리스\s*체크리스트[^\n.]*(?:진행|계속)|전반적인\s*위험도[^\n.]*(?:낮음|low))/i;
  const cautionPattern = /전체\s*릴리스\s*위험도는\s*확정하지\s*않|release\s*risk[^\n.]*not\s*conclusive/i;

  return {
    apply: (response, context) => {
      if (!(context.toolsUsed ?? []).includes("work_release_risk_digest")) {
        return response;
      }
      if (!dataGapPattern.test(response.output) || !overconfidentRiskPattern.test(response.output)) {
        return response;
      }

      const output = response.output
        .split("\n")
        .map((line) => removeOverconfidentReleaseFragments(line, overconfidentRiskPattern))
        .filter((line) => line.trim().length > 0)
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (output.length === 0) {
        return response;
      }

      const finalOutput = cautionPattern.test(output) ? output : `${cautionMessage}\n\n${output}`;

      return {
        ...response,
        output: finalOutput,
        raw: withResponseFilterRaw(response, "release-risk-data-gap-response-filter")
      };
    },
    id: "release-risk-data-gap-response-filter"
  };
}

export function createStructuredOutputResponseFilter(options: {
  readonly format?: StructuredOutputFormat;
  readonly metadataKey?: string;
} = {}): ResponseFilterStage {
  const metadataKey = options.metadataKey ?? "responseFormat";

  return {
    apply: (response, context) => {
      const format = options.format ?? readStructuredOutputFormat(context.input.metadata?.[metadataKey]);

      if (!format) {
        return response;
      }

      const result = normalizeStructuredOutput(response.output, format);

      if (!result.normalized) {
        return response;
      }

      return {
        ...response,
        output: result.content,
        raw: {
          ...(isRecord(response.raw) ? response.raw : {}),
          museResponseFilter: {
            format,
            id: "structured-output-response-filter"
          }
        }
      };
    },
    id: "structured-output-response-filter"
  };
}

function withResponseFilterRaw(response: ModelResponse, id: string): JsonObject {
  return {
    ...(isRecord(response.raw) ? response.raw : {}),
    museResponseFilter: { id }
  };
}

function splitOnCodeFences(text: string): readonly { readonly isCode: boolean; readonly text: string }[] {
  const segments: { isCode: boolean; text: string }[] = [];
  let cursor = 0;
  let inCode = false;
  let buffer = "";

  while (cursor < text.length) {
    if (text.startsWith("```", cursor)) {
      if (buffer.length > 0) {
        segments.push({ isCode: inCode, text: buffer });
        buffer = "";
      }
      buffer += "```";
      cursor += 3;
      inCode = !inCode;
      continue;
    }

    buffer += text[cursor];
    cursor++;
  }

  if (buffer.length > 0) {
    segments.push({ isCode: inCode, text: buffer });
  }

  return segments;
}

function transformMarkdownText(text: string): string {
  let result = text
    .replace(/\*\*([^*\n]*[a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ][^*\n]*)\*\*/g, "*$1*")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, heading: string) => `*${heading.replaceAll("*", "").trim()}*`)
    .replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

  result = markdownTablesToBullets(result);
  return result;
}

function markdownTablesToBullets(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";

    if (!isMarkdownTableRow(line) || !isMarkdownTableSeparator(separator)) {
      output.push(line);
      index++;
      continue;
    }

    const headers = parseMarkdownTableRow(line);
    index += 2;

    while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
      const cells = parseMarkdownTableRow(lines[index] ?? "");
      const parts = headers.map((header, cellIndex) => {
        const cell = cells[cellIndex] ?? "";
        return header.length > 0 ? `*${header}*: ${cell}` : cell;
      });
      output.push(`• ${parts.join(", ")}`);
      index++;
    }
  }

  return output.join("\n");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("|") && trimmed.indexOf("|", 1) > 0;
}

function isMarkdownTableSeparator(line: string): boolean {
  return line.trimStart().startsWith("|") && /:?-{3,}:?/.test(line);
}

function parseMarkdownTableRow(line: string): readonly string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function removeOverconfidentReleaseFragments(line: string, pattern: RegExp): string {
  if (!pattern.test(line)) {
    return line;
  }

  const indent = line.match(/^\s*/)?.[0] ?? "";
  const fragments = line.trim().split(/(?<=[.!?])\s+/).filter((fragment) => fragment.trim().length > 0);
  const kept = fragments.filter((fragment) => !pattern.test(fragment));
  return kept.length === 0 ? "" : `${indent}${kept.join(" ")}`;
}

function joinMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

function joinUserMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

function applyAgentSpecSystemPrompt(
  messages: readonly ModelMessage[],
  resolution: AgentSpecResolution
): readonly ModelMessage[] {
  const systemPrompt = resolution.spec.systemPrompt;

  if (!systemPrompt) {
    return messages;
  }

  const [first, ...rest] = messages;

  if (first?.role === "system") {
    return [
      {
        ...first,
        content: `${systemPrompt}\n\n${first.content}`
      },
      ...rest
    ];
  }

  return [{ content: systemPrompt, role: "system" }, ...messages];
}

function toAgentSpecRunReport(resolution: AgentSpecResolution): AgentSpecRunReport {
  return {
    confidence: resolution.confidence,
    matchedKeywords: [...resolution.matchedKeywords],
    name: resolution.spec.name,
    toolNames: [...resolution.spec.toolNames]
  };
}

function metadataString(metadata: JsonObject | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readStructuredOutputFormat(value: unknown): StructuredOutputFormat | undefined {
  return value === "json" || value === "yaml" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ragFilters(metadata: JsonObject | undefined): JsonObject | undefined {
  const filters: Record<string, string> = {};

  for (const key of ["tenantId", "workspaceId"] as const) {
    const value = metadata?.[key];

    if (typeof value === "string" && value.trim().length > 0) {
      filters[key] = value;
    }
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}

function toolCallsMetadata(toolCalls: readonly ModelToolCall[]): JsonObject {
  return {
    toolCallCount: toolCalls.length,
    toolCallIds: toolCalls.map((toolCall) => toolCall.id),
    toolCallNames: toolCalls.map((toolCall) => toolCall.name)
  };
}

function toAgentRunMode(mode: AgentRunMode | undefined): AgentRunMode {
  return mode ?? "react";
}

function failMissingProvider(): never {
  throw new ModelRoutingError("AgentRuntime model provider is unavailable");
}
