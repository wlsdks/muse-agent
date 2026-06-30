import { CalendarProviderRegistry } from "@muse/calendar";
import {
  createAgentRuntime,
  createFollowupCaptureHook,
  createModelDroppedContextSummarizer,
  InMemoryAgentInitiatedNoticeBroker,
  type ActiveContextProvider,
  type AgentInitiatedNoticeBroker,
  type AgentRuntime,
  type CapturedFollowup,
  type HookStage
} from "@muse/agent-core";
import {
  DEFAULT_AGENT_SPECS,
  InMemoryAgentSpecRegistry,
  KyselyAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import type { MuseAuth } from "@muse/auth";
import {
  InMemoryCacheMetricsRecorder,
  InMemoryCacheStatsStore,
  InMemoryResponseCache
} from "@muse/cache";
import { createLoopbackMcpMuseTools, type LoopbackMcpServer, type McpManager, type McpTransportConnector, type McpSecurityPolicyProvider, type McpSecurityPolicyStore, type McpServerInput, type McpServerStore } from "@muse/mcp";
import { defaultSchedulerPauseFile, isSchedulerPaused, upsertFollowup, type PersistedFollowup } from "@muse/stores";
import { createContextReferenceMcpServer, createDefaultLoopbackMcpServers, createFetchMcpServer, createFilesystemMcpServer, type MessageApprovalGate, type NotesProviderRegistry, type TasksProviderRegistry } from "@muse/domain-tools";
import {
  createUserMemoryAutoExtractHook,
  defaultBeliefProvenanceFile,
  FileBeliefProvenanceStore,
  extractJsonObject,
  InMemoryContextReferenceStore,
  pickAutoExtractSystemPrompt,
  scaleToolOutputBudget,
  type ConversationSummaryStore,
  type ExtractionPayload,
  type TaskMemoryMaintenance,
  type TaskMemoryStore,
  type UserMemoryStore
} from "@muse/memory";
// Re-export the auto-extract helpers so downstream packages
// (apps/cli) can run user-memory extraction on chat turns without
// pulling @muse/memory directly.
export {
  extractJsonObject,
  pickAutoExtractSystemPrompt,
  type ExtractionPayload
};
import type { ModelProvider } from "@muse/model";
import {
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  createBudgetTrackingTokenUsageSink,
  createDerivedAgentMetrics,
  type AgentMetrics,
  type LatencyQuery,
  type MuseTracer,
  type QueryableTraceEventSink,
  type TokenCostQuery,
  type TokenUsageSink
} from "@muse/observability";

import { CircuitBreakerRegistry } from "@muse/resilience";
import { RuntimeSettings } from "@muse/runtime-settings";
import {
  FileCheckpointStore,
  type AgentRunHistoryStore,
  type DebugReplayCaptureStore,
  type HookTraceStore,
  type SessionTagStore
} from "@muse/runtime-state";
import {
  DynamicScheduler,
  NodeCronScheduler,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker,
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";
import {
  createMuseTools,
  ToolRegistry,
  type MuseTool
} from "@muse/tools";
import { VoiceProviderRegistry } from "@muse/voice";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseNonNegativeFloat,
  parseNonNegativeInteger,
  parsePositiveFloat,
  parseSloErrorRate
} from "./env-parsers.js";
import { createAuthService } from "./auth-wiring.js";
import { createResponseFilters } from "./response-filters.js";
import { createMessagingPollDispatchers } from "./messaging-poll-dispatchers.js";
import { createSkillRuntime } from "./skills-runtime.js";
import { buildLoopbackTools } from "./loopback-tools.js";
import { buildBackgroundReviewHooks } from "./context-engineering-builders.js";

import {
  buildActiveContextProvider,
  buildCalendarRegistry,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildMessagingRegistry,
  buildNotesRegistry,
  buildSkillCatalogProvider,
  buildTasksRegistry,
  buildTelemetryAggregator,
  buildToolFilter,
  buildVetoAvoidanceProvider,
  buildPlaybookProvider,
  buildPlanCacheProvider,
  buildToolExemplarBank,
  buildVoiceRegistry,
  ensureNotesDir,
  mergeModelKeysFromFile,
  resolveActionLogFile,
  resolveEpisodesFile,
  resolveFollowupLlmBudgetFile,
  resolveFollowupsFile,
  resolveNotesDir,
  resolvePatternsFiredFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveTasksFile,
  resolveTokenUsageFile,
  resolveCheckpointsDir
} from "./personal-providers.js";

export {
  buildActiveContextProvider,
  buildCalendarRegistry,
  buildSkillRegistry,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildMessagingRegistry,
  buildTelemetryAggregator,
  buildToolFilter,
  buildVoiceRegistry,
  mergeModelKeysFromFile,
  resolveContactsFile,
  resolveEpisodesFile,
  resolveNoteProvenanceFile,
  resolveFadedMemoriesFile,
  resolveFollowupsFile,
  resolvePatternsFiredFile,
  resolveRecallHitsFile,
  resolveCheckinsFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveNotesIndexFile,
  resolveActionLogFile,
  resolvePendingApprovalsFile,
  resolveObjectivesFile,
  resolveRemindersFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveWeaknessesFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTokenUsageFile,
  resolveCheckpointsDir,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveSuppressedLessonsFile,
  resolveLearningPauseFile,
  resolvePlanCacheFile,
  resolveAuthoredSkillsDir,
  resolveReflectionsFile,
  resolveSkillRewardsFile
} from "./personal-providers.js";
import {
  createConversationSummaryStore,
  createDebugReplayCaptureStore,
  createHistoryStore,
  createHookTraceStore,
  createRuntimeSettingsStore,
  createSchedulerExecutionStore,
  createSchedulerLock,
  createSchedulerStore,
  createSessionTagStore,
  createTaskMemoryStore,
  createTracingPipeline,
  createUserMemoryStore
} from "./store-factories.js";
import { createUsageRecordingProvider } from "./usage-recording-provider.js";
import { buildRuntimeToolRegistry } from "./runtime-tool-registry.js";
import {
  createBudgetedLlmDetector,
  createReviewCommitmentsArm,
  createReviewPreferencesArm,
  createReviewSkillArm
} from "./background-review-arms.js";
import { assembleMcpStack } from "./mcp-stack.js";
import {
  buildContextWindowOptions,
  createDefaultRuntimeHooks,
  createInputGuards,
  createOutputGuards,
  createPersonalToolExposurePolicy,
  createRunnerTools,
  createScheduledAgentExecutor
} from "./runtime-wiring.js";

export {
  collectSetupStatusJson,
  countNotes,
  evaluateLocalOnlyPosture,
  evaluateWebEgressStatus,
  readMcpEntryCount,
  readMessagingProviderState,
  readModelKeyState,
  readTaskCount,
  statBytes,
  type LocalOnlyStatusSnapshot,
  type SetupStatusSnapshot,
  type WebEgressStatusSnapshot
} from "./setup-status.js";

export {
  diagnoseExternalMcpConfig,
  diagnoseExternalMcpConfigFile,
  loadExternalMcpConfig,
  parseExternalMcpConfig,
  resolveExternalMcpConfigFile,
  seedExternalMcpServers
} from "./external-mcp-config.js";
export type { ExternalMcpEntryDiagnosis, ExternalMcpEntryStatus } from "./external-mcp-config.js";

export interface MuseEnvironment {
  readonly [key: string]: string | undefined;
}

export interface MuseRuntimeAssembly {
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly cache: {
    readonly metrics: InMemoryCacheMetricsRecorder;
    readonly responseCache: InMemoryResponseCache;
    readonly statsStore: InMemoryCacheStatsStore;
  };
  readonly defaultModel?: string;
  readonly historyStore: AgentRunHistoryStore;
  readonly hookTraceStore: HookTraceStore;
  readonly mcp: {
    readonly manager: McpManager;
    readonly securityPolicyProvider: McpSecurityPolicyProvider;
    readonly securityPolicyStore: McpSecurityPolicyStore;
    readonly serverStore: McpServerStore;
    /**
     * External MCP servers parsed from `~/.muse/mcp.json` (or the
     * path in `MUSE_MCP_CONFIG`). Empty when the file is absent.
     * Callers must `await seedExternalMcpServers(serverStore, ...)`
     * BEFORE `manager.start()` so the connector picks them up.
     */
    readonly externalServerInputs: readonly McpServerInput[];
  };
  readonly modelProvider?: ModelProvider;
  readonly debugReplayCaptureStore: DebugReplayCaptureStore;
  readonly conversationSummaryStore: ConversationSummaryStore;
  readonly sessionTagStore: SessionTagStore;
  readonly taskMemoryStore: TaskMemoryStore & TaskMemoryMaintenance;
  readonly userMemoryStore: UserMemoryStore;
  readonly observability: {
    readonly budgetTracker: MonthlyBudgetTracker;
    readonly driftDetector: PromptDriftDetector;
    readonly followupSuggestionStore: InMemoryFollowupSuggestionStore;
    readonly latencyQuery: LatencyQuery;
    readonly metrics: InMemoryAgentMetrics;
    readonly sloEvaluator: SloAlertEvaluator;
    readonly tokenCostQuery: TokenCostQuery;
    readonly tokenUsageSink: TokenUsageSink;
    readonly traceSink?: QueryableTraceEventSink;
    readonly tracer: MuseTracer;
  };
  readonly requireAuth: boolean;
  readonly resilience: {
    readonly circuitBreakerRegistry: CircuitBreakerRegistry;
  };
  readonly runtimeSettings: RuntimeSettings;
  readonly scheduler: {
    readonly executionStore: ScheduledJobExecutionStore;
    readonly service: DynamicScheduler;
    readonly store: ScheduledJobStore;
  };
  readonly toolRegistry: ToolRegistry;
  readonly calendar: CalendarProviderRegistry;
  readonly notesProviderRegistry?: NotesProviderRegistry;
  readonly tasksProviderRegistry?: TasksProviderRegistry;
  readonly voice?: VoiceProviderRegistry;
  /**
   * Context-Engineering Phase 1 provider. Same instance the
   * `agentRuntime` uses to compose its `[Active Context]` system
   * section, exposed on the assembly so the REST + CLI surfaces can
   * read the snapshot directly (e.g. `GET /api/active-context`).
   * `undefined` when `MUSE_ACTIVE_CONTEXT_ENABLED=false`.
   */
  readonly activeContextProvider?: ActiveContextProvider;
  /**
   * Phase D agent-initiated notice broker. The proactive-notice loop
   * (producer) publishes synthesised one-line responses here, and the
   * `GET /api/agent-notices/stream` SSE route fans them out to live
   * chat-stream subscribers. Always present — fail-soft no-op when
   * nobody subscribes.
   */
  readonly agentInitiatedNoticeBroker: AgentInitiatedNoticeBroker;
  readonly messaging?: MessagingProviderRegistry;
  /**
   * Shared poll-now dispatcher (same closure that backs the
   * `muse.messaging.poll_now` MCP tool). Exposed on the assembly so
   * the API server's REST surface can offer an on-demand pull
   * endpoint without rebuilding the per-provider plumbing.
   */
  readonly messagingPollNow?: (providerId: string, source?: string) => Promise<{ ingested: number }>;
  /**
   * Companion to `messagingPollNow`: pulls every wired provider in
   * one call (Telegram + each configured channel for Discord /
   * Slack). LINE is skipped. Returns per-provider ingestion counts
   * plus per-channel errors so a single bad channel doesn't black
   * out the rest. Backs both the `muse.messaging.poll_all` MCP tool
   * and the `POST /api/messaging/poll-all` REST endpoint.
   */
  readonly messagingPollAll?: () => Promise<{
    readonly ingestedByProvider: Readonly<Record<string, number>>;
    readonly errors: readonly { readonly providerId: string; readonly message: string }[];
  }>;
}

export interface ApiServerAssemblyOptions {
  readonly db?: Kysely<MuseDatabase>;
  readonly env?: MuseEnvironment;
  /**
   * Caller-supplied tools merged into the runtime registry. The CLI
   * uses this to inject surface-specific tools it builds with its own
   * confirmation gate (e.g. the `--actuators` email/web/home tools,
   * each carrying a clack confirm) — tools that must NOT live in the
   * shared, headless assembly because their gate is interactive.
   */
  readonly extraTools?: readonly MuseTool[];
  /** Override the MCP transport connector (test-only — inject a contract-faithful fake). */
  readonly mcpConnector?: McpTransportConnector;
  /**
   * Draft-first approval gate for the agent's `muse.messaging.send`. The CLI
   * passes a clack-confirm gate under `--actuators` so the agent's outbound
   * message is shown and confirmed before it leaves; absent (headless server /
   * daemon) the send fail-closes (never auto-sends — outbound-safety).
   */
  readonly messagingApprovalGate?: MessageApprovalGate;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function createMuseRuntimeAssembly(options: ApiServerAssemblyOptions = {}): MuseRuntimeAssembly {
  const env = mergeModelKeysFromFile(options.env ?? process.env);
  const db = options.db;
  const authService = createAuthService(env, db);
  // Seed default orchestration workers into a fresh in-memory registry so
  // `orchestrate` works out of the box (empty registry → NoAgentWorkerError).
  // DB-backed deployments are operator-managed — not auto-seeded. Opt out with
  // MUSE_MULTI_AGENT_DEFAULT_WORKERS=false (preserves the empty→409 path).
  const seedDefaultWorkers = parseBoolean(env.MUSE_MULTI_AGENT_DEFAULT_WORKERS, true);
  const agentSpecRegistry = db
    ? new KyselyAgentSpecRegistry(db)
    : new InMemoryAgentSpecRegistry(seedDefaultWorkers ? DEFAULT_AGENT_SPECS : []);
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
  const historyStore = createHistoryStore(db);
  const hookTraceStore = createHookTraceStore(db, env);
  const debugReplayCaptureStore = createDebugReplayCaptureStore(db);
  const cacheStatsStore = new InMemoryCacheStatsStore();
  const cacheMetrics = new InMemoryCacheMetricsRecorder(cacheStatsStore);
  const responseCache = new InMemoryResponseCache({
    maxSize: parseInteger(env.MUSE_CACHE_MAX_SIZE, 1_000),
    ttlMs: parseInteger(env.MUSE_CACHE_TTL_MS, 3_600_000)
  });
  const agentMetrics = new InMemoryAgentMetrics();
  const sloEvaluator = new SloAlertEvaluator({
    cooldownSeconds: parseInteger(env.MUSE_SLO_COOLDOWN_SECONDS, 300),
    errorRateThreshold: parseSloErrorRate(env.MUSE_SLO_ERROR_RATE_THRESHOLD, 0.1),
    latencyThresholdMs: parseInteger(env.MUSE_SLO_LATENCY_THRESHOLD_MS, 30_000),
    minSamples: parseInteger(env.MUSE_SLO_MIN_SAMPLES, 5),
    windowSeconds: parseInteger(env.MUSE_SLO_WINDOW_SECONDS, 300)
  });
  const driftDetector = new PromptDriftDetector({
    deviationThreshold: parsePositiveFloat(env.MUSE_DRIFT_DEVIATION_THRESHOLD, 2),
    minSamples: parseInteger(env.MUSE_DRIFT_MIN_SAMPLES, 20),
    windowSize: parseInteger(env.MUSE_DRIFT_WINDOW_SIZE, 200)
  });
  const budgetTracker = new MonthlyBudgetTracker({
    monthlyLimitUsd: parseNonNegativeFloat(env.MUSE_BUDGET_MONTHLY_LIMIT_USD, 0),
    warningPercent: parseInteger(env.MUSE_BUDGET_WARNING_PERCENT, 80)
  });
  const runtimeAgentMetrics: AgentMetrics = createDerivedAgentMetrics({
    drift: driftDetector,
    inner: agentMetrics,
    slo: sloEvaluator
  });
  const followupSuggestionStore = new InMemoryFollowupSuggestionStore({
    maxEvents: parseInteger(env.MUSE_FOLLOWUP_SUGGESTION_MAX_EVENTS, 50_000),
    retentionMs: parseInteger(env.MUSE_FOLLOWUP_SUGGESTION_RETENTION_MS, 72 * 60 * 60 * 1000)
  });
  const tracingPipeline = createTracingPipeline(db, resolveTokenUsageFile(env));
  const { tracer, latencyQuery, tokenCostQuery, traceSink } = tracingPipeline;
  const tokenUsageSink: TokenUsageSink = createBudgetTrackingTokenUsageSink(
    budgetTracker,
    tracingPipeline.tokenUsageSink
  );
  const circuitBreakerRegistry = new CircuitBreakerRegistry({
    failureThreshold: parseInteger(env.MUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
    resetTimeoutMs: parseInteger(env.MUSE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 30_000)
  });
  // Wrap every model call so the LOCAL answer path (which calls provider directly,
  // bypassing the runtime's recordTokenUsageEvent) still records token usage. The
  // runtime flags its own requests so this decorator skips them (no double-count).
  const baseModelProvider = createModelProvider(env);
  const modelProvider = baseModelProvider ? createUsageRecordingProvider(baseModelProvider, tokenUsageSink) : baseModelProvider;
  const conversationSummaryStore = createConversationSummaryStore(db, env);
  const taskMemoryStore = createTaskMemoryStore(db, env);
  const userMemoryStore = createUserMemoryStore(db, env);
  const sessionTagStore = createSessionTagStore(db);
  const defaultModel = resolveDefaultModel(env);
  const mcp = assembleMcpStack(env, db, options.mcpConnector);
  const runnerTools = createRunnerTools(env);
  const museTools = parseBoolean(env.MUSE_TOOLS_ENABLED, true) ? createMuseTools() : [];
  const loopbackMcpTools = createLoopbackMcpToolsFromEnv(env);
  // in-process ref store for just-in-time retrieval. Used
  // by AgentRuntime's tool-output truncation to stash full content
  // and surface ref=<id> in the marker; the agent fetches via the
  // muse.context loopback server when the budget is worth it.
  const contextReferenceStore = new InMemoryContextReferenceStore({
    maxEntries: parseInteger(env.MUSE_CONTEXT_REF_MAX_ENTRIES, 1_000),
    ttlMs: parseInteger(env.MUSE_CONTEXT_REF_TTL_MS, 30 * 60 * 1_000)
  });
  // Loopback-tools construction is hoisted below `activeContextProvider`
  // so the optional `muse.context.active` tool can hand the same
  // provider instance the runtime uses. See the assignment near the
  // `agentRuntime` declaration.
  let contextReferenceLoopbackTools: readonly MuseTool[] = [];

  // Resolve every personal-store path + registry the loopback tools
  // need. Some of these (notesDir, tasksFile, followupsFile,
  // patternsFiredFile, messagingRegistry, pollAll, pollNow) are
  // referenced by daemons/hooks downstream, so they stay as locals.
  const notesDir = resolveNotesDir(env);
  ensureNotesDir(notesDir);
  const notesRegistry = parseBoolean(env.MUSE_NOTES_ENABLED, true) ? buildNotesRegistry(env) : undefined;
  const calendarRegistry = buildCalendarRegistry(env);
  const tasksFile = resolveTasksFile(env);
  const tasksRegistry = parseBoolean(env.MUSE_TASKS_ENABLED, true) ? buildTasksRegistry(env) : undefined;
  const messagingRegistry = buildMessagingRegistry(env);
  const { pollAll, pollNow } = createMessagingPollDispatchers(env, messagingRegistry);
  const remindersFile = resolveRemindersFile(env);
  const reminderHistoryFile = resolveReminderHistoryFile(env);
  const proactiveHistoryFile = resolveProactiveHistoryFile(env);
  const followupsFile = resolveFollowupsFile(env);
  const episodesFile = resolveEpisodesFile(env);
  const patternsFiredFile = resolvePatternsFiredFile(env);

  // 11 loopback-tool bundles in one call. `buildLoopbackTools`
  // owns the env-gate + LLM-judge-opt-in logic that used to live
  // inline as 95 LOC of repeated scaffolding.
  const loopback = buildLoopbackTools({
    actionLogFile: resolveActionLogFile(env),
    ...(options.messagingApprovalGate ? { messagingApprovalGate: options.messagingApprovalGate } : {}),
    calendarRegistry,
    defaultModel,
    env,
    episodesFile,
    followupsFile,
    messagingRegistry,
    modelProvider,
    notesDir,
    notesRegistry,
    patternsFiredFile,
    pollAll,
    pollNow,
    proactiveHistoryFile,
    reminderHistoryFile,
    remindersFile,
    tasksFile,
    tasksRegistry,
    userId: env.MUSE_USER_ID ?? "user"
  });
  const schedulerHandle: { current: DynamicScheduler | undefined } = { current: undefined };

  const { skillRegistryPromise, skillTools } = createSkillRuntime(env);

  const toolRegistry = buildRuntimeToolRegistry({
    env,
    options,
    ...(calendarRegistry ? { calendarRegistry } : {}),
    ...(notesRegistry ? { notesRegistry } : {}),
    ...(tasksRegistry ? { tasksRegistry } : {}),
    userMemoryStore,
    notesDir,
    tasksFile,
    episodesFile,
    mcp,
    schedulerHandle,
    runnerTools,
    skillTools,
    museTools,
    loopbackMcpTools,
    getContextReferenceLoopbackTools: () => contextReferenceLoopbackTools,
    loopback
  });
  const autoExtractHook: HookStage | undefined = parseBoolean(env.MUSE_USER_MEMORY_AUTO_EXTRACT, true) && modelProvider && defaultModel
    ? createUserMemoryAutoExtractHook({
      model: env.MUSE_USER_MEMORY_AUTO_EXTRACT_MODEL ?? defaultModel,
      modelProvider,
      store: userMemoryStore,
      ...(parseBoolean(env.MUSE_BELIEF_PROVENANCE, true)
        ? { provenanceStore: new FileBeliefProvenanceStore(defaultBeliefProvenanceFile()) }
        : {})
    }) as HookStage
    : undefined;
  const reviewArmDeps = {
    env,
    ...(modelProvider ? { modelProvider } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    userMemoryStore
  };
  const reviewSkillArm = createReviewSkillArm(reviewArmDeps);
  const reviewCommitmentsArm = createReviewCommitmentsArm(reviewArmDeps);
  const reviewPreferencesArm = createReviewPreferencesArm(reviewArmDeps);
  const runtimeHooks = [
    ...createDefaultRuntimeHooks(env),
    // Auto-extract stays an EVERY-TURN hook (it reads only the latest exchange,
    // so it must see every turn) — unchanged behaviour, all surfaces.
    ...(autoExtractHook ? [autoExtractHook] : []),
    // The background-review engine ADDS the new window-scanning / tool-iteration
    // arms behind MUSE_BACKGROUND_REVIEW_ENABLED (default off): commitment +
    // preference on the turn-count trigger, skill authoring on the tool-iteration
    // trigger (the latter also behind MUSE_BACKGROUND_REVIEW_SKILL_ARM). Purely
    // additive — it never touches auto-extract.
    ...buildBackgroundReviewHooks(env, {
      ...(reviewCommitmentsArm ? { reviewCommitments: reviewCommitmentsArm } : {}),
      ...(reviewPreferencesArm ? { reviewPreferences: reviewPreferencesArm } : {}),
      ...(reviewSkillArm ? { reviewSkill: reviewSkillArm } : {})
    }),
    ...(parseBoolean(env.MUSE_FOLLOWUP_CAPTURE_ENABLED, true)
      ? [createFollowupCaptureHook({
        persist: async (captured: CapturedFollowup) => {
          await upsertFollowup(followupsFile, captured as PersistedFollowup);
        },
        // Step 5 — opt-in LLM-fallback detector with a per-day
        // budget cap. Off by default; one extra `generate` call per
        // turn when enabled, gated by MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY
        // (default 20) so a chatty session can't quietly burn quota.
        ...(parseBoolean(env.MUSE_FOLLOWUP_LLM_FALLBACK, false) && modelProvider && defaultModel
          ? {
              additionalDetector: createBudgetedLlmDetector({
                budgetFile: resolveFollowupLlmBudgetFile(env),
                // Non-negative: an explicit 0 means "disable LLM followups"
                // (isFollowupLlmBudgetExhausted treats cap<=0 as exhausted).
                // parseInteger rejected 0 → silently kept the default 20.
                cap: parseNonNegativeInteger(env.MUSE_FOLLOWUP_LLM_BUDGET_PER_DAY, 20),
                model: env.MUSE_FOLLOWUP_LLM_MODEL ?? defaultModel,
                modelProvider
              })
            }
          : {})
      })]
      : [])
  ];
  // Lifted above `createAgentRuntime` so the same provider instance is
  // both injected into the runtime (for `[Active Context]` system-section
  // composition) and exposed on the assembly for the REST surface +
  // `muse.context.active` MCP tool.
  const activeContextProvider = buildActiveContextProvider(
    env,
    parseBoolean(env.MUSE_USER_MEMORY_INJECTION, true) ? userMemoryStore : undefined,
    taskMemoryStore,
    calendarRegistry
  );
  contextReferenceLoopbackTools = createLoopbackMcpMuseTools(
    createContextReferenceMcpServer({
      store: contextReferenceStore,
      ...(activeContextProvider ? { activeContextProvider } : {})
    })
  );
  const telemetryAggregator = buildTelemetryAggregator(env);
  const vetoAvoidanceProvider = buildVetoAvoidanceProvider(env);
  const playbookProvider = buildPlaybookProvider(env);
  const planCacheProvider = buildPlanCacheProvider(env);
  const toolExemplarBank = buildToolExemplarBank(env);
  const contextWindowOptions = buildContextWindowOptions(env);
  const agentRuntime = modelProvider && defaultModel
    ? createAgentRuntime({
      agentSpecResolver,
      // Persist execution checkpoints so a crashed/interrupted run can resume from
      // its last step (the langgraph fault-tolerance gap). Local-first uses a file
      // store (the no-DB default previously persisted NOTHING — every checkpoint
      // was a silent no-op); the server keeps its DB path untouched.
      ...(db ? {} : { checkpointStore: new FileCheckpointStore(resolveCheckpointsDir(env)) }),
      cacheMetrics,
      circuitBreaker: circuitBreakerRegistry.get("model.generate"),
      contextReferenceStore,
      contextWindow: contextWindowOptions,
      // CMP-2 aux-model compaction (opt-in via MUSE_AUX_COMPACTION): summarize
      // the compacted-away turns with the SAME local model and append the recap
      // to the deterministic summary. Off by default (the extra local call adds
      // latency on a compaction turn); fail-open + model-agnostic in the runtime.
      ...(parseBoolean(env.MUSE_AUX_COMPACTION, false)
        ? { contextSummarizer: createModelDroppedContextSummarizer(modelProvider, defaultModel) }
        : {}),
      historyStore,
      hooks: runtimeHooks,
      hookTraceStore,
      // per-tool-result character cap. Default 8_000
      // chars (~2_000 tokens at the rough 1-token-per-4-chars
      // approximation) — large enough for small file reads and
      // typical tool replies, small enough that a single huge
      // result can't blow the working budget. Tunable via
      // MUSE_MAX_TOOL_OUTPUT_CHARS; 0 disables the cap.
      // Scaled down to the configured context window so a fixed 8k cap
      // can't swallow a small local model's window whole (no-op on a
      // large window; never raised above the configured value).
      maxToolOutputChars: scaleToolOutputBudget(
        contextWindowOptions.maxContextWindowTokens,
        parseInteger(env.MUSE_MAX_TOOL_OUTPUT_CHARS, 8_000)
      ),
      // Opt-in system-prompt token cap: sections evict lowest-priority-first
      // when the combined muse-sectioned footprint exceeds it (0/unset = off).
      ...(parseInteger(env.MUSE_PROMPT_TOKEN_BUDGET, 0) > 0
        ? { systemPromptTokenBudget: parseInteger(env.MUSE_PROMPT_TOKEN_BUDGET, 0) }
        : {}),
      metrics: runtimeAgentMetrics,
      modelProvider,
      // Grounding-first answer temperature, set explicitly so the runtime
      // doesn't inherit the model's Ollama Modelfile default (gemma4 ships 1.0).
      defaults: { temperature: resolveAnswerTemperature(env) },
      guards: createInputGuards(env),
      outputGuards: createOutputGuards(env),
      requestTimeoutMs: parseInteger(env.MUSE_MODEL_REQUEST_TIMEOUT_MS, 120_000),
      responseFilters: createResponseFilters(env),
      responseCache: parseBoolean(env.MUSE_CACHE_ENABLED, true) ? responseCache : undefined,
      retry: {
        initialDelayMs: parseInteger(env.MUSE_RETRY_INITIAL_DELAY_MS, 100),
        maxAttempts: parseInteger(env.MUSE_RETRY_MAX_ATTEMPTS, 3)
      },
      tokenUsageSink,
      tracer,
      toolRegistry,
      toolExposurePolicy: createPersonalToolExposurePolicy(env),
      userMemoryProvider: parseBoolean(env.MUSE_USER_MEMORY_INJECTION, true)
        ? userMemoryStore
        : undefined,
      conversationSummaryStore: parseBoolean(env.MUSE_CONVERSATION_SUMMARY_PERSIST, true)
        ? conversationSummaryStore
        : undefined,
      // Each provider is opt-out (active context) or opt-in (inbox, tool
      // filter) — see `buildActiveContextProvider`,
      // `buildInboxContextProvider`, `buildToolFilter` for the toggle
      // semantics.
      activeContextProvider,
      ...(vetoAvoidanceProvider ? { vetoAvoidanceProvider } : {}),
      ...(playbookProvider ? { playbookProvider } : {}),
      ...(planCacheProvider ? { planCacheProvider } : {}),
      ...(toolExemplarBank ? { toolExemplarBank } : {}),
      inboxContextProvider: buildInboxContextProvider(env),
      // Store-backed episodic recall. Reuses the same
      // ConversationSummaryStore that conversation-summary persistence
      // already writes to, so cross-session memory works the moment a
      // session compacts.
      episodicRecallProvider: parseBoolean(env.MUSE_CONVERSATION_SUMMARY_PERSIST, true)
        ? buildEpisodicRecallProvider(env, conversationSummaryStore)
        : undefined,
      toolFilter: buildToolFilter(env),
      skillCatalogProvider: buildSkillCatalogProvider(skillRegistryPromise),
      // actually instantiate the aggregator so the
      // recordTelemetry call site in AgentRuntime stops no-op-ing.
      ...(telemetryAggregator ? { telemetryAggregator } : {})
    })
    : undefined;
  const schedulerStore = createSchedulerStore(db, env);
  const schedulerExecutionStore = createSchedulerExecutionStore(db, env);
  const schedulerLock = createSchedulerLock(db, env);
  const schedulerService = new DynamicScheduler({
    dispatcher: new ScheduledJobDispatcher({
      agentExecutor: createScheduledAgentExecutor(() => agentRuntime, defaultModel),
      mcpInvoker: new ScheduledMcpToolInvoker(mcp.manager)
    }),
    cronScheduler: parseBoolean(env.MUSE_SCHEDULER_CRON_ENABLED, true)
      ? new NodeCronScheduler()
      : undefined,
    executionStore: schedulerExecutionStore,
    distributedLock: schedulerLock,
    // User kill-switch: a cron-fired job is skipped while the user has paused
    // the scheduler (toggled by `muse scheduler pause`); manual triggers still run.
    isPaused: () => isSchedulerPaused(defaultSchedulerPauseFile(env)),
    store: schedulerStore
  });
  schedulerHandle.current = schedulerService;

  return {
    agentRuntime,
    agentSpecRegistry,
    authService,
    cache: {
      metrics: cacheMetrics,
      responseCache,
      statsStore: cacheStatsStore
    },
    defaultModel,
    historyStore,
    hookTraceStore,
    mcp,
    modelProvider,
    debugReplayCaptureStore,
    conversationSummaryStore,
    sessionTagStore,
    taskMemoryStore,
    userMemoryStore,
    observability: {
      budgetTracker,
      driftDetector,
      followupSuggestionStore,
      latencyQuery,
      metrics: agentMetrics,
      sloEvaluator,
      ...(telemetryAggregator ? { telemetryAggregator } : {}),
      tokenCostQuery,
      tokenUsageSink,
      ...(traceSink ? { traceSink } : {}),
      tracer
    },
    requireAuth: parseBoolean(env.MUSE_REQUIRE_AUTH, Boolean(authService)),
    resilience: {
      circuitBreakerRegistry
    },
    calendar: calendarRegistry,
    runtimeSettings: new RuntimeSettings(createRuntimeSettingsStore(db)),
    toolRegistry,
    scheduler: {
      executionStore: schedulerExecutionStore,
      service: schedulerService,
      store: schedulerStore
    },
    ...(notesRegistry ? { notesProviderRegistry: notesRegistry } : {}),
    ...(tasksRegistry ? { tasksProviderRegistry: tasksRegistry } : {}),
    voice: buildVoiceRegistry(env),
    ...(activeContextProvider ? { activeContextProvider } : {}),
    agentInitiatedNoticeBroker: new InMemoryAgentInitiatedNoticeBroker(),
    messaging: messagingRegistry,
    ...(messagingRegistry.list().length > 0
      ? { messagingPollAll: pollAll, messagingPollNow: pollNow }
      : {})
  };
}


export { buildRuntimeToolRegistry, type RuntimeToolRegistryDeps } from "./runtime-tool-registry.js";
export {
  createBudgetedLlmDetector,
  createReviewCommitmentsArm,
  createReviewPreferencesArm,
  createReviewSkillArm,
  type ReviewArmDeps
} from "./background-review-arms.js";

export { createApiServerOptions } from "./api-server-options.js";

export { createGateEmbedder, createOllamaEmbedder } from "./context-engineering-builders.js";

export { distillQueuedCorrections, type DistillQueuedDeps } from "./distill-queue.js";
export { decayContradictedStrategies, type CorrectionSignal, type DecayContradictedDeps, type DecayedStrategy } from "./decay-contradicted.js";

export { createMessagingPollDispatchers, type MessagingPollDispatchers } from "./messaging-poll-dispatchers.js";

export {
  assembleKnowledgeCorpus,
  createKnowledgeEnricher,
  createNotesKnowledgeSearchTool,
  type AssembleKnowledgeCorpusOptions,
  type FeedEntryLike,
  type FeedsKnowledgeSource,
  type KnowledgeEnricherOptions,
  type NotesKnowledgeSearchToolOptions
} from "./knowledge-corpus.js";

export { createOverdueContactsTool, interactionsFromEvents, type EventMentionLike, type OverdueContactsToolDeps } from "./relationship-tool.js";
export { createWeekAgendaTool, groupWeekAgenda, type WeekAgendaInput, type WeekAgendaToolDeps, type WeekDay } from "./week-agenda-tool.js";
export { createTodayBriefTool, composeTodayBrief, type TodayBrief, type TodayBriefInput, type TodayBriefToolDeps } from "./today-brief-tool.js";
export { createDayRecapTool, composeDayRecap, type DayRecap, type DayRecapInput, type DayRecapToolDeps } from "./day-recap-tool.js";
export { createFindItemsTool, findAcrossDomains, type FindDomain, type FindHit, type FindItemsToolDeps, type FindSources } from "./find-items-tool.js";
export { readFeedKnowledgeEntries } from "./feeds-knowledge-source.js";
export { resolveDefaultUserId } from "./user-id.js";

export { resolveFeedsFile } from "./personal-providers.js";
export { aggregateTokenUsage, readLocalTokenUsage, type TokenUsageGroup, type TokenUsageSummary } from "@muse/observability";
export { createUsageRecordingProvider } from "./usage-recording-provider.js";
export { FileCheckpointStore } from "@muse/runtime-state";

export { describeOfficialMcpPosture, type OfficialMcpPresetPosture } from "./official-mcp-posture.js";

export function requireEnv(env: MuseEnvironment, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }

  return value;
}

/**
 * Resolve the default model identifier the runtime should use. Honors
 * `MUSE_MODEL` / `MUSE_DEFAULT_MODEL` first; when neither is set,
 * falls back to a sensible default inferred from whichever provider
 * API key is present in the environment. Returns undefined only when
 * no signal at all is available.
 *
 * Personal-JARVIS UX: a user who exports `GEMINI_API_KEY` once and
 * runs `node apps/api/dist/index.js` should get a working chat
 * endpoint without having to also set `MUSE_MODEL`.
 */
import {
  createModelProvider,
  LOCAL_FIRST_DEFAULT_MODEL,
  resolveAnswerTemperature,
  resolveDefaultModel
} from "./autoconfigure-model-provider.js";

export { createModelProvider, LOCAL_FIRST_DEFAULT_MODEL, resolveAnswerTemperature, resolveDefaultModel };

export {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseOptionalString
} from "./env-parsers.js";


/**
 * Builds the env-driven set of MCP loopback servers operators can plug in
 * without writing code:
 *
 *   - `MUSE_LOOPBACK_MCP_ENABLED=true` registers the eight default ambient
 *     servers (time/text/math/json/url/crypto/diff/regex) as Muse tools using
 *     the `<server>.<tool>` namespace.
 *   - `MUSE_LOOPBACK_FETCH_HOSTS=foo.com,bar.com` adds the opt-in `muse.fetch`
 *     server bound to that allowlist.
 *   - `MUSE_LOOPBACK_FS_ROOTS=/abs/path1,/abs/path2` adds the opt-in `muse.fs`
 *     server bound to those roots (read-only).
 *
 * All three are independent: operators can enable any subset. The catalog at
 * `GET /api/muse/loopback` lists what is available regardless of which are
 * actually wired here.
 */
export function createLoopbackMcpToolsFromEnv(env: MuseEnvironment): readonly MuseTool[] {
  const servers: LoopbackMcpServer[] = [];

  if (parseBoolean(env.MUSE_LOOPBACK_MCP_ENABLED, false)) {
    const searxngUrl = env.MUSE_SEARXNG_URL?.trim();
    const searxngEngines = env.MUSE_SEARXNG_ENGINES?.trim();
    servers.push(...createDefaultLoopbackMcpServers({
      ...(searxngUrl && searxngUrl.length > 0 ? { searxngUrl } : {}),
      ...(searxngEngines && searxngEngines.length > 0 ? { searxngEngines } : {})
    }));
  }

  const fetchHosts = parseCsv(env.MUSE_LOOPBACK_FETCH_HOSTS);
  if (fetchHosts) {
    servers.push(createFetchMcpServer({ allowedHosts: fetchHosts }));
  }

  const fsRoots = parseCsv(env.MUSE_LOOPBACK_FS_ROOTS);
  if (fsRoots) {
    servers.push(createFilesystemMcpServer({ allowedRoots: fsRoots }));
  }

  return servers.flatMap((server) => createLoopbackMcpMuseTools(server));
}


