import { Buffer } from "node:buffer";
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
  type SpanHandle,
  type TokenUsageSink
} from "@muse/observability";
import {
  buildLayeredSystemPrompt,
  buildPlanningSystemPrompt,
  renderExemplarContext,
  renderRetrievedContext,
  renderToolResults,
  type ExemplarRetriever,
  type PromptLayerRegistry
} from "@muse/prompts";
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
  CheckpointStore,
  HookLifecycle,
  HookTraceStore,
  PendingApprovalStore
} from "@muse/runtime-state";
import { trimConversationMessages, type ConversationTrimOptions } from "@muse/memory";
import {
  detectSystemPromptLeakage,
  detectTopicDrift,
  evaluateOutputGuardRules,
  findInjectionPatterns,
  maskPii,
  normalizeStructuredOutput,
  sanitizeSourceBlocks,
  type GuardBlockRateMonitor,
  type GuardRuleStore,
  type StructuredOutputFormat,
  type TopicDriftOptions,
  type ToolApprovalPolicy
} from "@muse/policy";
import { createRunId, type JsonObject } from "@muse/shared";
import { ToolCallDeduplicator } from "./tool-call-deduplicator.js";
import { isRecord, joinUserMessages, normalizeSourceUrl, withResponseFilterRaw } from "./internals.js";
import {
  applyAgentSpecSystemPrompt,
  failMissingProvider,
  isModelMessage,
  latestUserPrompt,
  metadataString,
  numberMetadata,
  ragFilters,
  recordContextWindowSpanAttributes,
  recordUsageSpanAttributes,
  stringListMetadata,
  toAgentRunMode,
  toAgentSpecRunReport,
  toolCallsMetadata
} from "./runtime-helpers.js";
import { extractToolInsights, extractVerifiedSources } from "./tool-output-evidence.js";
import {
  PlanExecutionError,
  PlanValidationFailedError,
  isPlanExecuteMode,
  parsePlan,
  renderPlanResultSummary,
  renderToolDescriptionsForPlanning,
  systemMessageContent,
  validatePlan,
  type PlanStep,
  type StepExecutionResult
} from "./plan-execute.js";
import {
  createAgentCheckpointState,
  encodeCheckpointMessages,
  type AgentCheckpointState
} from "./checkpoint.js";
import {
  GuardBlockedError,
  ModelRoutingError,
  OutputGuardBlockedError
} from "./errors.js";
import {
  ToolExecutor,
  ToolRegistry,
  toModelTool,
  type ToolExecutionResult,
  type ToolExposurePolicy,
  type ToolPolicyProvider
} from "@muse/tools";

import type {
  AgentRunContext,
  AgentRunInput,
  AgentSpecRunReport,
  Awaitable,
  GuardDecision,
  GuardStage,
  HookStage,
  LlmClassificationInputGuardOptions,
  OutputGuardContext,
  OutputGuardDecision,
  OutputGuardStage,
  ResponseFilterContext,
  ResponseFilterStage,
  VerifiedSource
} from "./types.js";

export type {
  AgentRunContext,
  AgentRunInput,
  AgentSpecRunReport,
  Awaitable,
  GuardDecision,
  GuardStage,
  HookStage,
  LlmClassificationInputGuardOptions,
  OutputGuardContext,
  OutputGuardDecision,
  OutputGuardStage,
  ResponseFilterContext,
  ResponseFilterStage,
  VerifiedSource
} from "./types.js";

interface ResponseFilterEvidence {
  readonly toolInsights: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly verifiedSources: readonly VerifiedSource[];
}

export {
  StepBudgetTracker,
  type BudgetStatus,
  type StepBudgetRecord,
  type StepBudgetTrackerOptions
} from "./step-budget.js";

export {
  ToolCallDeduplicator,
  stableJson,
  type ToolCallDeduplicationDecision,
  type ToolCallDuplicate,
  type ToolCallNotDuplicate
} from "./tool-call-deduplicator.js";

export interface AgentSpecResolver {
  resolve(text: string): Awaitable<AgentSpecResolution | undefined>;
}

export interface UserMemorySnapshot {
  readonly userId: string;
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics?: readonly string[];
}

