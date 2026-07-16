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
import type { CircuitBreaker, FallbackStrategy, RetryOptions } from "@muse/resilience";
import type {
  AgentRunHistoryStore,
  CheckpointStore,
  HookTraceStore
} from "@muse/runtime-state";
import {
  COMPACTION_SUMMARY_PREFIX,
  DEFAULT_CHUNK_MAX_CHARS,
  summarizeDroppedContextInStages,
  trimConversationMessages,
  verifyCompactionSummaryQuality,
  type ContextReferenceStore,
  type ConversationSummaryStore,
  type ConversationTrimOptions,
  type DroppedContextSummarizer
} from "@muse/memory";
import {
  resolveToolExposureAuthority,
  selectToolNamesForExposureAuthority,
  type GuardBlockRateMonitor
} from "@muse/policy";
import { createRunId, errorMessage, type JsonObject } from "@muse/shared";
import {
  ToolExecutor,
  ToolRegistry,
  authorizeEgressForValue,
  coerceToolArguments,
  coerceEnumArguments,
  collectNonUrlStringLeaves,
  createEgressAuthority,
  nearestToolName,
  toModelTool,
  validateRequiredToolArguments,
  type EgressAuthority,
  type ToolExecutionResult,
  type ToolExposurePolicy
} from "@muse/tools";

