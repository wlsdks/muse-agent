/**
 * Runtime-assembly composition root — the `createMuseRuntimeAssembly`
 * factory and the shared shapes it produces (`MuseEnvironment`,
 * `MuseRuntimeAssembly`, `ApiServerAssemblyOptions`, `ConfigurationError`).
 *
 * Lifted out of `index.ts` so the barrel stays a curated export surface
 * and the heavy wiring lives in its own focused module. `index.ts`
 * re-exports every symbol here byte-identically, so external callers see
 * no change. The per-piece builders this factory composes already live in
 * their own siblings (`personal-providers`, `store-factories`,
 * `runtime-wiring`, `context-engineering-builders`, …); this module owns
 * only the composition, not the pieces.
 */

import { CalendarProviderRegistry } from "@muse/calendar";
import {
  createAgentRuntime,
  createCorrectionCaptureHook,
  createFollowupCaptureHook,
  createModelDroppedContextSummarizer,
  InMemoryAgentInitiatedNoticeBroker,
  type ActiveContextProvider,
  type AgentInitiatedNoticeBroker,
  type AgentRuntime,
  type CapturedFollowup,
  type EgressAdvisorySink,
  type HookStage,
  type PersonaRegister,
  USER_MEMORY_DATA_NOT_INSTRUCTIONS_LINE,
  USER_MEMORY_INTRO_LINE,
  type UserModelComposer
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
import { randomUUID } from "node:crypto";

import { resolveLearningPauseFile } from "./provider-paths.js";
import { appendActionLog, defaultSchedulerPauseFile, enqueueLearnEvent, isLearningPaused, isSchedulerPaused, resolveLearnQueueFile, upsertFollowup, type PersistedFollowup } from "@muse/stores";
import { createContextReferenceMcpServer, createDefaultLoopbackMcpServers, createFetchMcpServer, createFilesystemMcpServer, type MessageApprovalGate, type NotesProviderRegistry, type TasksProviderRegistry } from "@muse/domain-tools";
import {
  createUserMemoryAutoExtractHook,
  defaultBeliefProvenanceFile,
  FileBeliefProvenanceStore,
  InMemoryContextReferenceStore,
  scaleToolOutputBudget,
  type ConversationSummaryStore,
  type TaskMemoryMaintenance,
  type TaskMemoryStore,
  type UserMemoryStore
} from "@muse/memory";
import { isInteractiveWebEgressAllowed, type ModelProvider } from "@muse/model";
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

import { composeLearnedUserModelSection, loadUserPersonaSync, PersonaHotReloadRegistry, resolvePersonaFilePath } from "@muse/recall";
import type { InMemoryPromptLayerRegistry } from "@muse/prompts";
import { CircuitBreakerRegistry } from "@muse/resilience";
import { redactSecretsInText, withBestEffort } from "@muse/shared";
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
  SchedulerMessaging,
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
  resolveEffectiveLocalOnlyOverride,
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
  createScheduledAgentExecutor,
  createSchedulerMessagingSender,
  resolveStreamIdleTimeoutMs
} from "./runtime-wiring.js";
import {
  createModelProvider,
  resolveAnswerTemperature,
  resolveDefaultModel
} from "./autoconfigure-model-provider.js";

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
  /**
   * The SAME registry instance `agentRuntime` resolves its L1 personality
   * layer from (docs/strategy/prompt-architecture.md, decision D2 + S3).
   * A `PersonaHotReloadRegistry` over `~/.config/muse/PERSONA.md` (or
   * `MUSE_PERSONA_MD_FILE`): the prompt-persona API routes mutate THIS
   * instance on save, and a direct file edit is picked up by a stat check
   * on the next resolve — either way the change applies to the very next
   * turn without a restart.
   */
  readonly promptLayerRegistry: InMemoryPromptLayerRegistry;
  /** The resolved PERSONA.md path this assembly loaded at startup. */
  readonly personaFilePath: string;
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
   * Composition-only posture freeze used by the API boundary. It is not a
   * user-facing setting: ordinary CLI/runtime assembly continues to derive
   * local-only from `env`.
   */
  readonly localOnlyOverride?: boolean;
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