export interface UserMemoryProvider {
  findByUserId(userId: string): Awaitable<UserMemorySnapshot | undefined>;
}

export interface UserMemoryInjectionOptions {
  readonly maxEntries?: number;
}

export interface AgentRuntimeOptions {
  readonly modelProvider?: ModelProvider;
  readonly modelRegistry?: ModelProviderRegistry;
  readonly agentSpecResolver?: AgentSpecResolver;
  readonly historyStore?: AgentRunHistoryStore;
  readonly checkpointStore?: CheckpointStore;
  readonly hookRegistry?: HookRegistry;
  readonly hookTraceStore?: HookTraceStore;
  readonly responseCache?: ResponseCache;
  readonly cacheMetrics?: CacheMetricsRecorder;
  readonly ragPipeline?: RagPipeline;
  readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  readonly toolRegistry?: ToolRegistry;
  readonly toolExecutor?: ToolExecutor;
  readonly toolExposurePolicy?: ToolExposurePolicy;
  readonly toolApprovalPolicy?: ToolApprovalPolicy;
  readonly toolApprovalStore?: PendingApprovalStore;
  readonly toolPolicyProvider?: ToolPolicyProvider;
  readonly maxToolCalls?: number;
  readonly circuitBreaker?: CircuitBreaker;
  readonly fallbackStrategy?: FallbackStrategy;
  readonly retry?: RetryOptions;
  readonly requestTimeoutMs?: number;
  readonly contextWindow?: ConversationTrimOptions;
  readonly metrics?: AgentMetrics;
  readonly tracer?: MuseTracer;
  readonly tokenUsageSink?: TokenUsageSink;
  readonly userMemoryProvider?: UserMemoryProvider;
  readonly userMemoryInjection?: UserMemoryInjectionOptions;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly outputGuards?: readonly OutputGuardStage[];
  readonly responseFilters?: readonly ResponseFilterStage[];
  readonly exemplarRetriever?: ExemplarRetriever;
  readonly exemplarTopK?: number;
  readonly promptLayerRegistry?: PromptLayerRegistry;
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

export interface AgentContextWindowReport {
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  readonly removedCount: number;
  readonly summaryInserted: boolean;
}

export {
  createAgentCheckpointState,
  decodeCheckpointMessages,
  encodeCheckpointMessages
} from "./checkpoint.js";
export type { AgentCheckpointState } from "./checkpoint.js";

export { GuardBlockedError, ModelRoutingError, OutputGuardBlockedError } from "./errors.js";

export {
  PlanExecutionError,
  PlanValidationFailedError,
  extractJsonArray,
  parsePlan,
  validatePlan,
  type PlanExecutionErrorCode,
  type PlanStep,
  type PlanValidationError,
  type PlanValidationInput,
  type PlanValidationResult,
  type StepExecutionResult
} from "./plan-execute.js";

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
  private readonly checkpointStore?: CheckpointStore;
  private readonly hookRegistry?: HookRegistry;
  private readonly hookTraceStore?: HookTraceStore;
  private readonly responseCache?: ResponseCache;
  private readonly cacheMetrics?: CacheMetricsRecorder;
  private readonly ragPipeline?: RagPipeline;
  private readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly toolExposurePolicy?: ToolExposurePolicy;
  private readonly maxToolCalls: number;
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly fallbackStrategy?: FallbackStrategy;
  private readonly retry?: RetryOptions;
  private readonly requestTimeoutMs?: number;
  private readonly contextWindow?: ConversationTrimOptions;
  private readonly metrics: AgentMetrics;
  private readonly tracer: MuseTracer;
  private readonly tokenUsageSink?: TokenUsageSink;
  private readonly userMemoryProvider?: UserMemoryProvider;
  private readonly userMemoryMaxEntries: number;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly responseFilters: readonly ResponseFilterStage[];
  private readonly exemplarRetriever?: ExemplarRetriever;
  private readonly exemplarTopK: number;
  private readonly promptLayerRegistry?: PromptLayerRegistry;
  private readonly defaults: AgentRuntimeOptions["defaults"];

