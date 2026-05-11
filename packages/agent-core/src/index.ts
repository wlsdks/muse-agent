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
  recordCheckpoint,
  recordRunComplete,
  recordRunFailure,
  recordRunStart
} from "./lifecycle.js";
import { invokeHooks } from "./hook-orchestration.js";
import { invokeModel } from "./model-invocation.js";
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
import {
  isPlanExecuteMode,
  type PlanStep
} from "./plan-execute.js";
import {
  executePlanExecuteLoop as executePlanExecuteLoopFn,
  streamPlanExecute as streamPlanExecuteFn
} from "./plan-execute-loop.js";
import {
  applyActiveContext as applyActiveContextFn,
  applyAgentSpec as applyAgentSpecFn,
  applyEpisodicRecall as applyEpisodicRecallFn,
  applyInboxContext as applyInboxContextFn,
  applyPromptExemplars as applyPromptExemplarsFn,
  applyPromptLayers as applyPromptLayersFn,
  applyStoredConversationSummary as applyStoredConversationSummaryFn,
  applyUserMemory as applyUserMemoryFn,
  persistConversationSummaryFromRequest as persistConversationSummaryFromRequestFn,
  resolveActiveContextSnapshot as resolveActiveContextSnapshotFn
} from "./context-transforms.js";
import type { ActiveContextProvider, ActiveContextSnapshot } from "./active-context.js";
import { applyAttachmentContext as applyAttachmentContextFn } from "./attachment-context.js";
import { applySkillsContext as applySkillsContextFn, type SkillCatalogProvider } from "./skills-context.js";
import { measureSystemPromptBudget, promptBudgetSpanAttributes } from "./prompt-budget.js";
import type { TelemetryAggregator } from "./telemetry-aggregator.js";
import type { InboxContextProvider } from "./inbox-context.js";
import type { EpisodicRecallProvider } from "./episodic-recall.js";
import type { ToolFilter } from "./tool-filter.js";
import {
  executeModelLoop as executeModelLoopFn,
  executeStreamingModelLoop as executeStreamingModelLoopFn,
  type ModelLoopRunner
} from "./model-loop.js";
import {
  applyOutputGuards as applyOutputGuardsFn,
  applyResponseFilters as applyResponseFiltersFn,
  evaluateGuards as evaluateGuardsFn
} from "./guard-pipeline.js";
import { ModelRoutingError } from "./errors.js";
import {
  ToolExecutor,
  ToolRegistry,
  toModelTool,
  type ToolExecutionResult,
  type ToolExposurePolicy
} from "@muse/tools";

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
  UserMemoryInjectionOptions,
  UserMemoryProvider
} from "./types.js";

export type {
  AgentContextWindowReport,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentSpecResolver,
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
  UserMemoryInjectionOptions,
  UserMemoryProvider,
  UserMemorySnapshot,
  VerifiedSource
} from "./types.js";