/**
 * Fail-CLOSED coherence check: `MUSE_REQUIRE_AUTH=true` demands the API enforce
 * auth, but the server's auth preHandler only exists when an auth service does
 * (i.e. a JWT secret is configured). Without one, that explicit hardening
 * request would silently run the API UNAUTHENTICATED (fully exposed under
 * `HOST=0.0.0.0`). Refuse to assemble instead of ignoring the request. An UNSET
 * flag defaults to "auth iff a secret exists" and is fine — this fires ONLY on
 * an explicit true with no auth service.
 */
export function assertAuthConfigCoherent(
  env: { readonly MUSE_REQUIRE_AUTH?: string },
  hasAuthService: boolean
): void {
  if (parseBoolean(env.MUSE_REQUIRE_AUTH, false) && !hasAuthService) {
    throw new Error(
      "MUSE_REQUIRE_AUTH=true but no auth secret is configured — set MUSE_AUTH_JWT_SECRET "
      + "(or a rotation file). Refusing to start: without a secret the API would run "
      + "UNAUTHENTICATED. Configure the secret, or unset MUSE_REQUIRE_AUTH."
    );
  }
}

export function createMuseRuntimeAssembly(options: ApiServerAssemblyOptions = {}): MuseRuntimeAssembly {
  const sourceEnv = options.env ?? process.env;
  // Compute the process-backed strict floor before model-key merging. Without
  // this, a supplied `MUSE_LOCAL_ONLY=false` plus a nonempty models.json could
  // enumerate the raw environment before Home Assistant gets a chance to
  // reject a remote/blank endpoint without touching its bearer token.
  const modelAndHomeLocalOnlyOverride = resolveEffectiveLocalOnlyOverride(sourceEnv, options.localOnlyOverride);
  const env = mergeModelKeysFromFile(sourceEnv, {
    ...(modelAndHomeLocalOnlyOverride === undefined ? {} : { localOnlyOverride: modelAndHomeLocalOnlyOverride })
  });
  const db = options.db;
  // Sync read: createMuseRuntimeAssembly is called synchronously from dozens
  // of CLI command sites, so the startup persona load can't await. A broken
  // or absent PERSONA.md is fail-open (default bluebird layer — see
  // resolveRuntimePersonaLayerSync), and the hot-reload registry stat-checks
  // the file on every resolve so a DIRECT file edit applies to the next turn
  // in long-lived processes, same as a save through the persona API.
  const personaFilePath = resolvePersonaFilePath(env);
  const promptLayerRegistry = new PersonaHotReloadRegistry(personaFilePath);
  // The explicit PERSONA.md `register` setting (docs/strategy/
  // prompt-architecture.md §4) — WINS over per-turn 반말/존댓말 detection in
  // applyPromptLayers. Same fail-open posture as the layer load above: an
  // absent/invalid file just yields undefined (detection alone decides).
  const startupPersonaLoad = loadUserPersonaSync(personaFilePath);
  const personaRegister = startupPersonaLoad.exists && startupPersonaLoad.ok
    ? startupPersonaLoad.frontmatter.register
    : undefined;

  const observability = buildObservabilityStack(env, db);
  const {
    authService,
    agentSpecRegistry,
    agentSpecResolver,
    historyStore,
    hookTraceStore,
    debugReplayCaptureStore,
    cacheStatsStore,
    cacheMetrics,
    responseCache,
    agentMetrics,
    sloEvaluator,
    driftDetector,
    budgetTracker,
    runtimeAgentMetrics,
    followupSuggestionStore,
    tracer,
    latencyQuery,
    tokenCostQuery,
    traceSink,
    tokenUsageSink,
    circuitBreakerRegistry
  } = observability;

  const modelAndStores = buildModelAndStoreStack(env, db, tokenUsageSink, options.mcpConnector);
  const {
    modelProvider,
    conversationSummaryStore,
    taskMemoryStore,
    userMemoryStore,
    sessionTagStore,
    defaultModel,
    mcp,
    runnerTools,
    museTools,
    loopbackMcpTools,
    contextReferenceStore
  } = modelAndStores;

  // Loopback-tools construction is hoisted below `activeContextProvider`
  // so the optional `muse.context.active` tool can hand the same
  // provider instance the runtime uses. See the assignment near the
  // `agentRuntime` declaration.
  let contextReferenceLoopbackTools: readonly MuseTool[] = [];

  const personalStores = buildPersonalStoreStack(env, options, modelProvider, defaultModel);
  const {
    notesDir,
    notesRegistry,
    calendarRegistry,
    tasksFile,
    tasksRegistry,
    messagingRegistry,
    pollAll,
    pollNow,
    followupsFile,
    episodesFile,
    loopback
  } = personalStores;

  const tooling = buildToolingStack({
    calendarRegistry,
    env,
    episodesFile,
    getContextReferenceLoopbackTools: () => contextReferenceLoopbackTools,
    loopback,
    loopbackMcpTools,
    mcp,
    museTools,
    notesDir,
    notesRegistry,
    options,
    runnerTools,
    tasksFile,
    tasksRegistry,
    userMemoryStore
  });
  const { schedulerHandle, skillRegistryPromise, toolRegistry } = tooling;

  const hooksAndProviders = buildHooksAndContextProviders({
    calendarRegistry,
    contextReferenceStore,
    defaultModel,
    env,
    followupsFile,
    modelProvider,
    taskMemoryStore,
    userMemoryStore
  });
  const {
    runtimeHooks,
    activeContextProvider,
    telemetryAggregator,
    vetoAvoidanceProvider,
    playbookProvider,
    planCacheProvider,
    toolExemplarBank,
    contextWindowOptions
  } = hooksAndProviders;
  contextReferenceLoopbackTools = hooksAndProviders.contextReferenceLoopbackTools;

  const agentRuntime = buildAgentRuntime({
    activeContextProvider,
    agentSpecResolver,
    cacheMetrics,
    circuitBreakerRegistry,
    contextReferenceStore,
    contextWindowOptions,
    conversationSummaryStore,
    db,
    defaultModel,
    env,
    historyStore,
    hookTraceStore,
    modelProvider,
    personaRegister,
    playbookProvider,
    planCacheProvider,
    promptLayerRegistry,
    responseCache,
    runtimeAgentMetrics,
    runtimeHooks,
    skillRegistryPromise,
    telemetryAggregator,
    tokenUsageSink,
    toolExemplarBank,
    toolRegistry,
    tracer,
    userMemoryStore,
    vetoAvoidanceProvider
  });
  const schedulerStore = createSchedulerStore(db, env);
  const schedulerExecutionStore = createSchedulerExecutionStore(db, env);
  const schedulerLock = createSchedulerLock(db, env);
  const schedulerCronEnabled = parseBoolean(env.MUSE_SCHEDULER_CRON_ENABLED, true);
  const schedulerService = new DynamicScheduler({
    dispatcher: new ScheduledJobDispatcher({
      agentExecutor: createScheduledAgentExecutor(() => agentRuntime, defaultModel),
      mcpInvoker: new ScheduledMcpToolInvoker(mcp.manager)
    }),
    cronScheduler: schedulerCronEnabled ? new NodeCronScheduler() : undefined,
    executionStore: schedulerExecutionStore,
    distributedLock: schedulerLock,
    // User kill-switch: a cron-fired job is skipped while the user has paused
    // the scheduler (toggled by `muse scheduler pause`); manual triggers still run.
    isPaused: () => isSchedulerPaused(defaultSchedulerPauseFile(env)),
    // Delivers a completed scheduled-agent job's result to
    // job.notificationChannelId — without this the default no-op
    // SchedulerMessaging silently discards every job's output.
    messagingService: new SchedulerMessaging(createSchedulerMessagingSender(messagingRegistry)),
    store: schedulerStore
  });
  schedulerHandle.current = schedulerService;
  if (schedulerCronEnabled) {
    // Re-arm every enabled job's cron timer after a process restart — with
    // no caller, `loadEnabledJobs` (which exists precisely for this) was
    // never invoked, so a persisted job never fired again once the process
    // that created it exited. Fire-and-forget: assembly itself stays
    // synchronous, and a failure here (e.g. a corrupt persisted cron
    // expression) must not block the whole runtime from coming up.
    void withBestEffort(schedulerService.loadEnabledJobs(), undefined);
  }

  assertAuthConfigCoherent(env, Boolean(authService));

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
    personaFilePath,
    promptLayerRegistry,
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

/**
 * Observability + core stores: auth, agent-spec registry, run history,
 * hook traces, response cache, metrics/SLO/drift/budget, and the tracing
 * pipeline's token-usage sink. Everything downstream (model provider,
 * agent runtime) needs `tokenUsageSink`, so this stage runs first.
 */
function buildObservabilityStack(env: MuseEnvironment, db: Kysely<MuseDatabase> | undefined) {
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

  return {
    authService,
    agentSpecRegistry,
    agentSpecResolver,
    historyStore,
    hookTraceStore,
    debugReplayCaptureStore,
    cacheStatsStore,
    cacheMetrics,
    responseCache,
    agentMetrics,
    sloEvaluator,
    driftDetector,
    budgetTracker,
    runtimeAgentMetrics,
    followupSuggestionStore,
    tracer,
    latencyQuery,
    tokenCostQuery,
    traceSink,
    tokenUsageSink,
    circuitBreakerRegistry
  };
}

/**
 * Model provider (usage-recording-wrapped) + the memory/summary/session
 * stores + the MCP stack + the two static tool bundles (runner, muse
 * built-ins) + the in-process context-reference store. `tokenUsageSink`
 * comes from `buildObservabilityStack` so the local-answer path still
 * records usage through the same decorator.
 */
function buildModelAndStoreStack(
  env: MuseEnvironment,
  db: Kysely<MuseDatabase> | undefined,
  tokenUsageSink: TokenUsageSink,
  mcpConnector: McpTransportConnector | undefined
) {
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
  const mcp = assembleMcpStack(env, db, mcpConnector);
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

  return {
    modelProvider,
    conversationSummaryStore,
    taskMemoryStore,
    userMemoryStore,
    sessionTagStore,
    defaultModel,
    mcp,
    runnerTools,
    museTools,
    loopbackMcpTools,
    contextReferenceStore
  };
}

/**
 * Resolves every personal-store path + registry the loopback tools need
 * (notes/calendar/tasks/messaging + reminders/proactive/followups/episodes/
 * patterns files), then builds the 11 loopback-tool bundles in one call.
 * Some resolved paths (notesDir, tasksFile, episodesFile, followupsFile)
 * are also needed by downstream tool-registry/hook wiring, so they're
 * returned alongside the loopback bundle rather than kept file-local.
 */
function buildPersonalStoreStack(
  env: MuseEnvironment,
  options: ApiServerAssemblyOptions,
  modelProvider: ModelProvider | undefined,
  defaultModel: string | undefined
) {
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

  return {
    notesDir,
    notesRegistry,
    calendarRegistry,
    tasksFile,
    tasksRegistry,
    messagingRegistry,
    pollAll,
    pollNow,
    remindersFile,
    reminderHistoryFile,
    proactiveHistoryFile,
    followupsFile,
    episodesFile,
    patternsFiredFile,
    loopback
  };
}

/**
 * The scheduler handle placeholder (mutated after the scheduler service
 * exists), the async skill registry + its tools, and the composed
 * `DynamicToolRegistry`. `getContextReferenceLoopbackTools` is a closure
 * the caller creates over its own `let`-mutated array (assigned later,
 * after `activeContextProvider` is built) — read lazily by the registry.
 */
function buildToolingStack(params: {
  readonly env: MuseEnvironment;
  readonly options: ApiServerAssemblyOptions;
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly notesRegistry: NotesProviderRegistry | undefined;
  readonly tasksRegistry: TasksProviderRegistry | undefined;
  readonly userMemoryStore: UserMemoryStore;
  readonly notesDir: string;
  readonly tasksFile: string;
  readonly episodesFile: string;
  readonly mcp: ReturnType<typeof assembleMcpStack>;
  readonly runnerTools: ReturnType<typeof createRunnerTools>;
  readonly museTools: readonly MuseTool[];
  readonly loopbackMcpTools: readonly MuseTool[];
  readonly loopback: ReturnType<typeof buildLoopbackTools>;
  readonly getContextReferenceLoopbackTools: () => readonly MuseTool[];
}) {
  const {
    env,
    options,
    calendarRegistry,
    notesRegistry,
    tasksRegistry,
    userMemoryStore,
    notesDir,
    tasksFile,
    episodesFile,
    mcp,
    runnerTools,
    museTools,
    loopbackMcpTools,
    loopback,
    getContextReferenceLoopbackTools
  } = params;

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
    getContextReferenceLoopbackTools,
    loopback
  });

  return { schedulerHandle, skillRegistryPromise, skillTools, toolRegistry };
}

