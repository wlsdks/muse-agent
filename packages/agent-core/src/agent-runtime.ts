import {
  buildCacheKey,
  cacheableModelRequest,
  cachedResponseFromModelResponse,
  type CacheMetricsRecorder,
  type CachedResponse,
  type ResponseCache
} from "@muse/cache";
import {
  ModelProviderRegistry,
  parseModelName,
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
import type { ExemplarRetriever, PromptLayerRegistry } from "@muse/prompts";
import type { CircuitBreaker, FallbackStrategy, RetryOptions } from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  CheckpointStore,
  HookTraceStore
} from "@muse/runtime-state";
import {
  trimConversationMessages,
  type ContextReferenceStore,
  type ConversationSummaryStore,
  type ConversationTrimOptions
} from "@muse/memory";
import type { GuardBlockRateMonitor } from "@muse/policy";
import { createRunId } from "@muse/shared";
import {
  ToolExecutor,
  ToolRegistry,
  coerceToolArguments,
  toModelTool,
  validateRequiredToolArguments,
  type ToolExecutionResult,
  type ToolExposurePolicy
} from "@muse/tools";

import type { ActiveContextProvider, ActiveContextSnapshot } from "./active-context.js";
import { applyAttachmentContext as applyAttachmentContextFn } from "./attachment-context.js";
import { joinUserMessages } from "./internals.js";
import { groundToolArguments } from "./tool-argument-grounding.js";
import {
  applyActiveContext as applyActiveContextFn,
  applyAgentSpec as applyAgentSpecFn,
  applyEpisodicRecall as applyEpisodicRecallFn,
  applyInboxContextWithGrounding as applyInboxContextWithGroundingFn,
  applyPromptExemplars as applyPromptExemplarsFn,
  applyPromptLayers as applyPromptLayersFn,
  applyStoredConversationSummary as applyStoredConversationSummaryFn,
  applyUserMemory as applyUserMemoryFn,
  persistConversationSummaryFromRequest as persistConversationSummaryFromRequestFn,
  resolveActiveContextSnapshot as resolveActiveContextSnapshotFn
} from "./context-transforms.js";
import {
  applyAmbientContext as applyAmbientContextFn,
  resolveAmbientSnapshot as resolveAmbientSnapshotFn
} from "./ambient-context.js";
import type { AmbientSnapshotProvider } from "./ambient-context.js";
import { applyVetoAvoidance as applyVetoAvoidanceFn } from "./veto-avoidance.js";
import type { VetoAvoidanceProvider } from "./veto-avoidance.js";
import { applyPlaybook as applyPlaybookFn } from "./playbook.js";
import type { PlaybookProvider } from "./playbook.js";
import type { PlanCacheProvider } from "./plan-cache.js";
import { applyClarifyDirective as applyClarifyDirectiveFn } from "./clarify-directive.js";
import type { EpisodicRecallProvider } from "./episodic-recall.js";
import { ModelRoutingError } from "./errors.js";
import {
  applyOutputGuards as applyOutputGuardsFn,
  applyResponseFilters as applyResponseFiltersFn,
  evaluateGuards as evaluateGuardsFn
} from "./guard-pipeline.js";
import { invokeHooks } from "./hook-orchestration.js";
import { HookRegistry } from "./hook-registry.js";
import type { InboxContextProvider } from "./inbox-context.js";
import {
  recordCheckpoint,
  recordRunComplete,
  recordRunFailure,
  recordRunStart
} from "./lifecycle.js";
import { invokeModel } from "./model-invocation.js";
import {
  executeModelLoop as executeModelLoopFn,
  executeStreamingModelLoop as executeStreamingModelLoopFn,
  type ModelLoopRunner
} from "./model-loop.js";
import { isPlanExecuteMode, validateEnumArguments } from "./plan-execute.js";
import {
  executePlanExecuteLoop as executePlanExecuteLoopFn,
  streamPlanExecute as streamPlanExecuteFn
} from "./plan-execute-loop.js";
import { enforceSystemPromptBudget, measureSystemPromptBudget, promptBudgetSpanAttributes } from "./prompt-budget.js";
import {
  failMissingProvider,
  latestUserPrompt,
  metadataString,
  numberMetadata,
  projectTelemetryMetadata,
  recordContextEngineeringSpanAttributes,
  recordContextWindowSpanAttributes,
  recordPromptBudgetSpanAttributes,
  resolvePersonaSnapshot as resolvePersonaSnapshotFn,
  stringListMetadata
} from "./runtime-helpers.js";
import {
  blockedToolResult,
  createRunResult,
  responseFilterEvidenceFromExecution,
  type ExecutedToolResult,
  type ModelLoopExecution
} from "./runtime-internals.js";
import { applySkillsContext as applySkillsContextFn, type SkillCatalogProvider } from "./skills-context.js";
import type { TelemetryAggregator } from "./telemetry-aggregator.js";
import { DEFAULT_TOOL_EXPOSURE_CEILING, capToolsByRelevance, type ToolFilter } from "./tool-filter.js";
import type {
  AgentContextWindowReport,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentSpecResolver,
  GuardStage,
  HookStage,
  OutputGuardStage,
  ResponseFilterStage,
  UserMemoryProvider
} from "./types.js";
import type {
  AgentRuntimeOptions,
  AgentRuntimeStreamEvent,
  ToolApprovalGate,
  ToolApprovalGateDecision
} from "./agent-runtime-types.js";