// Context Engineering surfaces (Phases 1–4)
export {
  DefaultActiveContextProvider,
  renderActiveContextSection,
  type ActiveContextProvider,
  type ActiveContextResolveOptions,
  type ActiveContextSnapshot,
  type ActiveTaskHint,
  type ActiveTaskResolver,
  type CalendarEventHint,
  type CalendarEventsResolver,
  type DefaultActiveContextProviderOptions,
  type ReminderHint,
  type RemindersResolver
} from "./active-context.js";
export {
  formatCurrentTime,
  humanizeRelativeFromIso,
  humanizeRelativeMs,
  isWorkingHours,
  parseWorkingHoursString,
  resolveTimezone,
  type FormattedTime
} from "./time-helpers.js";
export {
  renderInboxSection,
  type InboundSummary,
  type InboxContextProvider,
  type InboxSnapshot
} from "./inbox-context.js";
export {
  InMemoryEpisodicRecallProvider,
  renderEpisodicSection,
  StoreBackedEpisodicRecallProvider,
  type EpisodicMatch,
  type EpisodicRecallProvider,
  type EpisodicRecallSnapshot,
  type InMemoryEpisodicRecallProviderOptions,
  type StoreBackedEpisodicRecallProviderOptions,
  type StoredEpisode,
  type SummaryListSource
} from "./episodic-recall.js";
export {
  DefaultToolFilter,
  DEFAULT_DOMAIN_KEYWORDS,
  inferDomain,
  type ToolFilter,
  type ToolFilterContext
} from "./tool-filter.js";
export {
  applyAttachmentContext,
  parseAttachmentsFromMetadata,
  renderAttachmentSection,
  type AttachmentHint
} from "./attachment-context.js";
export {
  applySkillsContext,
  renderSkillsCatalogSection,
  type SkillCatalogEntry,
  type SkillCatalogProvider
} from "./skills-context.js";
export {
  measureSystemPromptBudget,
  measureSystemPromptText,
  promptBudgetSpanAttributes,
  type PromptBudgetReport,
  type PromptBudgetSection
} from "./prompt-budget.js";
export {
  InMemoryTelemetryAggregator,
  type InMemoryTelemetryAggregatorOptions,
  type RunTelemetryEvent,
  type TelemetryAggregator,
  type TelemetryRecentOptions,
  type TelemetrySummary,
  type TelemetrySummaryOptions
} from "./telemetry-aggregator.js";


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
  readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  readonly toolRegistry?: ToolRegistry;
  readonly toolExecutor?: ToolExecutor;
  readonly toolExposurePolicy?: ToolExposurePolicy;
  readonly maxToolCalls?: number;
  /**
   * Per-tool-result character cap (Context Engineering step 1.b,
   * round 161). When set and a tool returns more than `maxChars`
   * characters, the message-bound copy is truncated head+tail with
   * an explicit elision marker so the agent sees the truncation
   * rather than guessing why the result looks short. The original
   * result on traces / metrics stays intact. 0 or undefined = no
   * cap (legacy behavior).
   */
  readonly maxToolOutputChars?: number;
  /**
   * Optional ContextReferenceStore for just-in-time retrieval
   * (Context Engineering step 1.d, round 168). When provided AND a
   * tool result triggers truncation, the full original output is
   * stashed in the store under a sha256-prefix id and the
   * truncation marker surfaces `ref=<id>` so the agent can call
   * `muse.context.fetch({ ref })` to expand on demand. Same
   * content → same ref so repeated truncations dedupe. When
   * undefined, truncation behaves exactly as it did in round 161
   * (head+tail+marker, no ref).
   */
  readonly contextReferenceStore?: ContextReferenceStore;
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
  readonly conversationSummaryStore?: ConversationSummaryStore;
  readonly guards?: readonly GuardStage[];
  readonly hooks?: readonly HookStage[];
  readonly outputGuards?: readonly OutputGuardStage[];
  readonly responseFilters?: readonly ResponseFilterStage[];
  readonly exemplarRetriever?: ExemplarRetriever;
  readonly exemplarTopK?: number;
  readonly promptLayerRegistry?: PromptLayerRegistry;
  /**
   * Context Engineering Phase 1: pull current time / timezone /
   * working-hours / active task and inject as a `[Active Context]`
   * system-prompt block. Fail-open per transform.
   */
  readonly activeContextProvider?: ActiveContextProvider;
  /**
   * Context Engineering Phase 2: surface recent inbound messages
   * (Slack / Discord / Telegram / LINE) as a `[Recent Messages]`
   * system-prompt block.
   */
  readonly inboxContextProvider?: InboxContextProvider;
  /**
   * Context Engineering Phase 3: retrieve top-K prior session
   * summaries and inject as `[Episodic Memory]`.
   */
  readonly episodicRecallProvider?: EpisodicRecallProvider;
  /**
   * Context Engineering Phase 4: filter the tool catalog advertised
   * per request by user-prompt keywords + metadata scope hints.
   */
  readonly toolFilter?: ToolFilter;
  /**
   * SKILL.md catalog provider — surfaces an `[Available Skills]`
   * block listing registered external-CLI integrations.
   */
  readonly skillCatalogProvider?: SkillCatalogProvider;
  /**
   * Telemetry aggregator (phase A). When provided, the runtime
   * records one `RunTelemetryEvent` per successful run so the
   * operator can later query daily / weekly summaries via
   * `aggregator.summary()`.
   */
  readonly telemetryAggregator?: TelemetryAggregator;
  readonly defaults?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  };
}