/**
 * Runtime hooks (auto-extract, background-review arms, followup capture)
 * + the context-engineering providers (`activeContextProvider`, the
 * context-reference loopback tools it feeds, telemetry, veto-avoidance,
 * playbook, plan-cache, tool-exemplar bank, context-window options).
 * `activeContextProvider` must exist before the context-reference
 * loopback tools are built (same ordering as the original inline code).
 */
function buildHooksAndContextProviders(params: {
  readonly env: MuseEnvironment;
  readonly modelProvider: ModelProvider | undefined;
  readonly defaultModel: string | undefined;
  readonly userMemoryStore: UserMemoryStore;
  readonly followupsFile: string;
  readonly taskMemoryStore: TaskMemoryStore & TaskMemoryMaintenance;
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly contextReferenceStore: InMemoryContextReferenceStore;
}) {
  const {
    env,
    modelProvider,
    defaultModel,
    userMemoryStore,
    followupsFile,
    taskMemoryStore,
    calendarRegistry,
    contextReferenceStore
  } = params;

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
    // Correction capture — on EVERY surface, not just the interactive TUI.
    // The distiller's only caller was the `muse chat` end-of-session pipeline, so
    // one-shot `muse ask`, the web chat, Telegram and every API caller READ the
    // playbook but never wrote to it: a heavily-used install could still have an
    // empty playbook because the user corrected Muse on the surfaces that were not
    // listening. The hook only ENQUEUES (append-only, no model call, no added
    // latency); the existing distiller turns the queue into strategies at session
    // end or on the daemon tick.
    ...(parseBoolean(env.MUSE_PLAYBOOK_DISTILL_ENABLED, true)
      ? [createCorrectionCaptureHook({
        enqueue: async (event) => {
          await enqueueLearnEvent(resolveLearnQueueFile(env), {
            correction: event.correction,
            enqueuedAtMs: Date.now(),
            id: `learn_${randomUUID()}`,
            priorAnswer: event.priorAnswer,
            userId: event.userId,
            ...(event.request ? { request: event.request } : {})
          });
        },
        isPaused: async () => isLearningPaused(resolveLearningPauseFile(env))
      })]
      : []),
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
  const contextReferenceLoopbackTools = createLoopbackMcpMuseTools(
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

  return {
    runtimeHooks,
    activeContextProvider,
    contextReferenceLoopbackTools,
    telemetryAggregator,
    vetoAvoidanceProvider,
    playbookProvider,
    planCacheProvider,
    toolExemplarBank,
    contextWindowOptions
  };
}

/**
 * The runtime's egress-advisory audit sink (S5 follow-up, C1/C2 review
 * finding): a non-"allow" egress decision — "confirm" (a link-follow the
 * runtime didn't block) or "deny" (a hard block) — otherwise leaves no
 * durable, reviewable record anywhere. Appends one `ActionLogEntry` to the
 * SAME action-log file `buildPersonalStoreStack`'s loopback tools already
 * read (`muse actions` / `/api/actions`), so this shows up in the existing
 * review surface rather than a new one. `result: "noted"` for "confirm" (the
 * call proceeded — this is advisory, not a refusal); `result: "refused"` for
 * "deny" (the runtime's own fail-closed block, matching that value's
 * existing meaning elsewhere in this store).
 *
 * Exported (not default-private) so it's directly unit-testable against a
 * real temp file without standing up the whole assembly.
 */
export function buildEgressAdvisorySink(env: MuseEnvironment): EgressAdvisorySink {
  const actionLogFile = resolveActionLogFile(env);
  return async (advisory) => {
    // The advisory URL came from an UNTRUSTED tool result (a "confirm"
    // link-following fetch or a "deny"ed model-composed URL) and can carry a
    // credential-SHAPED token the deny just blocked. This record is long-lived
    // and round-trips into recall grounding (→ possibly a cloud model), so
    // scrub it like the sibling outbound path (consented-action.ts): pattern +
    // registered secret redaction, then a length cap so a multi-KB dictionary
    // URL can't bloat the hash-chained log. redactSecrets (registered-only, at
    // the append boundary) is NOT enough — it misses an unregistered token.
    const safeUrl = advisory.url ? redactSecretsInText(advisory.url).slice(0, 500) : undefined;
    // No gateClass: an egress advisory is a NON-INTERACTIVE deterministic
    // record (no human approval prompt fired), and gateClass is the key
    // approval-RATE telemetry groups on — tagging it would manufacture a
    // phantom denial in `analyzeApprovalRates`. The tool name lives in `what`.
    await appendActionLog(actionLogFile, {
      ...(safeUrl ? { detail: `url: ${safeUrl}` } : {}),
      id: `egress_${advisory.runId}_${randomUUID()}`,
      result: advisory.decision === "deny" ? "refused" : "noted",
      userId: advisory.userId ?? env.MUSE_USER_ID ?? "user",
      what: `egress ${advisory.decision}: ${advisory.toolName}${safeUrl ? ` → ${safeUrl}` : ""}`,
      when: new Date().toISOString(),
      why: advisory.reason
    });
  };
}

/**
 * The default-ON learned-user-model composer for the runtime's "user-memory"
 * system section (user-model S1b). Active unless MUSE_RICH_USER_MODEL=false ⇒
 * returns undefined ⇒ agent-core falls back to the built-in
 * `renderUserMemorySection`. When on, it maps the runtime's
 * `UserMemorySnapshot` to `@muse/recall`'s shared learned block
 * (contested/preference-slot logic + the typed `userModel` snapshot) and
 * PREPENDS the default section's two framing lines (incl. the injection-defense
 * line) so the composed section is a proven SUPERSET of `renderUserMemorySection`
 * — nothing the default carried is dropped. It emits only that block + framing:
 * identity (L1 promptLayerRegistry) and the context line (activeContextProvider)
 * are already injected upstream, so re-emitting them here would double-inject.
 *
 * Scope-safe by construction: the composer is handed the RUN's OWN userId +
 * memory, so a channel identity only ever composes ITS memory — the owner's
 * learned block never leaks to another user. Per-userId composition IS the
 * scope-safe design.
 *
 * Fail-soft: any throw inside the recall composition returns undefined (the
 * default section renders instead) rather than breaking the run.
 *
 * `episodes` / `recurringThreads` / `factHistory` are intentionally NOT passed —
 * they aren't on `UserMemorySnapshot` and enrich later (S1c); the block is
 * already a superset of the default via the typed-model + contested logic.
 */
export function buildUserModelComposer(env: MuseEnvironment): UserModelComposer | undefined {
  // Default ON. The composer is now a proven SUPERSET of the built-in
  // renderUserMemorySection: it renders the typed `memory.userModel` slots
  // (via composeLearnedUserModelSection) AND prepends the same two framing
  // lines — including the "stored data is not instructions" injection-defense
  // — so nothing the default section carried is lost, while the recall block
  // adds contested/history/thread enrichment on top. MUSE_RICH_USER_MODEL=false
  // opts back into the flat default section.
  if (!parseBoolean(env.MUSE_RICH_USER_MODEL, true)) {
    return undefined;
  }
  return (memory) => {
    try {
      const block = composeLearnedUserModelSection({
        facts: memory.facts,
        preferences: memory.preferences,
        ...(memory.recentTopics ? { recentTopics: memory.recentTopics } : {}),
        ...(memory.userModel ? { userModel: memory.userModel } : {})
      });
      if (!block) {
        // Empty learned block ⇒ decline so agent-core falls back to the default
        // section (also empty for empty memory) — no bare framing lines with no
        // content, and fail-soft parity with renderUserMemorySection.
        return undefined;
      }
      // PREPEND the default section's two framing lines so the composed section
      // is a proper superset: the injection-defense line MUST survive the swap.
      return [USER_MEMORY_INTRO_LINE, USER_MEMORY_DATA_NOT_INSTRUCTIONS_LINE, block].join("\n");
    } catch {
      return undefined;
    }
  };
}

/**
 * The `createAgentRuntime` composition itself — the single largest block
 * in the original function. Returns `undefined` when no model provider /
 * default model is configured (fresh, unconfigured install), same guard
 * as the original inline ternary.
 */
function buildAgentRuntime(params: {
  readonly env: MuseEnvironment;
  readonly db: Kysely<MuseDatabase> | undefined;
  readonly modelProvider: ModelProvider | undefined;
  readonly defaultModel: string | undefined;
  readonly agentSpecResolver: RuleBasedAgentSpecResolver;
  readonly cacheMetrics: InMemoryCacheMetricsRecorder;
  readonly circuitBreakerRegistry: CircuitBreakerRegistry;
  readonly contextReferenceStore: InMemoryContextReferenceStore;
  readonly contextWindowOptions: ReturnType<typeof buildContextWindowOptions>;
  readonly historyStore: AgentRunHistoryStore;
  readonly runtimeHooks: readonly HookStage[];
  readonly hookTraceStore: HookTraceStore;
  readonly tokenUsageSink: TokenUsageSink;
  readonly runtimeAgentMetrics: AgentMetrics;
  readonly tracer: MuseTracer;
  readonly toolRegistry: ToolRegistry;
  readonly activeContextProvider: ActiveContextProvider | undefined;
  readonly vetoAvoidanceProvider: ReturnType<typeof buildVetoAvoidanceProvider>;
  readonly playbookProvider: ReturnType<typeof buildPlaybookProvider>;
  readonly planCacheProvider: ReturnType<typeof buildPlanCacheProvider>;
  readonly toolExemplarBank: ReturnType<typeof buildToolExemplarBank>;
  readonly userMemoryStore: UserMemoryStore;
  readonly conversationSummaryStore: ConversationSummaryStore;
  readonly skillRegistryPromise: ReturnType<typeof createSkillRuntime>["skillRegistryPromise"];
  readonly telemetryAggregator: ReturnType<typeof buildTelemetryAggregator>;
  readonly promptLayerRegistry: InMemoryPromptLayerRegistry;
  readonly personaRegister: PersonaRegister | undefined;
  readonly responseCache: InMemoryResponseCache;
}): AgentRuntime | undefined {
  const {
    env,
    db,
    modelProvider,
    defaultModel,
    agentSpecResolver,
    cacheMetrics,
    circuitBreakerRegistry,
    contextReferenceStore,
    contextWindowOptions,
    historyStore,
    runtimeHooks,
    hookTraceStore,
    tokenUsageSink,
    runtimeAgentMetrics,
    tracer,
    toolRegistry,
    activeContextProvider,
    vetoAvoidanceProvider,
    playbookProvider,
    planCacheProvider,
    toolExemplarBank,
    userMemoryStore,
    conversationSummaryStore,
    skillRegistryPromise,
    telemetryAggregator,
    promptLayerRegistry,
    personaRegister,
    responseCache
  } = params;

  return modelProvider && defaultModel
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
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(env),
      // Opt-in system-prompt token cap: sections evict lowest-priority-first
      // when the combined muse-sectioned footprint exceeds it (0/unset = off).
      ...(parseInteger(env.MUSE_PROMPT_TOKEN_BUDGET, 0) > 0
        ? { systemPromptTokenBudget: parseInteger(env.MUSE_PROMPT_TOKEN_BUDGET, 0) }
        : {}),
      metrics: runtimeAgentMetrics,
      modelProvider,
      promptLayerRegistry,
      ...(personaRegister ? { personaRegister } : {}),
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
      // Default-ON (MUSE_RICH_USER_MODEL) shared learned-user-model composer, a
      // proven superset of the default. MUSE_RICH_USER_MODEL=false ⇒ agent-core
      // renders the flat built-in section instead.
      ...((): { userModelComposer?: UserModelComposer } => {
        const userModelComposer = buildUserModelComposer(env);
        return userModelComposer ? { userModelComposer } : {};
      })(),
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
      egressAdvisorySink: buildEgressAdvisorySink(env),
      skillCatalogProvider: buildSkillCatalogProvider(skillRegistryPromise),
      // actually instantiate the aggregator so the
      // recordTelemetry call site in AgentRuntime stops no-op-ing.
      ...(telemetryAggregator ? { telemetryAggregator } : {})
    })
    : undefined;
}