  constructor(options: AgentRuntimeOptions) {
    this.modelProvider = options.modelProvider;
    this.modelRegistry = options.modelRegistry;
    this.agentSpecResolver = options.agentSpecResolver;
    this.historyStore = options.historyStore;
    this.checkpointStore = options.checkpointStore;
    this.hookRegistry = options.hookRegistry;
    this.hookTraceStore = options.hookTraceStore;
    this.responseCache = options.responseCache;
    this.cacheMetrics = options.cacheMetrics;
    this.ragPipeline = options.ragPipeline;
    this.guardBlockRateMonitor = options.guardBlockRateMonitor;
    this.toolRegistry = options.toolRegistry;
    this.toolExposurePolicy = options.toolExposurePolicy;
    this.toolExecutor = options.toolExecutor ??
      (options.toolRegistry
        ? new ToolExecutor({
            approvalPolicy: options.toolApprovalPolicy,
            approvalStore: options.toolApprovalStore,
            toolPolicyProvider: options.toolPolicyProvider,
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
    this.tokenUsageSink = options.tokenUsageSink;
    this.userMemoryProvider = options.userMemoryProvider;
    this.userMemoryMaxEntries = Math.max(1, options.userMemoryInjection?.maxEntries ?? 12);
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.responseFilters = options.responseFilters ?? [];
    this.exemplarRetriever = options.exemplarRetriever;
    this.exemplarTopK = Math.max(1, options.exemplarTopK ?? 3);
    this.promptLayerRegistry = options.promptLayerRegistry;
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
      await this.recordCheckpoint(context, 0, "start", context.input.messages);
      await this.evaluateGuards(context);
      await this.invokeHooks("beforeStart", context);

      const selected = this.resolveProvider(context.input.model);
      runSpan.setAttribute("model.selected", selected.model);
      const layeredContext = await this.applyPromptExemplars(
        this.applyPromptLayers(context, selected.provider.id, selected.model)
      );
      await this.recordRunStart(layeredContext, selected.provider.id, selected.model);

      const memoryAppliedInput = await this.applyUserMemory(layeredContext);
      const memoryAppliedContext: AgentRunContext = { ...layeredContext, input: memoryAppliedInput };
      const contextualizedInput = await this.applyRetrievedContext(memoryAppliedContext);
      const preparedRequest = this.prepareModelRequest(contextualizedInput, selected.model);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      const tools = this.modelTools(layeredContext);
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await this.applyResponseFilters(layeredContext, cachedResponse, {
          toolInsights: [],
          toolsUsed: cached.toolsUsed,
          verifiedSources: []
        });
        const guardedCachedResponse = await this.applyOutputGuards(layeredContext, filteredCachedResponse);

        await this.recordRunComplete(layeredContext, {
          finalResponse: guardedCachedResponse,
          intermediateMessages: [],
          toolResults: [],
          toolsUsed: cached.toolsUsed
        });
        await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, guardedCachedResponse.output);
        await this.invokeHooks("afterComplete", layeredContext, guardedCachedResponse);
        this.recordAgentRun(layeredContext, guardedCachedResponse.model, "completed", startedAtMs);
        return createRunResult(
          context.runId,
          guardedCachedResponse,
          preparedRequest.contextWindow,
          layeredContext.agentSpec,
          { fromCache: true, toolsUsed: cached.toolsUsed }
        );
      }

      const loopRequest: ModelRequest = {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools
      };
      const execution = isPlanExecuteMode(layeredContext.input.metadata)
        ? await this.executePlanExecuteLoop(layeredContext, selected.provider, loopRequest)
        : await this.executeModelLoop(layeredContext, selected.provider, loopRequest);
      const filteredResponse = await this.applyResponseFilters(
        layeredContext,
        execution.finalResponse,
        responseFilterEvidenceFromExecution(execution)
      );
      const guardedResponse = await this.applyOutputGuards(layeredContext, filteredResponse);

      await this.recordRunComplete(layeredContext, { ...execution, finalResponse: guardedResponse });
      await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, guardedResponse.output);
      await this.writeCache(cacheKey, guardedResponse, execution.toolsUsed);
      await this.invokeHooks("afterComplete", layeredContext, guardedResponse);
      this.recordAgentRun(layeredContext, guardedResponse.model, "completed", startedAtMs);
      return createRunResult(
        context.runId,
        guardedResponse,
        preparedRequest.contextWindow,
        layeredContext.agentSpec,
        { toolsUsed: execution.toolsUsed }
      );
    } catch (error) {
      runSpan.setError(error);
      await this.recordCheckpoint(context, 900, "failed", context.input.messages, error instanceof Error ? error.message : String(error));
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
      await this.recordCheckpoint(context, 0, "start", context.input.messages);
      await this.evaluateGuards(context);
      await this.invokeHooks("beforeStart", context);

      const selected = this.resolveProvider(context.input.model);
      runSpan.setAttribute("model.selected", selected.model);
      const layeredContext = await this.applyPromptExemplars(
        this.applyPromptLayers(context, selected.provider.id, selected.model)
      );
      await this.recordRunStart(layeredContext, selected.provider.id, selected.model);

      const memoryAppliedInput = await this.applyUserMemory(layeredContext);
      const memoryAppliedContext: AgentRunContext = { ...layeredContext, input: memoryAppliedInput };
      const contextualizedInput = await this.applyRetrievedContext(memoryAppliedContext);
      const preparedRequest = this.prepareModelRequest(contextualizedInput, selected.model);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      const tools = this.modelTools(layeredContext);
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await this.applyResponseFilters(layeredContext, cachedResponse, {
          toolInsights: [],
          toolsUsed: cached.toolsUsed,
          verifiedSources: []
        });
        const guardedCachedResponse = await this.applyOutputGuards(layeredContext, filteredCachedResponse);

        await this.recordRunComplete(layeredContext, {
          finalResponse: guardedCachedResponse,
          intermediateMessages: [],
          toolResults: [],
          toolsUsed: cached.toolsUsed
        });
        await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, guardedCachedResponse.output);
        await this.invokeHooks("afterComplete", layeredContext, guardedCachedResponse);
        this.recordAgentRun(layeredContext, guardedCachedResponse.model, "completed", startedAtMs);
        yield { runId: layeredContext.runId, text: guardedCachedResponse.output, type: "text-delta" };
        yield { response: guardedCachedResponse, runId: layeredContext.runId, type: "done" };
        return;
      }

      const forwardTextDeltas = this.canForwardRawStreamText();
      const streamLoopRequest: ModelRequest = {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools
      };
      let execution: ModelLoopExecution;
      if (isPlanExecuteMode(layeredContext.input.metadata)) {
        execution = await this.executePlanExecuteLoop(layeredContext, selected.provider, streamLoopRequest);
      } else {
        const stream = this.executeStreamingModelLoop(
          layeredContext,
          selected.provider,
          streamLoopRequest,
          { forwardTextDeltas }
        );
        let next = await stream.next();
        while (!next.done) {
          yield next.value;
          next = await stream.next();
        }
        execution = next.value;
      }
      const filteredResponse = await this.applyResponseFilters(
        layeredContext,
        execution.finalResponse,
        responseFilterEvidenceFromExecution(execution)
      );
      const response = await this.applyOutputGuards(layeredContext, filteredResponse);
      await this.recordRunComplete(layeredContext, {
        ...execution,
        finalResponse: response
      });
      await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, response.output);
      await this.writeCache(cacheKey, response, execution.toolsUsed);
      await this.invokeHooks("afterComplete", layeredContext, response);
      this.recordAgentRun(layeredContext, response.model, "completed", startedAtMs);
      if (!forwardTextDeltas && response.output.length > 0) {
        yield { runId: layeredContext.runId, text: response.output, type: "text-delta" };
      }
      yield { response, runId: layeredContext.runId, type: "done" };
    } catch (error) {
      runSpan.setError(error);
      await this.recordCheckpoint(context, 900, "failed", context.input.messages, error instanceof Error ? error.message : String(error));
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

  private async applyUserMemory(context: AgentRunContext): Promise<AgentRunInput> {
    if (!this.userMemoryProvider) {
      return context.input;
    }
    const userId = metadataString(context.input.metadata, "userId");
    if (!userId) {
      return context.input;
    }
    let memory: UserMemorySnapshot | undefined;
    try {
      memory = await this.userMemoryProvider.findByUserId(userId);
    } catch {
      return context.input;
    }
    if (!memory) {
      return context.input;
    }
    const rendered = renderUserMemorySection(memory, this.userMemoryMaxEntries);
    if (!rendered) {
      return context.input;
    }
    return {
      ...context.input,
      messages: appendSystemSection(context.input.messages, rendered, "user-memory"),
      metadata: {
        ...context.input.metadata,
        userMemoryFactCount: Object.keys(memory.facts).length,
        userMemoryPreferenceCount: Object.keys(memory.preferences).length
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

  private applyPromptLayers(context: AgentRunContext, providerId: string, model: string): AgentRunContext {
    if (!this.promptLayerRegistry) {
      return context;
    }

    const layers = this.promptLayerRegistry.resolve({
      model,
      personaId: metadataString(context.input.metadata, "personaId"),
      promptTemplateId: metadataString(context.input.metadata, "promptTemplateId"),
      providerId
    });

    if (layers.length === 0) {
      return context;
    }

    const systemPrompt = buildLayeredSystemPrompt({}, layers);

    return {
      ...context,
      input: {
        ...context.input,
        messages: appendSystemSection(context.input.messages, systemPrompt, "prompt-layers"),
        metadata: {
          ...context.input.metadata,
          promptLayerIds: layers.map((layer) => layer.id)
        }
      }
    };
  }

  private async applyPromptExemplars(context: AgentRunContext): Promise<AgentRunContext> {
    if (!this.exemplarRetriever) {
      return context;
    }

    try {
      const query = joinUserMessages(context.input.messages);

      if (query.trim().length === 0) {
        return context;
      }

      const exemplars = renderExemplarContext(
        await this.exemplarRetriever.retrieveTopK(query, this.exemplarTopK)
      );

      if (!exemplars) {
        return context;
      }

      return {
        ...context,
        input: {
          ...context.input,
          messages: appendSystemSection(context.input.messages, exemplars, "prompt-exemplars"),
          metadata: {
            ...context.input.metadata,
            promptExemplarApplied: true
          }
        }
      };
    } catch {
      return {
        ...context,
        input: {
          ...context.input,
          metadata: {
            ...context.input.metadata,
            promptExemplarRetrievalFailed: true
          }
        }
      };
    }
  }

  private modelTools(context: AgentRunContext): readonly ModelTool[] {
    if (!this.toolRegistry) {
      return [];
    }

    return this.toolRegistry
      .planForContext({
        allowedToolNames: stringListMetadata(context.input.metadata?.allowedToolNames),
        forbiddenToolNames: stringListMetadata(context.input.metadata?.forbiddenToolNames),
        localMode: context.input.metadata?.localMode === true,
        maxTools: numberMetadata(context.input.metadata?.maxTools),
        prompt: latestUserPrompt(context.input.messages),
        recentToolNames: stringListMetadata(context.input.metadata?.recentToolNames)
      }, this.toolExposurePolicy)
      .tools
      .map((tool) => toModelTool(tool));
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
    const deduplicator = new ToolCallDeduplicator();

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
        const duplicate = remaining > 0 ? deduplicator.check(toolCall) : undefined;
        const executed = duplicate?.duplicate
          ? { result: duplicate.result, toolCall }
          : remaining > 0
            ? await this.executeToolCall(context, toolCall, activeTools ?? [])
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
    const deduplicator = new ToolCallDeduplicator();

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
        const duplicate = remaining > 0 ? deduplicator.check(toolCall) : undefined;
        const executed = duplicate?.duplicate
          ? { result: duplicate.result, toolCall }
          : remaining > 0
            ? await this.executeToolCall(context, toolCall, activeTools ?? [])
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
          await this.recordTokenUsageEvent(context, provider, response, "act");
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

  private async executePlanExecuteLoop(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelLoopExecution> {
    const userPrompt = latestUserPrompt(request.messages);
    const tools = request.tools ?? [];
    const toolDescriptions = renderToolDescriptionsForPlanning(tools);

    const plan = await this.generatePlan(context, provider, request, userPrompt, toolDescriptions);
    if (plan === null) {
      throw new PlanExecutionError("PLAN_GENERATION_FAILED", "Plan generation parsing failed");
    }

    if (plan.length === 0) {
      const directResponse = await this.directAnswerForPlanExecute(context, provider, request);
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

    const executed = await this.executePlanSteps(context, plan, tools);

    if (executed.length > 0 && executed.every((entry) => !entry.stepResult.success)) {
      throw new PlanExecutionError(
        "PLAN_ALL_STEPS_FAILED",
        "Every plan step failed; refusing synthesis to avoid hallucinated answers"
      );
    }

    const finalResponse = await this.synthesizePlanResults(
      context,
      provider,
      request,
      userPrompt,
      executed
    );

    return {
      finalResponse,
      intermediateMessages: planExecuteIntermediateMessages(plan, executed),
      toolResults: executed.map((entry) => entry.executed),
      toolsUsed: [...new Set(executed.map((entry) => entry.executed.toolCall.name))]
    };
  }

  private async generatePlan(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest,
    userPrompt: string,
    toolDescriptions: string
  ): Promise<readonly PlanStep[] | null> {
    const planningPrompt = buildPlanningSystemPrompt({
      toolDescriptions,
      userPrompt
    });

    const planRequest: ModelRequest = {
      ...request,
      messages: [
        { content: planningPrompt, role: "system" },
        { content: userPrompt, role: "user" }
      ],
      tools: []
    };

    const response = await this.generateWithTracing(context, provider, planRequest);
    return parsePlan(response.output ?? "");
  }

  private async executePlanSteps(
    context: AgentRunContext,
    plan: readonly PlanStep[],
    tools: readonly ModelTool[]
  ): Promise<readonly PlanExecuteStepRecord[]> {
    const records: PlanExecuteStepRecord[] = [];
    let toolCallCount = 0;

    for (let index = 0; index < plan.length; index += 1) {
      const step = plan[index];
      if (!step) {
        continue;
      }

      if (toolCallCount >= this.maxToolCalls) {
        const blocked = blockedToolResult(
          { arguments: step.args, id: `plan-step-${index}`, name: step.tool },
          "Error: max tool call limit reached"
        );
        records.push({
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
        continue;
      }

      const synthesizedCall: ModelToolCall = {
        arguments: step.args,
        id: `plan-step-${index}`,
        name: step.tool
      };
      const executed = await this.executeToolCall(context, synthesizedCall, tools);
      toolCallCount += 1;

      const success = executed.result.status === "completed";
      records.push({
        executed,
        step,
        stepResult: {
          description: step.description,
          error: success ? undefined : executed.result.error ?? "TOOL_ERROR",
          output: success ? executed.result.output : null,
          success,
          tool: step.tool
        }
      });
    }

    return records;
  }

  private async synthesizePlanResults(
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

    const response = await this.generateWithTracing(context, provider, synthesisRequest);
    if (!response.output || response.output.trim().length === 0) {
      throw new PlanExecutionError(
        "RESPONSE_SYNTHESIS_FAILED",
        "Plan synthesis LLM returned an empty response"
      );
    }

    return response;
  }

  private async directAnswerForPlanExecute(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse> {
    const directRequest: ModelRequest = {
      ...request,
      tools: []
    };
    const response = await this.generateWithTracing(context, provider, directRequest);
    if (!response.output || response.output.trim().length === 0) {
      throw new PlanExecutionError(
        "RESPONSE_SYNTHESIS_FAILED",
        "Plan direct-answer fallback returned an empty response"
      );
    }
    return response;
  }

  private async executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ): Promise<ExecutedToolResult> {
    if (!activeTools.some((tool) => tool.name === toolCall.name)) {
      const executed = blockedToolResult(toolCall, `Error: tool was not exposed to the model: ${toolCall.name}`);
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    await this.invokeHooks("beforeTool", context, toolCall);

    if (!this.toolExecutor) {
      const executed = blockedToolResult(toolCall, "Error: tool executor is not configured");
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    const result = await this.toolExecutor.execute({
      arguments: toolCall.arguments,
      context: {
        channel: metadataString(context.input.metadata, "channel"),
        runId: context.runId,
        userId: metadataString(context.input.metadata, "userId"),
        workspaceId: metadataString(context.input.metadata, "workspaceId")
      },
      id: toolCall.id,
      name: toolCall.name
    });

    await this.invokeHooks("afterTool", context, { result, toolCall });
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
        this.guardBlockRateMonitor?.record({
          allowed: false,
          guardId: guard.id,
          reason: message,
          runId: context.runId
        });
        this.metrics.recordGuardRejection(guard.id, message, context.input.metadata);
        throw new GuardBlockedError(guard.id, message, "GUARD_ERROR");
      }

      if (!decision.allowed) {
        span.setAttribute("guard.allowed", false);
        span.setAttribute("guard.reason", decision.reason);
        span.end();
        this.guardBlockRateMonitor?.record({
          allowed: false,
          guardId: guard.id,
          reason: decision.reason,
          runId: context.runId
        });
        this.metrics.recordGuardRejection(guard.id, decision.reason, context.input.metadata);
        throw new GuardBlockedError(guard.id, decision.reason, decision.code);
      }

      span.setAttribute("guard.allowed", true);
      span.end();
      this.guardBlockRateMonitor?.record({
        allowed: true,
        guardId: guard.id,
        reason: null,
        runId: context.runId
      });
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
        await this.recordTokenUsageEvent(context, provider, response, "act");
      }

      return response;
    } catch (error) {
      span.setError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async recordTokenUsageEvent(
    context: AgentRunContext,
    provider: ModelProvider,
    response: ModelResponse,
    stepType: string
  ): Promise<void> {
    if (!this.tokenUsageSink) {
      return;
    }
    const usage = response.usage;
    if (!usage) {
      return;
    }
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;
    const reasoningTokens = usage.reasoningTokens ?? 0;
    try {
      await this.tokenUsageSink.record({
        completionTokens,
        model: response.model,
        promptTokens,
        provider: provider.id,
        reasoningTokens,
        recordedAt: new Date(),
        runId: context.runId,
        stepType,
        ...(metadataString(context.input.metadata, "tenantId")
          ? { tenantId: metadataString(context.input.metadata, "tenantId") as string }
          : {}),
        totalTokens: promptTokens + completionTokens + reasoningTokens
      });
    } catch (error) {
      this.tracer
        .startSpan("muse.token_usage.record_failed", {
          error: error instanceof Error ? error.message : String(error),
          "run.id": context.runId
        })
        .end();
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
    evidence: ResponseFilterEvidence = { toolInsights: [], toolsUsed: [], verifiedSources: [] }
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
          toolInsights: evidence.toolInsights,
          toolsUsed: evidence.toolsUsed,
          verifiedSources: evidence.verifiedSources
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
  private async invokeHooks(name: "beforeTool", context: AgentRunContext, toolCall: ModelToolCall): Promise<void>;
  private async invokeHooks(
    name: "afterTool",
    context: AgentRunContext,
    value: { readonly result: ToolExecutionResult; readonly toolCall: ModelToolCall }
  ): Promise<void>;
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
          status: executed.result.status
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

  private async recordCheckpoint(
    context: AgentRunContext,
    step: number,
    phase: string,
    messages: readonly ModelMessage[],
    output?: string
  ): Promise<void> {
    if (!this.checkpointStore) {
      return;
    }

    try {
      await this.checkpointStore.save({
        runId: context.runId,
        state: createAgentCheckpointState({
          metadata: context.input.metadata,
          model: context.input.model,
          output,
          phase,
          messages
        }),
        step
      });
    } catch {
      // Checkpoints support replay/debugging and must not block the agent loop.
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

interface PlanExecuteStepRecord {
  readonly step: PlanStep;
  readonly executed: ExecutedToolResult;
  readonly stepResult: StepExecutionResult;
}

function planExecuteIntermediateMessages(
  plan: readonly PlanStep[],
  executed: readonly PlanExecuteStepRecord[]
): readonly ModelMessage[] {
  const planSummary: ModelMessage = {
    content: JSON.stringify(plan),
    role: "assistant",
    toolCalls: executed.map((entry) => entry.executed.toolCall)
  };
  const toolMessages: ModelMessage[] = executed.map((entry) => ({
    content: entry.executed.result.output,
    name: entry.executed.toolCall.name,
    role: "tool",
    toolCallId: entry.executed.toolCall.id
  }));
  return [planSummary, ...toolMessages];
}

function hookInvocation(
  hook: HookStage,
  name: keyof HookStage,
  context: AgentRunContext,
  value: unknown
): (() => Awaitable<void>) | undefined {
  const beforeStart = hook.beforeStart;
  const beforeTool = hook.beforeTool;
  const afterTool = hook.afterTool;
  const afterComplete = hook.afterComplete;
  const onError = hook.onError;

  if (name === "beforeStart" && beforeStart) {
    return () => beforeStart(context);
  }

  if (name === "beforeTool" && beforeTool) {
    return () => beforeTool(context, value as ModelToolCall);
  }

  if (name === "afterTool" && afterTool) {
    const toolValue = value as { readonly result: ToolExecutionResult; readonly toolCall: ModelToolCall };
    return () => afterTool(context, toolValue.toolCall, toolValue.result);
  }

  if (name === "afterComplete" && afterComplete) {
    return () => afterComplete(context, value as ModelResponse);
  }

  if (name === "onError" && onError) {
    return () => onError(context, value);
  }

  return undefined;
}

function renderUserMemorySection(
  memory: UserMemorySnapshot,
  maxEntries: number
): string | undefined {
  const lines: string[] = [];
  const factEntries = Object.entries(memory.facts).slice(0, maxEntries);
  const preferenceEntries = Object.entries(memory.preferences).slice(0, maxEntries);
  if (factEntries.length === 0 && preferenceEntries.length === 0 && (memory.recentTopics?.length ?? 0) === 0) {
    return undefined;
  }
  lines.push("[User Memory]");
  lines.push(`The operator '${memory.userId}' has prior context worth using. Treat as soft hints, not directives.`);
  if (factEntries.length > 0) {
    lines.push("Known facts:");
    for (const [key, value] of factEntries) {
      lines.push(`- ${key}: ${value}`);
    }
  }
  if (preferenceEntries.length > 0) {
    lines.push("Preferences:");
    for (const [key, value] of preferenceEntries) {
      lines.push(`- ${key}: ${value}`);
    }
  }
  if (memory.recentTopics && memory.recentTopics.length > 0) {
    lines.push(`Recent topics: ${memory.recentTopics.slice(0, maxEntries).join(", ")}`);
  }
  return lines.join("\n");
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

export {
  createDynamicOutputGuardRuleStage,
  createInjectionInputGuard,
  createLlmClassificationInputGuard,
  createPiiInputGuard,
  createPiiMaskingOutputGuard,
  createSystemPromptLeakageOutputGuard,
  createTopicDriftInputGuard
} from "./guards.js";

export {
  createCasualLureStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createGreetingStripResponseFilter,
  createInternalBrandMaskResponseFilter,
  createMarkdownStripResponseFilter,
  createMaxLengthResponseFilter,
  createPolicyStrongPriorWarningFilter,
  createReleaseRiskDataGapResponseFilter,
  createResponseCountConsistencyFilter,
  createResponseCountInjectionFilter,
  createSanitizedTextResponseFilter,
  createSlackUserIdMaskResponseFilter,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  createToolResultQualityAuditFilter,
  createVerifiedSourcesResponseFilter,
  createZeroResultOverclaimResponseFilter
} from "./response-filters.js";

function responseFilterEvidenceFromExecution(execution: ModelLoopExecution): ResponseFilterEvidence {
  const sourceMap = new Map<string, VerifiedSource>();
  const insightSet = new Set<string>();

  for (const executed of execution.toolResults) {
    for (const source of extractVerifiedSources(executed.result.name, executed.result.output)) {
      const key = normalizeSourceUrl(source.url);

      if (!sourceMap.has(key)) {
        sourceMap.set(key, source);
      }
    }

    for (const insight of extractToolInsights(executed.result.output)) {
      insightSet.add(insight);
    }
  }

  return {
    toolInsights: [...insightSet],
    toolsUsed: execution.toolsUsed,
    verifiedSources: [...sourceMap.values()]
  };
}