// Public types and option shapes live in ./agent-runtime-types.ts.
// Re-exported here so existing consumers — the @muse/agent-core
// barrel + tests — keep working through the historical
// `./agent-runtime.js` path.
export type {
  AgentRuntimeOptions,
  AgentRuntimeStreamEvent,
  ToolApprovalGate,
  ToolApprovalGateDecision,
  ToolApprovalGateInput,
  ToolRiskLevel
} from "./agent-runtime-types.js";

// A non-finite (NaN / Infinity) limit must fall back to the safe
// default, not disable the bound. Preserves the prior semantics
// (explicit 0 → 0, negative → 0, fractional truncates) and only
// changes the NaN/Infinity → default behaviour.
function clampRunLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
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
  private readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly toolExposurePolicy?: ToolExposurePolicy;
  private readonly maxToolCalls: number;
  private readonly systemPromptTokenBudget?: number;
  private readonly maxRunWallclockMs: number;
  private readonly maxToolOutputChars: number;
  private readonly contextReferenceStore?: ContextReferenceStore;
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
  private readonly conversationSummaryStore?: ConversationSummaryStore;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly responseFilters: readonly ResponseFilterStage[];
  private readonly exemplarRetriever?: ExemplarRetriever;
  private readonly exemplarTopK: number;
  private readonly promptLayerRegistry?: PromptLayerRegistry;
  private readonly activeContextProvider?: ActiveContextProvider;
  private readonly ambientSnapshotProvider?: AmbientSnapshotProvider;
  private readonly vetoAvoidanceProvider?: VetoAvoidanceProvider;
  private readonly playbookProvider?: PlaybookProvider;
  private readonly planCacheProvider?: PlanCacheProvider;
  private readonly inboxContextProvider?: InboxContextProvider;
  private readonly episodicRecallProvider?: EpisodicRecallProvider;
  private readonly toolFilter?: ToolFilter;
  private readonly skillCatalogProvider?: SkillCatalogProvider;
  private readonly telemetryAggregator?: TelemetryAggregator;
  private readonly toolApprovalGate?: ToolApprovalGate;
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
    this.guardBlockRateMonitor = options.guardBlockRateMonitor;
    this.toolRegistry = options.toolRegistry;
    this.toolExposurePolicy = options.toolExposurePolicy;
    this.toolExecutor = options.toolExecutor ??
      (options.toolRegistry
        ? new ToolExecutor({
            registry: options.toolRegistry
          })
        : undefined);
    // CLAUDE.md non-negotiable: tool loops have explicit limits AND
    // timeouts (default cap 10, wallclock 5 min — long enough for
    // chained calls + model latency, short enough to bound a
    // runaway loop). `??` does NOT catch NaN/Infinity; a non-finite
    // option would make `count >= NaN` / `elapsed >= NaN` always
    // false and SILENTLY DISABLE the bound, so guard finiteness.
    this.maxToolCalls = clampRunLimit(options.maxToolCalls, 10);
    this.systemPromptTokenBudget = Number.isFinite(options.systemPromptTokenBudget) && (options.systemPromptTokenBudget ?? 0) > 0
      ? Math.trunc(options.systemPromptTokenBudget as number)
      : undefined;
    this.maxRunWallclockMs = clampRunLimit(options.maxRunWallclockMs, 300_000);
    this.maxToolOutputChars = Math.max(0, options.maxToolOutputChars ?? 0);
    if (options.contextReferenceStore) {
      this.contextReferenceStore = options.contextReferenceStore;
    }
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
    this.conversationSummaryStore = options.conversationSummaryStore;
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.responseFilters = options.responseFilters ?? [];
    this.exemplarRetriever = options.exemplarRetriever;
    this.exemplarTopK = Math.max(1, options.exemplarTopK ?? 3);
    this.promptLayerRegistry = options.promptLayerRegistry;
    this.activeContextProvider = options.activeContextProvider;
    this.ambientSnapshotProvider = options.ambientSnapshotProvider;
    this.vetoAvoidanceProvider = options.vetoAvoidanceProvider;
    this.playbookProvider = options.playbookProvider;
    this.planCacheProvider = options.planCacheProvider;
    this.inboxContextProvider = options.inboxContextProvider;
    this.episodicRecallProvider = options.episodicRecallProvider;
    this.toolFilter = options.toolFilter;
    this.skillCatalogProvider = options.skillCatalogProvider;
    this.telemetryAggregator = options.telemetryAggregator;
    this.toolApprovalGate = options.toolApprovalGate;
    this.defaults = options.defaults;

    if (!this.modelProvider && !this.modelRegistry) {
      throw new ModelRoutingError("AgentRuntime requires either modelProvider or modelRegistry");
    }
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const specApplied = await applyAgentSpecFn(input, this.agentSpecResolver);
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
      const { cached, cacheKey, inboxGroundingSources, layeredContext, preparedRequest, promptBudget, selected, summaryAppliedMessageCount, tools } =
        await this.prepareInvocation(context, runSpan);

      if (cached) {
        const guardedCachedResponse = await this.processCachedResponse(layeredContext, cached, selected, startedAtMs);
        return createRunResult(
          context.runId,
          guardedCachedResponse,
          preparedRequest.contextWindow,
          layeredContext.agentSpec,
          { fromCache: true, inboxSources: inboxGroundingSources, toolsUsed: cached.toolsUsed }
        );
      }

      const loopRequest: ModelRequest = {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools
      };
      const execution = isPlanExecuteMode(layeredContext.input.metadata)
        ? await executePlanExecuteLoopFn(this.modelLoopRunner(), layeredContext, selected.provider, loopRequest)
        : await executeModelLoopFn(this.modelLoopRunner(), layeredContext, selected.provider, loopRequest);
      const guardedResponse = await this.finalizeInvocation({
        cacheKey,
        context: layeredContext,
        execution,
        preparedRequest,
        promptBudget,
        runSpan,
        selected,
        startedAtMs,
        summaryAppliedMessageCount
      });
      return createRunResult(
        context.runId,
        guardedResponse,
        preparedRequest.contextWindow,
        layeredContext.agentSpec,
        { inboxSources: inboxGroundingSources, toolResults: execution.toolResults, toolsUsed: execution.toolsUsed }
      );
    } catch (error) {
      await this.handleRunError(context, runSpan, error, startedAtMs);
      throw error;
    } finally {
      runSpan.end();
    }
  }

  async *stream(input: AgentRunInput): AsyncIterable<AgentRuntimeStreamEvent> {
    const startedAtMs = Date.now();
    const specApplied = await applyAgentSpecFn(input, this.agentSpecResolver);
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
      const { cached, cacheKey, layeredContext, preparedRequest, promptBudget, selected, summaryAppliedMessageCount, tools } =
        await this.prepareInvocation(context, runSpan);

      if (cached) {
        const guardedCachedResponse = await this.processCachedResponse(layeredContext, cached, selected, startedAtMs);
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
      const isPlanExecuteRun = isPlanExecuteMode(layeredContext.input.metadata);
      if (isPlanExecuteRun) {
        const planStream = streamPlanExecuteFn(this.modelLoopRunner(), layeredContext, selected.provider, streamLoopRequest);
        let next = await planStream.next();
        while (!next.done) {
          yield next.value;
          next = await planStream.next();
        }
        execution = next.value;
      } else {
        const stream = executeStreamingModelLoopFn(
          this.modelLoopRunner(),
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
      const response = await this.finalizeInvocation({
        cacheKey,
        context: layeredContext,
        execution,
        preparedRequest,
        promptBudget,
        runSpan,
        selected,
        startedAtMs,
        summaryAppliedMessageCount
      });
      if ((!forwardTextDeltas || isPlanExecuteRun) && response.output.length > 0) {
        yield { runId: layeredContext.runId, text: response.output, type: "text-delta" };
      }
      yield { response, runId: layeredContext.runId, type: "done" };
    } catch (error) {
      await this.handleRunError(context, runSpan, error, startedAtMs);
      throw error;
    } finally {
      runSpan.end();
    }
  }

  private async prepareInvocation(
    context: AgentRunContext,
    runSpan: SpanHandle
  ): Promise<{
    readonly cached: CachedResponse | undefined;
    readonly cacheKey: string;
    readonly inboxGroundingSources: readonly { readonly source: string; readonly text: string }[];
    readonly layeredContext: AgentRunContext;
    readonly preparedRequest: ReturnType<AgentRuntime["prepareModelRequest"]>;
    readonly promptBudget: ReturnType<typeof measureSystemPromptBudget>;
    readonly selected: { readonly provider: ModelProvider; readonly model: string };
    readonly summaryAppliedMessageCount: number;
    readonly tools: readonly ModelTool[];
  }> {
    await this.recordCheckpoint(context, 0, "start", context.input.messages);
    await evaluateGuardsFn(context, this.guards, this.tracer, this.metrics, this.guardBlockRateMonitor);
    await this.invokeHooks("beforeStart", context);

    const selected = this.resolveProvider(context.input.model);
    runSpan.setAttribute("model.selected", selected.model);
    const layeredContext = await applyPromptExemplarsFn(
      applyPromptLayersFn(context, selected.provider.id, selected.model, this.promptLayerRegistry),
      this.exemplarRetriever,
      this.exemplarTopK
    );
    await this.recordRunStart(layeredContext, selected.provider.id, selected.model);

    const memoryAppliedInput = await applyUserMemoryFn(layeredContext, this.userMemoryProvider, this.userMemoryMaxEntries);
    const clarifyAppliedInput = applyClarifyDirectiveFn({ ...layeredContext, input: memoryAppliedInput });
    const memoryAppliedContext: AgentRunContext = { ...layeredContext, input: clarifyAppliedInput };
    const activeContextSnapshot = await resolveActiveContextSnapshotFn(memoryAppliedContext, this.activeContextProvider);
    const activeContextInput = applyActiveContextFn(memoryAppliedContext, activeContextSnapshot);
    const ambientEnabled = this.ambientSnapshotProvider !== undefined;
    const ambientSnapshot = await resolveAmbientSnapshotFn(this.ambientSnapshotProvider, ambientEnabled);
    const ambientContextInput = applyAmbientContextFn(
      { ...memoryAppliedContext, input: activeContextInput },
      ambientSnapshot,
      ambientEnabled
    );
    const vetoAvoidanceInput = await applyVetoAvoidanceFn(
      { ...memoryAppliedContext, input: ambientContextInput },
      this.vetoAvoidanceProvider
    );
    const playbookInput = await applyPlaybookFn(
      { ...memoryAppliedContext, input: vetoAvoidanceInput },
      this.playbookProvider
    );
    const attachmentAppliedInput = applyAttachmentContextFn({ ...memoryAppliedContext, input: playbookInput });
    const skillsAppliedInput = await applySkillsContextFn({ ...memoryAppliedContext, input: attachmentAppliedInput }, this.skillCatalogProvider);
    const activeContextContext: AgentRunContext = { ...memoryAppliedContext, input: skillsAppliedInput };
    const { input: inboxAppliedInput, groundingSources: inboxGroundingSources } = await applyInboxContextWithGroundingFn(activeContextContext, this.inboxContextProvider);
    const inboxAppliedContext: AgentRunContext = { ...activeContextContext, input: inboxAppliedInput };
    const episodicAppliedInput = await applyEpisodicRecallFn(inboxAppliedContext, this.episodicRecallProvider);
    const episodicAppliedContext: AgentRunContext = { ...inboxAppliedContext, input: episodicAppliedInput };
    const summaryAppliedInput = await applyStoredConversationSummaryFn(episodicAppliedContext, this.conversationSummaryStore);
    const summaryAppliedContext: AgentRunContext = { ...episodicAppliedContext, input: summaryAppliedInput };
    // resolve the persona snapshot once per request and
    // forward to the trim layer so a compaction during this turn
    // re-injects user-context inside the [User context: ...] block.
    const personaSnapshot = await resolvePersonaSnapshotFn(
      summaryAppliedContext.input,
      this.userMemoryProvider,
      this.userMemoryMaxEntries
    );
    let preparedRequest = this.prepareModelRequest(summaryAppliedContext.input, selected.model, personaSnapshot, activeContextSnapshot);
    // Budget ENFORCEMENT (opt-in): the meter alone never stopped an
    // over-budget turn — when a cap is configured, whole sections are evicted
    // lowest-priority-first so the 12B's window is spent on what matters.
    if (this.systemPromptTokenBudget !== undefined) {
      const enforced = enforceSystemPromptBudget(preparedRequest.request.messages, { maxTokens: this.systemPromptTokenBudget });
      if (enforced.dropped.length > 0) {
        preparedRequest = { ...preparedRequest, request: { ...preparedRequest.request, messages: enforced.messages } };
        runSpan.setAttribute("ctx.budget.dropped_sections", enforced.dropped.map((section) => section.id).join(","));
      }
    }
    recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
    recordContextEngineeringSpanAttributes(runSpan, summaryAppliedContext.input.metadata);
    const promptBudget = measureSystemPromptBudget(preparedRequest.request.messages);
    if (promptBudget) {
      recordPromptBudgetSpanAttributes(runSpan, promptBudgetSpanAttributes(promptBudget));
    }
    const tools = this.modelTools(layeredContext);
    const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
    const cached = await this.readCache(cacheKey, selected.model);

    return {
      cached,
      cacheKey,
      inboxGroundingSources,
      layeredContext,
      preparedRequest,
      promptBudget,
      selected,
      summaryAppliedMessageCount: summaryAppliedContext.input.messages.length,
      tools
    };
  }

  private async finalizeInvocation(args: {
    readonly cacheKey: string;
    readonly context: AgentRunContext;
    readonly execution: ModelLoopExecution;
    readonly preparedRequest: ReturnType<AgentRuntime["prepareModelRequest"]>;
    readonly promptBudget: ReturnType<typeof measureSystemPromptBudget>;
    readonly runSpan: SpanHandle;
    readonly selected: { readonly provider: ModelProvider; readonly model: string };
    readonly startedAtMs: number;
    readonly summaryAppliedMessageCount: number;
  }): Promise<ModelResponse> {
    const { cacheKey, context, execution, preparedRequest, promptBudget, runSpan, selected, startedAtMs, summaryAppliedMessageCount } = args;
    const filtered = await applyResponseFiltersFn(
      context,
      execution.finalResponse,
      this.responseFilters,
      this.tracer,
      responseFilterEvidenceFromExecution(execution)
    );
    const guarded = await applyOutputGuardsFn(context, filtered, this.outputGuards, this.tracer, this.metrics);

    await this.recordRunComplete(context, { ...execution, finalResponse: guarded });
    await this.recordCheckpoint(context, 100, "complete", context.input.messages, guarded.output);
    await this.writeCache(cacheKey, guarded, execution.toolsUsed);
    if (preparedRequest.contextWindow?.summaryInserted) {
      await persistConversationSummaryFromRequestFn(
        context,
        preparedRequest.request,
        summaryAppliedMessageCount,
        this.conversationSummaryStore
      );
    }
    await this.invokeHooks("afterComplete", context, guarded);
    this.recordAgentRun(context, guarded.model, "completed", startedAtMs);
    // stamp wall-clock run latency on the trace span so a
    // trace-store consumer can correlate latency with the same ctx.*
    // span attrs without going through a separate query.
    runSpan.setAttribute("run.latency_ms", Date.now() - startedAtMs);
    this.recordTelemetry(context, selected.provider.id, selected.model, guarded, promptBudget, startedAtMs);
    return guarded;
  }

  private async handleRunError(
    context: AgentRunContext,
    runSpan: SpanHandle,
    error: unknown,
    startedAtMs: number
  ): Promise<void> {
    runSpan.setError(error);
    await this.recordCheckpoint(
      context,
      900,
      "failed",
      context.input.messages,
      error instanceof Error ? error.message : String(error)
    );
    await this.recordRunFailure(context, error);
    this.recordAgentRun(context, context.input.model, "failed", startedAtMs);
    await this.invokeHooks("onError", context, error);
  }

  private async processCachedResponse(
    context: AgentRunContext,
    cached: CachedResponse,
    selected: { readonly provider: ModelProvider; readonly model: string },
    startedAtMs: number
  ): Promise<ModelResponse> {
    const cachedResponse: ModelResponse = {
      id: `${context.runId}:cache`,
      model: cached.model ?? selected.model,
      output: cached.content
    };
    const filtered = await applyResponseFiltersFn(context, cachedResponse, this.responseFilters, this.tracer, {
      toolInsights: [],
      toolsUsed: cached.toolsUsed,
      verifiedSources: []
    });
    const guarded = await applyOutputGuardsFn(context, filtered, this.outputGuards, this.tracer, this.metrics);

    await this.recordRunComplete(context, {
      finalResponse: guarded,
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: cached.toolsUsed
    });
    await this.recordCheckpoint(context, 100, "complete", context.input.messages, guarded.output);
    await this.invokeHooks("afterComplete", context, guarded);
    this.recordAgentRun(context, guarded.model, "completed", startedAtMs);
    return guarded;
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
    model: string,
    personaSnapshot?: string,
    activeContextSnapshot?: ActiveContextSnapshot
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

    // Merge the resolved persona snapshot into the trim options so
    // it becomes part of the compaction summary's `[User context: ...]`
    // block when the trim fires. When unset
    // (no provider / no userId / empty memory), trim sees `undefined`
    // and behaves identically to before.
    // Phase 5 plumbing: also pipe the active task / focus from the
    // active-context snapshot into `importanceContext` so
    // `scoreMessageImportance` boosts messages that mention the
    // user's current work — otherwise the scorer only sees the
    // hard-coded decision hints.
    const importanceContext = activeContextSnapshot
      ? {
          ...(activeContextSnapshot.activeTask?.id ? { activeTaskId: activeContextSnapshot.activeTask.id } : {}),
          ...(activeContextSnapshot.activeTask?.title ? { activeTaskTitle: activeContextSnapshot.activeTask.title } : {}),
          ...(activeContextSnapshot.currentFocus ? { currentFocus: activeContextSnapshot.currentFocus } : {})
        }
      : undefined;
    const hasImportance = importanceContext && Object.keys(importanceContext).length > 0;
    const trimOptions: ConversationTrimOptions = {
      ...this.contextWindow,
      ...(personaSnapshot ? { personaSnapshot } : {}),
      ...(hasImportance ? { importanceContext } : {})
    };
    const trimResult = trimConversationMessages(input.messages, trimOptions);

    return {
      contextWindow: {
        budgetTokens: trimResult.budgetTokens,
        estimatedTokens: trimResult.estimatedTokens,
        removedCount: trimResult.removedCount,
        summaryInserted: trimResult.summaryInserted,
        triggeredBy: trimResult.triggeredBy
      },
      request: {
        messages: trimResult.messages,
        metadata: input.metadata,
        model
      }
    };
  }

  private modelTools(context: AgentRunContext): readonly ModelTool[] {
    if (!this.toolRegistry) {
      return [];
    }

    const userMessage = latestUserPrompt(context.input.messages);
    const recentToolNames = stringListMetadata(context.input.metadata?.recentToolNames);
    const callerMaxTools = numberMetadata(context.input.metadata?.maxTools);
    const tools = this.toolRegistry
      .planForContext({
        allowedToolNames: stringListMetadata(context.input.metadata?.allowedToolNames),
        forbiddenToolNames: stringListMetadata(context.input.metadata?.forbiddenToolNames),
        localMode: context.input.metadata?.localMode === true,
        maxTools: callerMaxTools,
        prompt: userMessage,
        recentToolNames
      }, this.toolExposurePolicy)
      .tools;

    const filtered = this.toolFilter
      ? this.toolFilter.filter(tools, {
          recentToolNames,
          scopeHints: stringListMetadata(context.input.metadata?.toolScopes),
          userMessage
        })
      : tools;

    // tool-calling.md #1: a normal chat/ask turn supplies no `maxTools`, so
    // the exposure plan advertises the WHOLE relevant catalog (10+ on a
    // multi-domain prompt), past the ≤5–7 one-shot band. Apply the default
    // soft ceiling here — AFTER the optional domain filter so the two agree,
    // and protecting always-on (core/untagged) + in-flight (recent) tools so
    // the cap only trims the lowest-relevance OPTIONAL tail. An explicit
    // caller `maxTools` (even a large one) wins.
    const capped = callerMaxTools === undefined
      ? capToolsByRelevance(filtered, { maxTools: DEFAULT_TOOL_EXPOSURE_CEILING, recentToolNames, userMessage })
      : filtered;

    return capped.map((tool) => toModelTool(tool));
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
    // A run that ACTED must never be replayed: a cache hit skips the model
    // loop, the executor, AND the approval gate, so an identical follow-up
    // request would get a "done" confirmation with no action performed
    // (terminal state ≠ claim). Cache only runs whose every tool is a known
    // read — an unknown tool (registry drift) counts as acting, fail-close.
    const acted = toolsUsed.some((name) => {
      const definition = this.toolRegistry?.get(name)?.definition;
      return !definition || definition.risk !== "read";
    });
    if (acted) {
      return;
    }

    try {
      await this.responseCache.put(key, cachedResponseFromModelResponse(response, toolsUsed));
    } catch {
      // Response cache is a performance feature and must fail open.
    }
  }

  private modelLoopRunner(): ModelLoopRunner {
    return {
      executeToolCall: (context, toolCall, activeTools) => this.executeToolCall(context, toolCall, activeTools),
      generateWithTracing: (context, provider, request) => this.generateWithTracing(context, provider, request),
      maxRunWallclockMs: this.maxRunWallclockMs,
      maxToolCalls: this.maxToolCalls,
      maxToolOutputChars: this.maxToolOutputChars,
      ...(this.planCacheProvider ? { planCacheProvider: this.planCacheProvider } : {}),
      ...(this.contextReferenceStore ? { contextReferenceStore: this.contextReferenceStore } : {}),
      metrics: this.metrics,
      tokenUsageSink: this.tokenUsageSink,
      tracer: this.tracer
    };
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

    const approvalGate = context.input.toolApprovalGate ?? this.toolApprovalGate;
    if (approvalGate) {
      const risk = this.resolveToolRisk(toolCall.name);
      let decision: ToolApprovalGateDecision;
      try {
        decision = await approvalGate({
          risk,
          runId: context.runId,
          toolCall,
          userId: metadataString(context.input.metadata, "userId")
        });
      } catch (error) {
        // Fail-close: a throwing gate (e.g. a corrupt
        // ~/.muse/trust.json, the gate's data source) must BLOCK
        // the tool, never crash the run or let the call through.
        decision = {
          allowed: false,
          reason: `approval gate error: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (!decision.allowed) {
        const reason = decision.reason ?? "tool call rejected by approval gate";
        const executed = blockedToolResult(toolCall, `Error: ${reason}`);
        await this.invokeHooks("afterTool", context, executed);
        return executed;
      }
    }

    // Deterministic arg repair + validation (tool-calling.md): first losslessly
    // coerce a right-value/wrong-type arg to the schema's type ("5" → 5), then
    // check required. A missing required arg returns the missing list so the
    // model re-calls correctly (bounded by maxToolCalls) — never execute with
    // bad args.
    const exposed = activeTools.find((tool) => tool.name === toolCall.name);
    const coercedArguments = coerceToolArguments(exposed?.inputSchema, toolCall.arguments);
    const argCheck = validateRequiredToolArguments(exposed?.inputSchema, coercedArguments);
    if (!argCheck.ok) {
      const executed = blockedToolResult(
        toolCall,
        `Error: missing required argument(s) for ${toolCall.name}: ${argCheck.missing.join(", ")}. Call it again with those argument(s).`
      );
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    // Then enforce closed-vocabulary (enum/const) constraints — the plan-execute
    // path validates these (validateEnumArguments), but the default ReAct path did
    // not, so an 8B that fabricated an out-of-schema enum value ("from":"base64"
    // for an enum of binary/octal/decimal/hex) reached the handler (crash, or a
    // write/actuator running a meaningless mode). tool-calling.md #3: invalid args
    // are the 2nd-biggest failure mode — fail-close here and feed the constraint
    // back so the model's bounded retry self-corrects, never execute on a bad value.
    const enumErrors = validateEnumArguments(exposed?.inputSchema, coercedArguments);
    if (enumErrors.length > 0) {
      const executed = blockedToolResult(
        toolCall,
        `Error: invalid argument(s) for ${toolCall.name}: ${enumErrors.join("; ")}. Call it again with a valid value.`
      );
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    if (!this.toolExecutor) {
      const executed = blockedToolResult(toolCall, "Error: tool executor is not configured");
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    // Deterministic arg grounding: drop a free-text actuator arg the 8B
    // fabricated (a calendar location/notes the user never said) — a schema
    // "omit if unspecified" instruction is ~0% effective on a small model, so
    // the fabrication=0 edge is enforced in code at the tool boundary.
    const groundedArgs = exposed?.groundedArgs ?? [];
    const finalArguments = groundedArgs.length > 0
      ? (groundToolArguments(coercedArguments, groundedArgs, joinUserMessages(context.input.messages)).args as typeof coercedArguments)
      : coercedArguments;

    const result = await this.toolExecutor.execute({
      arguments: finalArguments,
      context: {
        runId: context.runId,
        userId: metadataString(context.input.metadata, "userId")
      },
      id: toolCall.id,
      name: toolCall.name
    });

    await this.invokeHooks("afterTool", context, { result, toolCall });
    return { result, toolCall };
  }

  private async generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest
  ): Promise<ModelResponse> {
    return invokeModel({
      ...(this.circuitBreaker ? { circuitBreaker: this.circuitBreaker } : {}),
      ...(this.fallbackStrategy ? { fallbackStrategy: this.fallbackStrategy } : {}),
      metadata: context.input.metadata,
      metrics: this.metrics,
      provider,
      request,
      ...(this.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
      runId: context.runId,
      stepType: "act",
      ...(this.tokenUsageSink ? { tokenUsageSink: this.tokenUsageSink } : {}),
      tracer: this.tracer
    });
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
    return invokeHooks(name, context, {
      hooks: this.hooks,
      ...(this.hookRegistry ? { hookRegistry: this.hookRegistry } : {}),
      ...(this.hookTraceStore ? { hookTraceStore: this.hookTraceStore } : {})
    }, value as never);
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

  private recordTelemetry(
    context: AgentRunContext,
    providerId: string,
    model: string,
    response: ModelResponse,
    promptBudget: ReturnType<typeof measureSystemPromptBudget>,
    startedAtMs: number
  ): void {
    if (!this.telemetryAggregator) {
      return;
    }
    const projected = projectTelemetryMetadata(context.input.metadata);
    const budgetTokens: Record<string, number> = {};
    if (promptBudget) {
      budgetTokens["total"] = promptBudget.totalEstimatedTokens;
      for (const section of promptBudget.sections) {
        budgetTokens[`section.${section.id}`] = section.estimatedTokens;
      }
    }
    const recordedAtMs = Date.now();
    const latencyMs = Math.max(0, recordedAtMs - startedAtMs);
    this.telemetryAggregator.record({
      ...(promptBudget ? { budgetTokens } : {}),
      ...(response.usage?.cachedInputTokens !== undefined ? { cachedInputTokens: response.usage.cachedInputTokens } : {}),
      contextCounters: projected.counters,
      contextFlags: projected.flags,
      ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
      latencyMs,
      model,
      ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
      providerId,
      recordedAtMs,
      runId: context.runId
    });
  }

  private async recordRunStart(
    context: AgentRunContext,
    provider: string,
    model: string
  ): Promise<void> {
    return recordRunStart({
      context,
      historyStore: this.historyStore,
      model,
      provider
    });
  }

  private async recordRunComplete(context: AgentRunContext, execution: ModelLoopExecution): Promise<void> {
    return recordRunComplete({
      context,
      execution,
      historyStore: this.historyStore,
      resolveToolRisk: (name) => this.resolveToolRisk(name)
    });
  }

  private async recordCheckpoint(
    context: AgentRunContext,
    step: number,
    phase: string,
    messages: readonly ModelMessage[],
    output?: string
  ): Promise<void> {
    return recordCheckpoint({
      checkpointStore: this.checkpointStore,
      context,
      messages,
      ...(output !== undefined ? { output } : {}),
      phase,
      step
    });
  }

  private resolveToolRisk(name: string): "read" | "write" | "execute" {
    return this.toolRegistry?.get(name)?.definition.risk ?? "read";
  }

  private async recordRunFailure(context: AgentRunContext, error: unknown): Promise<void> {
    return recordRunFailure({
      context,
      error,
      historyStore: this.historyStore
    });
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}
