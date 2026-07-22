import {
  buildCacheKey,
  cacheableModelRequest,
  cachedResponseFromModelResponse,
  type CacheMetricsRecorder,
  type CachedResponse,
  type ResponseCache
} from "@muse/cache";
import {
  canUseNativeTools,
  ModelProviderRegistry,
  parseModelName,
  type ModelInfo,
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
import type { PersonaRegister } from "./conversational-register.js";
import {
  createRetryBudget,
  normalizeRetryBudgetPolicy,
  type CircuitBreaker,
  type FallbackStrategy,
  type RetryBudget,
  type RetryBudgetPolicy,
  type RetryOptions
} from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  CheckpointStore,
  HookTraceStore
} from "@muse/runtime-state";
import {
  DEFAULT_CHUNK_MAX_CHARS,
  summarizeDroppedContextInStages,
  verifyCompactionSummaryQuality,
  type ContextReferenceStore,
  type ConversationSummaryStore,
  type ConversationTrimOptions,
  type DroppedContextSummarizer
} from "@muse/memory";
import {
  resolveToolExposureAuthority,
  selectToolNamesForExposureAuthority,
  type GuardBlockRateMonitor,
  type ResolvedToolExposureAuthority
} from "@muse/policy";
import { createRunId, errorMessage, type JsonObject } from "@muse/shared";
import {
  ToolExecutor,
  ToolRegistry,
  createEgressAuthority,
  toModelTool,
  type ToolExecutionResult,
  type ToolExposurePolicy
} from "@muse/tools";
import { neutralizeInjectionSpans } from "./injection.js";