export function requireEnv(env: MuseEnvironment, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }

  return value;
}

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
  const interactiveWebEgressAllowed = isInteractiveWebEgressAllowed(env);

  if (parseBoolean(env.MUSE_LOOPBACK_MCP_ENABLED, false)) {
    const searxngUrl = env.MUSE_SEARXNG_URL?.trim();
    const searxngEngines = env.MUSE_SEARXNG_ENGINES?.trim();
    const defaultServers = createDefaultLoopbackMcpServers({
      ...(searxngUrl && searxngUrl.length > 0 ? { searxngUrl } : {}),
      ...(searxngEngines && searxngEngines.length > 0 ? { searxngEngines } : {})
    });
    servers.push(...(interactiveWebEgressAllowed
      ? defaultServers
      : defaultServers.filter((server) => server.name !== "muse.search")));
  }

  const fetchHosts = parseCsv(env.MUSE_LOOPBACK_FETCH_HOSTS);
  if (fetchHosts && interactiveWebEgressAllowed) {
    servers.push(createFetchMcpServer({ allowedHosts: fetchHosts }));
  }

  const fsRoots = parseCsv(env.MUSE_LOOPBACK_FS_ROOTS);
  if (fsRoots) {
    servers.push(createFilesystemMcpServer({ allowedRoots: fsRoots }));
  }

  return servers.flatMap((server) => createLoopbackMcpMuseTools(server));
}