export type AgentRuntimeStreamEvent =
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "text-delta" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "tool-call" }>)
  | { readonly runId: string; readonly toolCall: ModelToolCall; readonly type: "tool-result" }
  | { readonly plan: readonly PlanStep[]; readonly runId: string; readonly type: "plan-generated" }
  | {
      readonly description: string;
      readonly runId: string;
      readonly stepIndex: number;
      readonly tool: string;
      readonly type: "plan-step-executing";
    }
  | { readonly runId: string; readonly stepIndex: number; readonly success: boolean; readonly type: "plan-step-result" }
  | { readonly runId: string; readonly type: "synthesis-started" }
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "done" }>)
  | ({ readonly runId: string } & Extract<ModelEvent, { readonly type: "error" }>);

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
  private readonly guardBlockRateMonitor?: GuardBlockRateMonitor;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly toolExposurePolicy?: ToolExposurePolicy;
  private readonly maxToolCalls: number;
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
  private readonly inboxContextProvider?: InboxContextProvider;
  private readonly episodicRecallProvider?: EpisodicRecallProvider;
  private readonly toolFilter?: ToolFilter;
  private readonly skillCatalogProvider?: SkillCatalogProvider;
  private readonly telemetryAggregator?: TelemetryAggregator;
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
    this.maxToolCalls = Math.max(0, options.maxToolCalls ?? 10);
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
    this.inboxContextProvider = options.inboxContextProvider;
    this.episodicRecallProvider = options.episodicRecallProvider;
    this.toolFilter = options.toolFilter;
    this.skillCatalogProvider = options.skillCatalogProvider;
    this.telemetryAggregator = options.telemetryAggregator;
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
      const memoryAppliedContext: AgentRunContext = { ...layeredContext, input: memoryAppliedInput };
      const activeContextSnapshot = await resolveActiveContextSnapshotFn(memoryAppliedContext, this.activeContextProvider);
      const activeContextInput = applyActiveContextFn(memoryAppliedContext, activeContextSnapshot);
      const attachmentAppliedInput = applyAttachmentContextFn({ ...memoryAppliedContext, input: activeContextInput });
      const skillsAppliedInput = await applySkillsContextFn({ ...memoryAppliedContext, input: attachmentAppliedInput }, this.skillCatalogProvider);
      const activeContextContext: AgentRunContext = { ...memoryAppliedContext, input: skillsAppliedInput };
      const inboxAppliedInput = await applyInboxContextFn(activeContextContext, this.inboxContextProvider);
      const inboxAppliedContext: AgentRunContext = { ...activeContextContext, input: inboxAppliedInput };
      const episodicAppliedInput = await applyEpisodicRecallFn(inboxAppliedContext, this.episodicRecallProvider);
      const episodicAppliedContext: AgentRunContext = { ...inboxAppliedContext, input: episodicAppliedInput };
      const summaryAppliedInput = await applyStoredConversationSummaryFn(episodicAppliedContext, this.conversationSummaryStore);
      const summaryAppliedContext: AgentRunContext = { ...episodicAppliedContext, input: summaryAppliedInput };
      // Round 160: resolve the persona snapshot once per request and
      // forward to the trim layer so a compaction during this turn
      // re-injects user-context inside the [User context: ...] block.
      const personaSnapshot = await resolvePersonaSnapshotFn(
        summaryAppliedContext.input,
        this.userMemoryProvider,
        this.userMemoryMaxEntries
      );
      const preparedRequest = this.prepareModelRequest(summaryAppliedContext.input, selected.model, personaSnapshot, activeContextSnapshot);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      recordContextEngineeringSpanAttributes(runSpan, summaryAppliedContext.input.metadata);
      const promptBudget = measureSystemPromptBudget(preparedRequest.request.messages);
      if (promptBudget) {
        recordPromptBudgetSpanAttributes(runSpan, promptBudgetSpanAttributes(promptBudget));
      }
      const tools = this.modelTools(layeredContext);
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await applyResponseFiltersFn(layeredContext, cachedResponse, this.responseFilters, this.tracer, {
          toolInsights: [],
          toolsUsed: cached.toolsUsed,
          verifiedSources: []
        });
        const guardedCachedResponse = await applyOutputGuardsFn(layeredContext, filteredCachedResponse, this.outputGuards, this.tracer, this.metrics);

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
        ? await executePlanExecuteLoopFn(this.modelLoopRunner(), layeredContext, selected.provider, loopRequest)
        : await executeModelLoopFn(this.modelLoopRunner(), layeredContext, selected.provider, loopRequest);
      const filteredResponse = await applyResponseFiltersFn(
        layeredContext,
        execution.finalResponse,
        this.responseFilters,
        this.tracer,
        responseFilterEvidenceFromExecution(execution)
      );
      const guardedResponse = await applyOutputGuardsFn(layeredContext, filteredResponse, this.outputGuards, this.tracer, this.metrics);

      await this.recordRunComplete(layeredContext, { ...execution, finalResponse: guardedResponse });
      await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, guardedResponse.output);
      await this.writeCache(cacheKey, guardedResponse, execution.toolsUsed);
      if (preparedRequest.contextWindow?.summaryInserted) {
        await persistConversationSummaryFromRequestFn(
          layeredContext,
          preparedRequest.request,
          summaryAppliedContext.input.messages.length,
          this.conversationSummaryStore
        );
      }
      await this.invokeHooks("afterComplete", layeredContext, guardedResponse);
      this.recordAgentRun(layeredContext, guardedResponse.model, "completed", startedAtMs);
      // Iter 48: stamp wall-clock run latency on the trace span too,
      // not just into the in-process telemetry aggregator. Lets a
      // trace-store consumer correlate latency with the same
      // ctx.* span attrs without going through a separate query.
      runSpan.setAttribute("run.latency_ms", Date.now() - startedAtMs);
      this.recordTelemetry(layeredContext, selected.provider.id, selected.model, guardedResponse, promptBudget, startedAtMs);
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
      const memoryAppliedContext: AgentRunContext = { ...layeredContext, input: memoryAppliedInput };
      const activeContextSnapshot = await resolveActiveContextSnapshotFn(memoryAppliedContext, this.activeContextProvider);
      const activeContextInput = applyActiveContextFn(memoryAppliedContext, activeContextSnapshot);
      const attachmentAppliedInput = applyAttachmentContextFn({ ...memoryAppliedContext, input: activeContextInput });
      const skillsAppliedInput = await applySkillsContextFn({ ...memoryAppliedContext, input: attachmentAppliedInput }, this.skillCatalogProvider);
      const activeContextContext: AgentRunContext = { ...memoryAppliedContext, input: skillsAppliedInput };
      const inboxAppliedInput = await applyInboxContextFn(activeContextContext, this.inboxContextProvider);
      const inboxAppliedContext: AgentRunContext = { ...activeContextContext, input: inboxAppliedInput };
      const episodicAppliedInput = await applyEpisodicRecallFn(inboxAppliedContext, this.episodicRecallProvider);
      const episodicAppliedContext: AgentRunContext = { ...inboxAppliedContext, input: episodicAppliedInput };
      const summaryAppliedInput = await applyStoredConversationSummaryFn(episodicAppliedContext, this.conversationSummaryStore);
      const summaryAppliedContext: AgentRunContext = { ...episodicAppliedContext, input: summaryAppliedInput };
      // Round 160: resolve the persona snapshot once per request and
      // forward to the trim layer so a compaction during this turn
      // re-injects user-context inside the [User context: ...] block.
      const personaSnapshot = await resolvePersonaSnapshotFn(
        summaryAppliedContext.input,
        this.userMemoryProvider,
        this.userMemoryMaxEntries
      );
      const preparedRequest = this.prepareModelRequest(summaryAppliedContext.input, selected.model, personaSnapshot, activeContextSnapshot);
      recordContextWindowSpanAttributes(runSpan, preparedRequest.contextWindow);
      recordContextEngineeringSpanAttributes(runSpan, summaryAppliedContext.input.metadata);
      const promptBudget = measureSystemPromptBudget(preparedRequest.request.messages);
      if (promptBudget) {
        recordPromptBudgetSpanAttributes(runSpan, promptBudgetSpanAttributes(promptBudget));
      }
      const tools = this.modelTools(layeredContext);
      const cacheKey = buildCacheKey(cacheableModelRequest(preparedRequest.request), tools.map((tool) => tool.name));
      const cached = await this.readCache(cacheKey, selected.model);

      if (cached) {
        const cachedResponse: ModelResponse = {
          id: `${context.runId}:cache`,
          model: cached.model ?? selected.model,
          output: cached.content
        };
        const filteredCachedResponse = await applyResponseFiltersFn(layeredContext, cachedResponse, this.responseFilters, this.tracer, {
          toolInsights: [],
          toolsUsed: cached.toolsUsed,
          verifiedSources: []
        });
        const guardedCachedResponse = await applyOutputGuardsFn(layeredContext, filteredCachedResponse, this.outputGuards, this.tracer, this.metrics);

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
      const filteredResponse = await applyResponseFiltersFn(
        layeredContext,
        execution.finalResponse,
        this.responseFilters,
        this.tracer,
        responseFilterEvidenceFromExecution(execution)
      );
      const response = await applyOutputGuardsFn(layeredContext, filteredResponse, this.outputGuards, this.tracer, this.metrics);
      await this.recordRunComplete(layeredContext, {
        ...execution,
        finalResponse: response
      });
      await this.recordCheckpoint(layeredContext, 100, "complete", layeredContext.input.messages, response.output);
      await this.writeCache(cacheKey, response, execution.toolsUsed);
      if (preparedRequest.contextWindow?.summaryInserted) {
        await persistConversationSummaryFromRequestFn(
          layeredContext,
          preparedRequest.request,
          summaryAppliedContext.input.messages.length,
          this.conversationSummaryStore
        );
      }
      await this.invokeHooks("afterComplete", layeredContext, response);
      this.recordAgentRun(layeredContext, response.model, "completed", startedAtMs);
      // Iter 48 — wall-clock run latency on the trace span (same as
      // the `run` path).
      runSpan.setAttribute("run.latency_ms", Date.now() - startedAtMs);
      this.recordTelemetry(layeredContext, selected.provider.id, selected.model, response, promptBudget, startedAtMs);
      if ((!forwardTextDeltas || isPlanExecuteRun) && response.output.length > 0) {
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
    // block when the trim fires (round 159 primitive). When unset
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
    const tools = this.toolRegistry
      .planForContext({
        allowedToolNames: stringListMetadata(context.input.metadata?.allowedToolNames),
        forbiddenToolNames: stringListMetadata(context.input.metadata?.forbiddenToolNames),
        localMode: context.input.metadata?.localMode === true,
        maxTools: numberMetadata(context.input.metadata?.maxTools),
        prompt: userMessage,
        recentToolNames: stringListMetadata(context.input.metadata?.recentToolNames)
      }, this.toolExposurePolicy)
      .tools;

    const filtered = this.toolFilter
      ? this.toolFilter.filter(tools, {
          recentToolNames: stringListMetadata(context.input.metadata?.recentToolNames),
          scopeHints: stringListMetadata(context.input.metadata?.toolScopes),
          userMessage
        })
      : tools;

    return filtered.map((tool) => toModelTool(tool));
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

  private modelLoopRunner(): ModelLoopRunner {
    return {
      executeToolCall: (context, toolCall, activeTools) => this.executeToolCall(context, toolCall, activeTools),
      generateWithTracing: (context, provider, request) => this.generateWithTracing(context, provider, request),
      maxToolCalls: this.maxToolCalls,
      maxToolOutputChars: this.maxToolOutputChars,
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

    if (!this.toolExecutor) {
      const executed = blockedToolResult(toolCall, "Error: tool executor is not configured");
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    const result = await this.toolExecutor.execute({
      arguments: toolCall.arguments,
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





export {
  createInjectionInputGuard,
  createLlmClassificationInputGuard,
  createPiiInputGuard,
  createPiiMaskingOutputGuard,
  createSystemPromptLeakageOutputGuard,
  createTopicDriftInputGuard
} from "./guards.js";

export {
  createCasualLureStripResponseFilter,
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createGreetingStripResponseFilter,
  createMarkdownStripResponseFilter,
  createMaxLengthResponseFilter,
  createResponseCountConsistencyFilter,
  createResponseCountInjectionFilter,
  createSanitizedTextResponseFilter,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  createToolResultQualityAuditFilter,
  createVerifiedSourcesResponseFilter,
  createZeroResultOverclaimResponseFilter
} from "./response-filters.js";