import type { ActiveContextProvider, ActiveContextSnapshot } from "./active-context.js";
import { applyAttachmentContext as applyAttachmentContextFn } from "./attachment-context.js";
import { joinUserMessages } from "./internals.js";
import {
  checkActuatorProvenance,
  describeProvenanceExfil,
  describeProvenanceTaint,
  sharesPrivateSpan,
  EXECUTE_SINK_ARG_NAMES,
  isFirstPartyReadTool,
  OUTBOUND_SEND_SINK_ARG_NAMES,
  WRITE_SINK_ARG_NAMES,
  OUTBOUND_SEND_TOOL_NAMES
} from "./actuator-provenance-gate.js";
import { createTaintLedger } from "./taint-ledger.js";
import { groundToolArguments } from "./tool-argument-grounding.js";
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
  UserMemoryProvider,
  UserModelComposer
} from "./types.js";
import type {
  AgentRuntimeOptions,
  AgentRuntimeStreamEvent,
  EgressAdvisorySink,
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
  EgressAdvisory,
  EgressAdvisorySink,
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

function normalizeExemplarCount(value: number | undefined): number {
  const defaultCount = 3;
  const maximumCount = 10;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximumCount
    ? value
    : defaultCount;
}

/** The single PTC orchestrator tool name (defined as a MuseTool in `@muse/tools`). */
const RUN_TOOL_PLAN_TOOL_NAME = "run_tool_plan";

/**
 * Seed the run's egress authority from the FULLY ASSEMBLED transcript (after
 * `prepareInvocation`, so the system message already carries recall/notes/
 * calendar — the taint ledger never saw that, but egress needs it as a
 * TRUSTED source per S5). Only `user`/`system` roles feed trusted-observed
 * URLs directly; a `tool` message feeds trusted ONLY when it came from a
 * first-party store (mirrors the taint ledger's own first-party split), else
 * untrusted-observed. `assistant` content is NEVER scanned — an authorizing
 * role must never be the model's own prose, or it could compose a URL in
 * turn 1 and "quote" it in turn 2 (self-laundering). Called on every run
 * (including a 2nd+ turn, since a fresh `run()` gets a fresh, re-seeded
 * authority) so history carries forward correctly without special-casing.
 */
function seedEgressAuthorityFromMessages(
  egressAuthority: EgressAuthority | undefined,
  messages: readonly ModelMessage[]
): void {
  if (!egressAuthority) {
    return;
  }
  for (const message of messages) {
    if (message.role === "assistant") {
      continue;
    }
    if (message.role === "tool" && !isFirstPartyReadTool(message.name ?? "")) {
      egressAuthority.recordUntrustedText(message.content);
      continue;
    }
    egressAuthority.recordTrustedText(message.content);
  }
}

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
        ? await executePlanExecuteLoopFn(this.modelLoopRunner(compactionOccurred), layeredContext, selected.provider, loopRequest)
        : await executeModelLoopFn(this.modelLoopRunner(compactionOccurred), layeredContext, selected.provider, loopRequest);
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
        const planStream = streamPlanExecuteFn(this.modelLoopRunner(compactionOccurred), layeredContext, selected.provider, streamLoopRequest);
        let next = await planStream.next();
        while (!next.done) {
          yield next.value;
          next = await planStream.next();
        }
        execution = next.value;
      } else {
        const stream = executeStreamingModelLoopFn(
          this.modelLoopRunner(compactionOccurred),
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
    let preparedRequest = this.prepareModelRequest(summaryAppliedContext.input, selected.model, personaSnapshot, activeContextSnapshot);
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

  private prepareModelRequest(
    input: AgentRunInput,
    model: string,
    personaSnapshot?: string,
    activeContextSnapshot?: ActiveContextSnapshot
  ): {
    readonly contextWindow?: AgentContextWindowReport;
    readonly dropped?: readonly ModelMessage[];
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
    // Also pipe the active task / focus from the
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
      dropped: trimResult.dropped,
      request: {
        messages: trimResult.messages,
        metadata: input.metadata,
        model
      }
    };
  }

  /**
   * Execute a parsed PTC {@link ToolPlan} where EVERY step runs through the SAME gated single-tool
   * path as a native tool call ({@link executeToolCall}: beforeTool hook → approval gate → arg
   * coercion/required/enum validation → arg grounding → executor → afterTool hook). It does not
   * bypass or re-implement a single gate — it binds the plan interpreter's pluggable executor seam
   * ({@link executeToolPlan}) to that method. A step whose gated call does not COMPLETE (denied,
   * invalid, or failed) throws {@link ToolPlanStepBlockedError}, which aborts the plan before any
   * later step runs, so a blocked step leaves no partial downstream effect. A 1-step plan is
   * therefore gate-equivalent to a single native tool call. Phase 2 scope is gated EXECUTION only;
   * grounding/citation of the plan's projected result is Phase 3.
   */
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
    const requestedAuthority = context.input.toolExposureAuthority;
    const authority = requestedAuthority === undefined
      ? {
          allowedToolNames: availableTools
            .filter((tool) => tool.definition.risk === "read" && !tool.definition.scopes?.includes("local"))
            .map((tool) => tool.definition.name),
          localMode: false
        }
      : resolveToolExposureAuthority(requestedAuthority);

    if (!authority) {
      return [];
    }

    const allowedToolNames = requestedAuthority === undefined
      ? authority.allowedToolNames
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
        localMode: authority.localMode,
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

  private modelLoopRunner(compactionOccurred?: boolean): ModelLoopRunner {
    return {
      ...(compactionOccurred ? { compactionOccurred } : {}),
      executeToolCall: (context, toolCall, activeTools) => this.executeToolCall(context, toolCall, activeTools),
      generateWithTracing: (context, provider, request) => this.generateWithTracing(context, provider, request),
      maxRunWallclockMs: this.maxRunWallclockMs,
      ...(this.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: this.streamIdleTimeoutMs } : {}),
      ...(this.heartbeat ? { heartbeat: this.heartbeat } : {}),
      maxToolCalls: this.maxToolCalls,
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

  /**
   * Provenance warning for an actuator call whose sink args derive from
   * untrusted tool output (the run's taint ledger) rather than the user's own
   * messages this run. Covers two actuator classes: OUTBOUND-SEND tools (sink =
   * recipient/subject/body/url) and EXECUTE-risk tools (sink = the command/code
   * payload) — a poisoned tool result must not silently supply a send's
   * recipient nor an RCE command. Execute-risk tools are already always gated,
   * so this only enriches that confirm. Returns `undefined` for read/write
   * non-send tools, when the ledger is empty/absent, or when no sink arg is
   * tainted — so ordinary calls carry no extra friction.
   */
  private actuatorProvenanceWarning(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    risk: "read" | "write" | "execute"
  ): string | undefined {
    const ledger = context.taintLedger;
    if (!ledger) {
      return undefined;
    }
    const isOutboundSend = OUTBOUND_SEND_TOOL_NAMES.includes(toolCall.name);
    const isExecute = risk === "execute";
    const isWrite = risk === "write";
    if (!isOutboundSend && !isExecute && !isWrite) {
      return undefined;
    }
    const sinkArgNames = [
      ...(isOutboundSend ? OUTBOUND_SEND_SINK_ARG_NAMES : []),
      ...(isExecute ? EXECUTE_SINK_ARG_NAMES : []),
      ...(isWrite ? WRITE_SINK_ARG_NAMES : [])
    ];
    // The write class — and ONLY it — trusts the user's own stores as an origin:
    // a task built from the user's own note is not third-party-derived, while a
    // send/execute keeps the strict user-messages-only haystack (a note can quote
    // a poisoned page; broadening there would weaken the higher-blast-radius
    // gates). Purely additive — no existing class changes behaviour.
    const trustedHaystack = isOutboundSend || isExecute
      ? joinUserMessages(context.input.messages)
      : `${joinUserMessages(context.input.messages)}\n${ledger.firstPartyHaystack()}`;
    const check = checkActuatorProvenance({
      args: toolCall.arguments ?? {},
      ledger,
      sinkArgNames,
      trustedHaystack,
      // The confidentiality axis applies to content LEAVING the box or being
      // executed — not to a write into the user's own stores (S3b already trusts
      // first-party content there, and warning that "your note contains your
      // note" would be noise).
      ...(isOutboundSend || isExecute ? { privateHaystack: ledger.firstPartyHaystack() } : {})
    });
    // Two DIFFERENT harms, and until now they read identically: a send built from
    // a poisoned web page and a send built from the user's own note both said
    // "traces to untrusted tool:X". That trains the user to click through the one
    // warning that matters. Name them separately — injection (third-party content
    // steering an action) and exfiltration (the user's private content leaving in
    // words they never typed).
    const notes: string[] = [];
    if (check.untrustedDerived) {
      notes.push(describeProvenanceTaint(check));
    }
    if (check.privateDerived) {
      notes.push(describeProvenanceExfil(check));
    }
    return notes.length > 0 ? notes.join(" · ") : undefined;
  }

  private async executeToolCall(
    context: AgentRunContext,
    toolCall: ModelToolCall,
    activeTools: readonly ModelTool[]
  ): Promise<ExecutedToolResult> {
    if (!activeTools.some((tool) => tool.name === toolCall.name)) {
      // A small model HALLUCINATES tool names (`node_run` for `run_command`); a
      // bare "not exposed" is a dead-end. Suggest the nearest ACTIVE tool by
      // token overlap so the next turn self-corrects (the executor's
      // not-registered path already does this — this is its not-EXPOSED sibling).
      const suggestion = nearestToolName(toolCall.name, activeTools.map((tool) => tool.name));
      // A small model sometimes emits a whole COMMAND LINE as the tool name
      // (`node --exec "…"`) — a name with whitespace is never a valid identifier,
      // and token-overlap won't match `run_command` (observed live in
      // eval:edit-run-verify). Point it at the active execute tool so it re-issues
      // the command through that tool's ARGUMENTS instead of as a bogus name.
      const commandShaped = !suggestion && /\s/u.test(toolCall.name.trim());
      const execTool = commandShaped ? activeTools.find((tool) => tool.risk === "execute") : undefined;
      const recovery = suggestion
        ? `. Did you mean '${suggestion}'? Call that exact name.`
        : execTool
          ? `. A tool name must be a single identifier, not a command line — to run a command, call '${execTool.name}' with the command in its arguments.`
          : "";
      const executed = blockedToolResult(
        toolCall,
        `Error: tool was not exposed to the model: ${toolCall.name}${recovery}`
      );
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    // PTC interception (run BEFORE this tool's own approval/grounding): run_tool_plan is an
    // orchestrator, not a leaf tool — its EXECUTE handler is a dead-end. Parse the plan, then run
    // every step through this same gated path (executeToolPlanGated → executeToolCall), and return
    // the PROJECTED result as a normal COMPLETED tool result so the model loop binds it as a
    // citable tool message (capToolOutput) and the grounding gate scores the final answer against
    // it. knownTools excludes run_tool_plan itself, so a nested PTC plan is an unknown-tool parse
    // error (no recursion). A parse error / blocked step becomes a normal blocked tool result —
    // never a throw that crashes the model loop.
    //
    // Budget invariant: a run_tool_plan call costs exactly ONE tool-call budget slot no matter how
    // many steps its plan runs — programmatic tool calling is one budget action, not N. The model
    // loop's toolCallCount is advanced once, for this single call, before this method ever runs; the
    // plan's steps execute inside runToolPlanTool below and never re-enter the loop's counter.
    if (toolCall.name === RUN_TOOL_PLAN_TOOL_NAME) {
      return this.runToolPlanTool(context, toolCall, activeTools);
    }

    await this.invokeHooks("beforeTool", context, toolCall);

    // Injection-provenance gate (outbound-send OR execute class): if this
    // actuator's sink args (a send's to/subject/body/url, or an execute tool's
    // command/code payload) carry content that traces to UNTRUSTED tool output
    // and NOT to the user's own message, the call must not proceed silently — a
    // poisoned tool result must never supply a send's recipient nor an RCE
    // command on the agent's own judgement (outbound-safety.md, FIDES-style
    // taint gate arXiv:2505.23643). The warning is threaded INTO the single
    // approval confirm below (no second prompt); with no confirm path at all it
    // fail-closes. Execute-risk tools are already always gated, so this enriches
    // that existing confirm. `risk` is resolved once here so both the warning
    // and the gate call use it — computed BEFORE the gate.
    const risk = this.resolveToolRisk(toolCall.name);
    const provenanceWarning = this.actuatorProvenanceWarning(context, toolCall, risk);
    // Egress authorization (S5): detect a sink by ARG VALUE SHAPE (every string
    // leaf, objects/arrays included) — never by tool name/risk, since an
    // external MCP server names and risk-classes itself. `undefined` means no
    // http(s)/ws(s) URL anywhere in this call's args — byte-identical to
    // today. This runs for READ-risk calls too: that is the whole point — a
    // read-class fetch/browser tool is exactly the exfil sink this closes.
    const egressDecision = context.egressAuthority
      ? authorizeEgressForValue(toolCall.arguments ?? {}, context.egressAuthority)
      : undefined;
    const egressBlocked = egressDecision?.decision === "deny";
    const egressUserId = metadataString(context.input.metadata, "userId");
    // Audit trail (fire-and-record, never gates): "allow" is a trusted-typed
    // fetch and stays silent (logging every ordinary fetch would be noise —
    // testing.md AC17's byte-identical-on-no-URL contract extends to this).
    // "confirm"/"deny" get NO other durable record anywhere else today, so
    // this is the one place either surfaces. Runs regardless of what the
    // approval gate below decides — a gate isn't required for read-risk
    // calls, so this can't be folded into that block.
    if (egressDecision && egressDecision.decision !== "allow" && context.egressAdvisorySink) {
      try {
        await context.egressAdvisorySink({
          decision: egressDecision.decision,
          reason: egressDecision.reason,
          runId: context.runId,
          toolName: toolCall.name,
          url: egressDecision.url,
          ...(egressUserId ? { userId: egressUserId } : {})
        });
      } catch {
        // Fail-soft: an audit sink must never crash or block the run.
      }
    }
    // Confidentiality axis (S5 follow-up, fire-1 redo): the URL rule above only
    // inspects URL leaves, so a private phrase placed in a NON-URL leaf of this
    // SAME egress-candidate call (a header value, a form field) is invisible to
    // it. `egressDecision` truthy already means this call carries a URL — i.e.
    // it IS a network call; a pure non-network call never reaches here. Fire-
    // and-record only, same sink, never blocks — the URL rule alone owns
    // allow/confirm/deny.
    if (egressDecision && context.egressAdvisorySink) {
      const privateHaystack = context.taintLedger?.firstPartyHaystack() ?? "";
      if (privateHaystack.trim().length > 0) {
        const typedHaystack = joinUserMessages(context.input.messages);
        const leaves = collectNonUrlStringLeaves(toolCall.arguments ?? {});
        const flagged = leaves.find((leaf) => sharesPrivateSpan(leaf.text, privateHaystack, typedHaystack));
        if (flagged) {
          try {
            await context.egressAdvisorySink({
              decision: "confidentiality",
              reason: `\`${flagged.path}\` carries content from your own notes/records that you did not type in this message`,
              runId: context.runId,
              toolName: toolCall.name,
              ...(egressUserId ? { userId: egressUserId } : {})
            });
          } catch {
            // Fail-soft: an audit sink must never crash or block the run.
          }
        }
      }
    }

    const approvalGate = context.input.toolApprovalGate ?? this.toolApprovalGate;
    if (risk !== "read" && !approvalGate) {
      const executed = blockedToolResult(
        toolCall,
        "Error: non-read tool call requires an approval gate"
      );
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    if (approvalGate) {
      let decision: ToolApprovalGateDecision;
      try {
        decision = await approvalGate({
          risk,
          runId: context.runId,
          toolCall,
          userId: egressUserId,
          ...(provenanceWarning ? { provenanceWarning } : {}),
          ...(egressDecision && egressDecision.decision !== "allow" ? { egressWarning: egressDecision.reason, egressBlocked } : {})
        });
      } catch (error) {
        // Fail-close: a throwing gate (e.g. a corrupt
        // ~/.muse/trust.json, the gate's data source) must BLOCK
        // the tool, never crash the run or let the call through.
        decision = {
          allowed: false,
          reason: `approval gate error: ${errorMessage(error)}`
        };
      }
      // Runtime-enforced hard deny: an egress "deny" is authoritative
      // regardless of what the surface gate returned. A gate that blindly
      // trusts risk === "read" (the CLI's silent-read shape, or any future
      // surface with the same shape) must never launder a model-composed URL
      // into an HTTP call — the ONE chokepoint every surface shares is here,
      // in the runtime, not re-implemented per surface.
      if (egressBlocked) {
        decision = { allowed: false, reason: `egress denied: ${egressDecision!.reason}` };
      }
      if (!decision.allowed) {
        const reason = decision.reason ?? "tool call rejected by approval gate";
        const executed = blockedToolResult(toolCall, `Error: ${reason}`);
        await this.invokeHooks("afterTool", context, executed);
        return executed;
      }
    } else if (provenanceWarning || egressBlocked) {
      // A tainted actuator call (or an egress-denied one) with NO approval
      // gate has no confirm to route to — fail-close, never a silent send,
      // execute, or fetch. An egress "confirm" (link-following under the
      // fan-out cap) is NOT fail-closed here: a read tool with no approval
      // gate at all already runs silently today (nothing to route a confirm
      // to either), and "confirm" is by definition an OBSERVED source, not a
      // model-composed one.
      const reason = egressBlocked ? `egress denied: ${egressDecision!.reason}` : provenanceWarning;
      const executed = blockedToolResult(
        toolCall,
        `Error: actuator call blocked (injection-provenance): ${reason}. Confirm this content explicitly before proceeding.`
      );
      await this.invokeHooks("afterTool", context, executed);
      return executed;
    }

    // Deterministic arg repair + validation (tool-calling.md): first losslessly
    // coerce a right-value/wrong-type arg to the schema's type ("5" → 5), then
    // check required. A missing required arg returns the missing list so the
    // model re-calls correctly (bounded by maxToolCalls) — never execute with
    // bad args.
    const exposed = activeTools.find((tool) => tool.name === toolCall.name);
    const coercedArguments = coerceEnumArguments(
      exposed?.inputSchema,
      coerceToolArguments(exposed?.inputSchema, toolCall.arguments)
    );
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

/**
 * Forward an agent run's opt-in logprobs request onto the ModelRequest. Absent
 * → `{}` so the wire is byte-identical to before (no `logprobs` field). Pulled
 * out + structurally typed so both the generate and stream seams stay in sync.
 */
function logprobsFromInput(
  input: { readonly logprobs?: boolean; readonly topLogprobs?: number }
): { logprobs?: true; topLogprobs?: number } {
  if (!input.logprobs) {
    return {};
  }
  return {
    logprobs: true,
    ...(input.topLogprobs !== undefined ? { topLogprobs: input.topLogprobs } : {})
  };
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new AgentRuntime(options);
}

/**
 * Append an auxiliary-model dropped-context summary to the
 * deterministic `[Conversation summary …]` system message, preserving the
 * deterministic floor (the `[Key details]`/pinned-entity blocks). Returns
 * the array unchanged when `aux` is blank or no compaction-summary message
 * is present (e.g. a turn that didn't compact). Pure.
 */
export function augmentCompactionSummary(
  messages: readonly ModelMessage[],
  aux: string
): readonly ModelMessage[] {
  const trimmed = aux.trim();
  if (trimmed.length === 0) {
    return messages;
  }
  const idx = messages.findIndex(
    (message) =>
      message.role === "system" &&
      typeof message.content === "string" &&
      message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
  );
  if (idx === -1) {
    return messages;
  }
  const target = messages[idx]!;
  const augmented = { ...target, content: `${target.content}\n[Dropped-context summary: ${trimmed}]` };
  return messages.map((message, i) => (i === idx ? augmented : message));
}