import type { ActiveContextProvider } from "./active-context.js";
import { applyAttachmentContext as applyAttachmentContextFn } from "./attachment-context.js";
import {
  isFirstPartyReadTool,
} from "./actuator-provenance-gate.js";
import { createTaintLedger } from "./taint-ledger.js";
import { executeToolPlan, parseToolPlan, type ToolPlan, type ToolPlanExecutor, type ToolPlanResult } from "./tool-plan.js";
import type { ToolExemplar } from "./tool-exemplars.js";
import type { ToolCallMiddleware } from "./tool-call-middleware.js";
import {
  applyActiveContext as applyActiveContextFn,
  applyAgentSpec as applyAgentSpecFn,
  applyEpisodicRecall as applyEpisodicRecallFn,
  applyInboxContextWithGrounding as applyInboxContextWithGroundingFn,
  applyPromptExemplars as applyPromptExemplarsFn,
  applyPromptLayers as applyPromptLayersFn,
  applyToolExemplars as applyToolExemplarsFn,
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
import { applyPlaybook as applyPlaybookFn, playbookInjectedIdsFromMetadata } from "./playbook.js";
import type { PlaybookProvider } from "./playbook.js";
import type { PlanCacheProvider } from "./plan-cache.js";
import { applyClarifyDirective as applyClarifyDirectiveFn } from "./clarify-directive.js";
import type { EpisodicRecallProvider } from "./episodic-recall.js";
import { ModelRoutingError, ModelToolCallingUnsupportedError } from "./errors.js";
import {
  applyOutputGuards as applyOutputGuardsFn,
  applyResponseFilters as applyResponseFiltersFn,
  evaluateGuards as evaluateGuardsFn
} from "./guard-pipeline.js";
import { invokeHooks } from "./hook-orchestration.js";
import { HookRegistry } from "./hook-registry.js";
import type { InboxContextProvider } from "./inbox-context.js";
import { isCancellationLikeError } from "@muse/resilience";
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
import { isPlanExecuteMode } from "./plan-execute.js";
import {
  executePlanExecuteLoop as executePlanExecuteLoopFn,
  streamPlanExecute as streamPlanExecuteFn
} from "./plan-execute-loop.js";
import { enforceSystemPromptBudget, measureSystemPromptBudget, promptBudgetSpanAttributes } from "./prompt-budget.js";
import {
  failMissingProvider,
  latestUserPrompt,
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
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentSpecResolver,
  GuardStage,
  HookStage,
  OutputGuardStage,
  ResponseFilterStage,
  UserMemoryProvider,
  UserModelComposer
} from "./types.js";
import type {
  AgentRuntimeOptions,
  AgentRuntimeStreamEvent,
  EgressAdvisorySink,
  ToolApprovalGate,
} from "./agent-runtime-types.js";

import {
  augmentCompactionSummary,
  clampRunLimit,
  logprobsFromInput,
  normalizeExemplarCount,
  normalizeToolOpportunityObserverTimeout,
  RUN_TOOL_PLAN_TOOL_NAME,
  seedEgressAuthorityFromMessages,
} from "./agent-runtime-helpers.js";
import {
  prepareContextAdmittedRequest,
  prepareModelRequest,
  resolveModelAwareTrimOptions
} from "./agent-runtime-request.js";
import { executeToolCall as executeToolCallGated } from "./agent-runtime-tool-call.js";

export { augmentCompactionSummary } from "./agent-runtime-helpers.js";

// Public types and option shapes live in ./agent-runtime-types.ts.
// Re-exported here so existing consumers — the @muse/agent-core
// barrel + tests — keep working through the historical
// `./agent-runtime.js` path.
export type {
  AgentRuntimeOptions,
  AgentRuntimeStreamEvent,
  EgressAdvisory,
  EgressAdvisorySink,
  ToolApprovalGate,
  ToolApprovalGateDecision,
  ToolApprovalGateInput,
  ToolOpportunityObserver,
  ToolOpportunityObserverInput,
  ToolRiskLevel
} from "./agent-runtime-types.js";


/**
 * Thrown by {@link AgentRuntime.executeToolPlanGated}'s executor when a plan step's gated tool call
 * does NOT complete (approval denied, validation/grounding rejected, or the handler failed).
 * `executeToolPlan` propagates it and aborts the plan, so no downstream step runs — a denied or
 * failed step leaves no partial side effect (the #1 PTC invariant, outbound-safety.md).
 */
export class ToolPlanStepBlockedError extends Error {
  readonly tool: string;
  readonly status: ToolExecutionResult["status"];
  readonly output: string;
  constructor(tool: string, status: ToolExecutionResult["status"], output: string) {
    super(`tool plan step '${tool}' did not complete (${status}): ${output}`);
    this.name = "ToolPlanStepBlockedError";
    this.tool = tool;
    this.status = status;
    this.output = output;
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
  private readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly toolExposurePolicy?: ToolExposurePolicy;
  private readonly maxToolCalls: number;
  private readonly systemPromptTokenBudget?: number;
  private readonly maxRunWallclockMs: number;
  private readonly streamIdleTimeoutMs?: number;
  private heartbeat?: (runId: string) => void;
  private readonly maxToolOutputChars: number;
  private readonly toolCallMiddleware?: readonly ToolCallMiddleware[];
  private readonly contextReferenceStore?: ContextReferenceStore;
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly fallbackStrategy?: FallbackStrategy;
  private readonly retry?: RetryOptions;
  private readonly runRetryBudget: Required<RetryBudgetPolicy>;
  private readonly requestTimeoutMs?: number;
  private readonly contextWindow?: ConversationTrimOptions;
  private readonly contextSummarizer?: DroppedContextSummarizer;
  private readonly contextSummaryMaxChars: number;
  private readonly metrics: AgentMetrics;
  private readonly tracer: MuseTracer;
  private readonly tokenUsageSink?: TokenUsageSink;
  private readonly userMemoryProvider?: UserMemoryProvider;
  private readonly userModelComposer?: UserModelComposer;
  private readonly userMemoryMaxEntries: number;
  private readonly conversationSummaryStore?: ConversationSummaryStore;
  private readonly guards: readonly GuardStage[];
  private readonly hooks: readonly HookStage[];
  private readonly outputGuards: readonly OutputGuardStage[];
  private readonly responseFilters: readonly ResponseFilterStage[];
  private readonly exemplarRetriever?: ExemplarRetriever;
  private readonly exemplarTopK: number;
  private readonly toolExemplarBank?: readonly ToolExemplar[];
  private readonly toolExemplarTopK: number;
  private readonly promptLayerRegistry?: PromptLayerRegistry;
  private readonly personaRegister?: PersonaRegister;
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
  private readonly toolOpportunityObserver?: AgentRuntimeOptions["toolOpportunityObserver"];
  private readonly toolOpportunityObserverTimeoutMs: number;
  private readonly egressAdvisorySink?: EgressAdvisorySink;
  private readonly defaults: AgentRuntimeOptions["defaults"];
  private readonly toolCapabilityCache = new Map<string, boolean>();

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
    // Positive-finite only — a non-positive / non-finite value leaves this
    // undefined so the loop falls back to DEFAULT_STREAM_IDLE_TIMEOUT_MS rather
    // than silently disabling the stall cut (`idleMs <= 0` disables the guard).
    this.streamIdleTimeoutMs = typeof options.streamIdleTimeoutMs === "number"
      && Number.isFinite(options.streamIdleTimeoutMs)
      && options.streamIdleTimeoutMs > 0
      ? Math.trunc(options.streamIdleTimeoutMs)
      : undefined;
    this.heartbeat = options.heartbeat;
    this.maxToolOutputChars = Math.max(0, options.maxToolOutputChars ?? 0);
    this.toolCallMiddleware = options.toolCallMiddleware;
    if (options.contextReferenceStore) {
      this.contextReferenceStore = options.contextReferenceStore;
    }
    this.circuitBreaker = options.circuitBreaker;
    this.fallbackStrategy = options.fallbackStrategy;
    this.retry = options.retry;
    this.runRetryBudget = normalizeRetryBudgetPolicy(options.runRetryBudget);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.contextWindow = options.contextWindow;
    this.contextSummarizer = options.contextSummarizer;
    this.contextSummaryMaxChars = options.contextSummaryMaxChars ?? 600;
    this.metrics = options.metrics ?? createNoOpAgentMetrics();
    this.tracer = options.tracer ?? createNoOpMuseTracer();
    this.tokenUsageSink = options.tokenUsageSink;
    this.userMemoryProvider = options.userMemoryProvider;
    this.userModelComposer = options.userModelComposer;
    this.userMemoryMaxEntries = Math.max(1, options.userMemoryInjection?.maxEntries ?? 12);
    this.conversationSummaryStore = options.conversationSummaryStore;
    this.guards = options.guards ?? [];
    this.hooks = options.hooks ?? [];
    this.outputGuards = options.outputGuards ?? [];
    this.responseFilters = options.responseFilters ?? [];
    this.exemplarRetriever = options.exemplarRetriever;
    this.exemplarTopK = normalizeExemplarCount(options.exemplarTopK);
    this.toolExemplarBank = options.toolExemplarBank;
    this.toolExemplarTopK = normalizeExemplarCount(options.toolExemplarTopK);
    this.promptLayerRegistry = options.promptLayerRegistry;
    this.personaRegister = options.personaRegister;
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
    this.toolOpportunityObserver = options.toolOpportunityObserver;
    this.toolOpportunityObserverTimeoutMs = normalizeToolOpportunityObserverTimeout(
      options.toolOpportunityObserverTimeoutMs
    );
    this.egressAdvisorySink = options.egressAdvisorySink;
    this.defaults = options.defaults;

    if (!this.modelProvider && !this.modelRegistry) {
      throw new ModelRoutingError("AgentRuntime requires either modelProvider or modelRegistry");
    }
  }

  /**
   * Late-bind the per-run liveness heartbeat. The registry that consumes
   * these beats (SubAgentRunRegistry) is constructed by the API server
   * AFTER the shared AgentRuntime — and @muse/autoconfigure cannot depend
   * on @muse/multi-agent without inverting the package graph — so the
   * wiring seam is post-construction. The model loop reads the current
   * callback per run, so beats flow on the next run after binding.
   */
  setHeartbeat(heartbeat: (runId: string) => void): void {
    this.heartbeat = heartbeat;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const startedAtMs = Date.now();
    const specApplied = await applyAgentSpecFn(input, this.agentSpecResolver);
    const context: AgentRunContext = {
      agentSpec: specApplied.agentSpec,
      input: specApplied.input,
      runId: input.runId ?? createRunId(),
      startedAt: new Date(),
      egressAdvisorySink: this.egressAdvisorySink,
      egressAuthority: createEgressAuthority(),
      taintLedger: createTaintLedger()
    };
    const runSpan = this.tracer.startSpan("muse.agent.run", {
      "model.requested": input.model,
      "run.id": context.runId
    });
    const retryBudget = createRetryBudget(this.runRetryBudget);

    try {
      const { cached, cacheKey, inboxGroundingSources, layeredContext, playbookInjectedIds, preparedRequest, promptBudget, selected, summaryAppliedMessageCount, tools } =
        await this.prepareInvocation(context, runSpan);
      seedEgressAuthorityFromMessages(context.egressAuthority, preparedRequest.request.messages);

      if (cached) {
        const guardedCachedResponse = await this.processCachedResponse(layeredContext, cached, selected, startedAtMs);
        return createRunResult(
          context.runId,
          guardedCachedResponse,
          preparedRequest.contextWindow,
          layeredContext.agentSpec,
          { fromCache: true, inboxSources: inboxGroundingSources, playbookInjectedIds, toolsUsed: cached.toolsUsed }
        );
      }

      const loopRequest: ModelRequest = {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools,
        ...logprobsFromInput(layeredContext.input),
        // Thread the run's cancellation into the model HTTP call itself —
        // without this the signal is only checked BETWEEN steps and an
        // in-flight generation can't be interrupted.
        ...(layeredContext.input.signal ? { signal: layeredContext.input.signal } : {})
      };
      const compactionOccurred = preparedRequest.contextWindow?.summaryInserted === true;
      const execution = isPlanExecuteMode(layeredContext.input.metadata)
        ? await executePlanExecuteLoopFn(this.modelLoopRunner(compactionOccurred, retryBudget), layeredContext, selected.provider, loopRequest)
        : await executeModelLoopFn(this.modelLoopRunner(compactionOccurred, retryBudget), layeredContext, selected.provider, loopRequest);
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
        { inboxSources: inboxGroundingSources, playbookInjectedIds, toolResults: execution.toolResults, toolsUsed: execution.toolsUsed }
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
      startedAt: new Date(),
      egressAdvisorySink: this.egressAdvisorySink,
      egressAuthority: createEgressAuthority(),
      taintLedger: createTaintLedger()
    };
    const runSpan = this.tracer.startSpan("muse.agent.stream", {
      "model.requested": input.model,
      "run.id": context.runId
    });
    const retryBudget = createRetryBudget(this.runRetryBudget);

    try {
      const { cached, cacheKey, layeredContext, playbookInjectedIds, preparedRequest, promptBudget, selected, summaryAppliedMessageCount, tools } =
        await this.prepareInvocation(context, runSpan);
      seedEgressAuthorityFromMessages(context.egressAuthority, preparedRequest.request.messages);

      if (cached) {
        const guardedCachedResponse = await this.processCachedResponse(layeredContext, cached, selected, startedAtMs);
        yield { runId: layeredContext.runId, text: guardedCachedResponse.output, type: "text-delta" };
        yield { ...(playbookInjectedIds ? { playbookInjectedIds } : {}), response: guardedCachedResponse, runId: layeredContext.runId, type: "done" };
        return;
      }

      const forwardTextDeltas = this.canForwardRawStreamText() || input.streamRawDeltas === true;
      const streamLoopRequest: ModelRequest = {
        ...preparedRequest.request,
        maxOutputTokens: this.defaults?.maxOutputTokens,
        temperature: this.defaults?.temperature,
        tools,
        ...logprobsFromInput(layeredContext.input),
        ...(layeredContext.input.signal ? { signal: layeredContext.input.signal } : {})
      };
      let execution: ModelLoopExecution;
      const isPlanExecuteRun = isPlanExecuteMode(layeredContext.input.metadata);
      const compactionOccurred = preparedRequest.contextWindow?.summaryInserted === true;
      if (isPlanExecuteRun) {
        const planStream = streamPlanExecuteFn(this.modelLoopRunner(compactionOccurred, retryBudget), layeredContext, selected.provider, streamLoopRequest);
        let next = await planStream.next();
        while (!next.done) {
          yield next.value;
          next = await planStream.next();
        }
        execution = next.value;
      } else {
        const stream = executeStreamingModelLoopFn(
          this.modelLoopRunner(compactionOccurred, retryBudget),
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
      yield { ...(playbookInjectedIds ? { playbookInjectedIds } : {}), response, runId: layeredContext.runId, type: "done" };
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
    readonly playbookInjectedIds: readonly string[] | undefined;
    readonly preparedRequest: ReturnType<typeof prepareModelRequest>;
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
      applyPromptLayersFn(context, selected.provider.id, selected.model, this.promptLayerRegistry, this.personaRegister),
      this.exemplarRetriever,
      this.exemplarTopK
    );
    await this.recordRunStart(layeredContext, selected.provider.id, selected.model);

    // Resolve the exposed tool set ONCE (the exposure plan keys off the user
    // prompt, which the system-section transforms never mutate) so the
    // tool-exemplar few-shot and the model request advertise the identical set.
    const tools = this.modelTools(layeredContext);
    await this.assertModelCanUseTools(selected, tools.length);

    const memoryAppliedInput = await applyUserMemoryFn(layeredContext, this.userMemoryProvider, this.userMemoryMaxEntries, this.userModelComposer);
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
    const toolExemplarInput = applyToolExemplarsFn(
      { ...memoryAppliedContext, input: skillsAppliedInput },
      this.toolExemplarBank,
      tools.map((tool) => tool.name),
      this.toolExemplarTopK
    );
    const activeContextContext: AgentRunContext = { ...memoryAppliedContext, input: toolExemplarInput };
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
    const effectiveContextWindow = await resolveModelAwareTrimOptions(this.contextWindow, selected.provider, {
      maxOutputTokens: this.defaults?.maxOutputTokens,
      model: selected.model,
      ...(summaryAppliedContext.input.signal ? { signal: summaryAppliedContext.input.signal } : {}),
      tools
    });
    let preparedRequest = prepareModelRequest(effectiveContextWindow, summaryAppliedContext.input, selected.model, personaSnapshot, activeContextSnapshot);
    // When a compaction fired and an aux summarizer is configured,
    // summarize the dropped window with the cheap aux model and append it to
    // the deterministic [Conversation summary …] block. Fail-open — an empty
    // result leaves the deterministic summary untouched (no aux call when
    // unconfigured, so existing behavior is byte-identical).
    if (this.contextSummarizer && preparedRequest.contextWindow?.summaryInserted && preparedRequest.dropped && preparedRequest.dropped.length > 0) {
      const auxSummary = await summarizeDroppedContextInStages(preparedRequest.dropped, this.contextSummarizer, {
        fallback: "",
        maxChars: this.contextSummaryMaxChars,
        chunkMaxChars: DEFAULT_CHUNK_MAX_CHARS,
        ...(this.contextWindow?.focusTopic ? { focusTopic: this.contextWindow.focusTopic } : {})
      });
      if (auxSummary.length > 0) {
        // Fail-close quality gate (deterministic, no LLM): a generated aux
        // summary that drops too many hard anchors — or ANY anchor the user
        // themselves asserted — is never shipped. The deterministic
        // `[Key details]` block (already inserted, unconditionally) remains
        // the floor; a rejected aux summary just isn't appended on top of it.
        const qualityGate = verifyCompactionSummaryQuality(preparedRequest.dropped, auxSummary);
        if (qualityGate.passed) {
          preparedRequest = {
            ...preparedRequest,
            request: { ...preparedRequest.request, messages: augmentCompactionSummary(preparedRequest.request.messages, auxSummary) }
          };
          runSpan.setAttribute("ctx.compaction.aux_quality_gate", "passed");
        } else {
          runSpan.setAttribute("ctx.compaction.aux_quality_gate", "rejected");
          runSpan.setAttribute("ctx.compaction.aux_quality_coverage", qualityGate.coverageRatio);
        }
      }
    }
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
    const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
    const cached = await this.readCache(cacheKey, selected.model);

    return {
      cached,
      cacheKey,
      inboxGroundingSources,
      layeredContext,
      playbookInjectedIds: playbookInjectedIdsFromMetadata(playbookInput.metadata),
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
    readonly preparedRequest: ReturnType<typeof prepareModelRequest>;
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
      errorMessage(error)
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

  // Send an explicit error instead of silently advertising tools to a model
  // that will never call them (native tool-calling + structured output both
  // required). A model we can't classify (unknown modelId, listModels
  // failure) fails OPEN — this is a positive-confirmation gate, not a
  // default-deny one.
  private async assertModelCanUseTools(
    selected: { readonly provider: ModelProvider; readonly model: string },
    toolCount: number
  ): Promise<void> {
    if (toolCount === 0) {
      return;
    }
    const key = `${selected.provider.id}/${selected.model}`;
    let capable = this.toolCapabilityCache.get(key);
    if (capable === undefined) {
      let info: ModelInfo | undefined;
      try {
        info = (await selected.provider.listModels()).find((m) => m.modelId === selected.model);
      } catch {
        return;
      }
      if (info === undefined) {
        return;
      }
      capable = canUseNativeTools(info);
      this.toolCapabilityCache.set(key, capable);
    }
    if (!capable) {
      throw new ModelToolCallingUnsupportedError(selected.model);
    }
  }

  async executeToolPlanGated(plan: ToolPlan, context: AgentRunContext): Promise<ToolPlanResult> {
    const activeTools = this.modelTools(context);
    let stepIndex = 0;
    const executor: ToolPlanExecutor = async (tool, args) => {
      stepIndex += 1;
      const toolCall: ModelToolCall = {
        arguments: args as JsonObject,
        id: `${context.runId}-ptc-${stepIndex.toString()}`,
        name: tool
      };
      const executed = await this.executeToolCall(context, toolCall, activeTools);
      if (executed.result.status !== "completed") {
        throw new ToolPlanStepBlockedError(tool, executed.result.status, executed.result.output);
      }
      // Feed this step's OWN result into the egress authority before the NEXT
      // step's gate runs (executeToolPlan awaits each step in order, so this
      // synchronously completes first) — otherwise a URL discovered mid-plan
      // (e.g. a page fetched in step 1) would never be observed for step 2's
      // link-follow, false-denying an ordinary multi-step PTC browse.
      if (isFirstPartyReadTool(tool)) {
        context.egressAuthority?.recordTrustedText(executed.result.output);
      } else {
        context.egressAuthority?.recordUntrustedText(executed.result.output);
      }
      return executed.result.output;
    };
    return executeToolPlan(plan, executor);
  }

  /**
   * Handle a {@link RUN_TOOL_PLAN_TOOL_NAME} call: parse the plan (knownTools = the OTHER exposed
   * tools, so a nested run_tool_plan is an unknown-tool parse error and recursion is impossible),
   * run it through the gated path, and project the result back as a normal COMPLETED tool result.
   * A parse error or a {@link ToolPlanStepBlockedError} (denied/invalid/failed step) becomes a
   * BLOCKED tool result — never a throw — so the model loop continues and a blocked step (Phase 2's
   * guarantee) leaves no partial downstream effect. The projected `result` is the ONLY value that
   * re-enters context, and because it is a completed tool output it is automatically a citable
   * grounding source (groundingSourceFromExecuted) — the final answer is grounded against it.
   */
  private async runToolPlanTool(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ): Promise<ExecutedToolResult> {
    const knownTools = new Set(
      activeTools.map((tool) => tool.name).filter((name) => name !== RUN_TOOL_PLAN_TOOL_NAME)
    );
    const parsed = parseToolPlan(toolCall.arguments, { knownTools });
    if ("error" in parsed) {
      const executed = blockedToolResult(toolCall, `Error: invalid tool plan: ${parsed.error}`);
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    let planResult: ToolPlanResult;
    try {
      planResult = await this.executeToolPlanGated(parsed, context);
    } catch (error) {
      if (isCancellationLikeError(error)) {
        throw error;
      }
      const reason = error instanceof ToolPlanStepBlockedError
        ? `plan step '${error.tool}' did not complete (${error.status}): ${error.output}`
        : errorMessage(error);
      const executed = blockedToolResult(toolCall, `Error: ${reason}`);
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    const output = typeof planResult.result === "string"
      ? planResult.result
      : JSON.stringify(planResult.result ?? null);
    const executed: ExecutedToolResult = {
      result: { id: toolCall.id, name: toolCall.name, output, status: "completed" },
      toolCall
    };
    await this.invokeHooks("afterTool", context, executed);
    return executed;
  }

  private modelTools(context: AgentRunContext): readonly ModelTool[] {
    if (!this.toolRegistry) {
      return [];
    }

    const userMessage = latestUserPrompt(context.input.messages);
    const recentToolNames = stringListMetadata(context.input.metadata?.recentToolNames);
    const callerMaxTools = numberMetadata(context.input.metadata?.maxTools);
    const availableTools = this.toolRegistry.list();
    const safeDefaultToolNames = availableTools
      .filter((tool) => tool.definition.risk === "read" && !tool.definition.scopes?.includes("local"))
      .map((tool) => tool.definition.name);
    const requestedAuthority = context.input.toolExposureAuthority;
    const authority: ResolvedToolExposureAuthority | undefined = requestedAuthority === undefined
      ? {
          allowedToolNames: safeDefaultToolNames,
          localMode: false
        }
      : resolveToolExposureAuthority(requestedAuthority);

    if (!authority) {
      return [];
    }

    const safeDefaultCandidates = authority.safeDefaultOnly === true
      ? new Set(authority.allowedToolNames)
      : undefined;
    const allowedToolNames = requestedAuthority === undefined
      ? authority.allowedToolNames
      : safeDefaultCandidates
        ? safeDefaultToolNames.filter((toolName) => safeDefaultCandidates.has(toolName))
        : selectToolNamesForExposureAuthority(
            authority,
            availableTools.map((tool) => tool.definition.name)
          );

    // `ToolExposurePolicy` treats an empty allowlist as unrestricted. An
    // authority/profile empty allowlist is the opposite: it is an explicit
    // zero-capability surface and must stop before that legacy policy runs.
    if (allowedToolNames.length === 0) {
      return [];
    }

    const tools = this.toolRegistry
      .planForContext({
        allowedToolNames,
        localMode: authority.safeDefaultOnly === true ? false : authority.localMode,
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

    // Neutralize the tool DESCRIPTION at the trust boundary, right before it
    // enters the model request. A tool projected from an external MCP server
    // carries a server-authored description verbatim (transport.ts copies
    // tool.description as-is); a malicious server can plant an injected
    // instruction there — the "tool poisoning" surface. The same neutralizer
    // already runs on tool OUTPUT; this closes the DEFINITION side. Clean
    // descriptions (every built-in) return byte-identical, so selection is
    // unaffected.
    return capped.map((tool) => {
      const model = toModelTool(tool);
      const safe = neutralizeInjectionSpans(model.description);
      return safe === model.description ? model : { ...model, description: safe };
    });
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

  private modelLoopRunner(compactionOccurred?: boolean, retryBudget?: RetryBudget): ModelLoopRunner {
    return {
      ...(compactionOccurred ? { compactionOccurred } : {}),
      executeToolCall: (context, toolCall, activeTools) => this.executeToolCall(context, toolCall, activeTools),
      generateWithTracing: (context, provider, request) => this.generateWithTracing(context, provider, request, retryBudget),
      prepareContextAdmittedRequest: (provider, request) => prepareContextAdmittedRequest(this.contextWindow, provider, request),
      maxRunWallclockMs: this.maxRunWallclockMs,
      ...(this.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: this.streamIdleTimeoutMs } : {}),
      ...(this.heartbeat ? { heartbeat: this.heartbeat } : {}),
      maxToolCalls: this.maxToolCalls,
      ...(retryBudget ? { retryBudget } : {}),
      maxToolOutputChars: this.maxToolOutputChars,
      ...(this.toolCallMiddleware ? { toolCallMiddleware: this.toolCallMiddleware } : {}),
      ...(this.planCacheProvider ? { planCacheProvider: this.planCacheProvider } : {}),
      ...(this.contextReferenceStore ? { contextReferenceStore: this.contextReferenceStore } : {}),
      metrics: this.metrics,
      tokenUsageSink: this.tokenUsageSink,
      ...(this.checkpointStore ? { checkpointStore: this.checkpointStore } : {}),
      tracer: this.tracer
    };
  }


  private async executeToolCall(
    context: AgentRunContext,
    proposedToolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ): Promise<ExecutedToolResult> {
    return executeToolCallGated(
      {
        afterTool: (ctx, executed) => this.invokeHooks("afterTool", ctx, executed),
        beforeTool: (ctx, call) => this.invokeHooks("beforeTool", ctx, call),
        resolveToolRisk: (name) => this.resolveToolRisk(name),
        runToolPlanTool: (ctx, call, tools) => this.runToolPlanTool(ctx, call, tools),
        ...(this.toolApprovalGate ? { toolApprovalGate: this.toolApprovalGate } : {}),
        ...(this.toolExecutor ? { toolExecutor: this.toolExecutor } : {}),
        ...(this.toolOpportunityObserver ? { toolOpportunityObserver: this.toolOpportunityObserver } : {}),
        toolOpportunityObserverTimeoutMs: this.toolOpportunityObserverTimeoutMs
      },
      context,
      proposedToolCall,
      activeTools
    );
  }

  private async generateWithTracing(
    context: AgentRunContext,
    provider: ModelProvider,
    request: ModelRequest,
    retryBudget?: RetryBudget
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
      ...(retryBudget ? { retryBudget } : {}),
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
