import {
  CalendarProviderRegistry,
  FileCalendarCredentialStore
} from "@muse/calendar";
import {
  createAgentRuntime,
  createCasualLureStripResponseFilter,
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createGreetingStripResponseFilter,
  createInjectionInputGuard,
  createMarkdownStripResponseFilter,
  createMaxLengthResponseFilter,
  createPiiInputGuard,
  createPiiMaskingOutputGuard,
  createResponseCountConsistencyFilter,
  createResponseCountInjectionFilter,
  createSanitizedTextResponseFilter,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  createSystemPromptLeakageOutputGuard,
  createToolResultQualityAuditFilter,
  createVerifiedSourcesResponseFilter,
  createZeroResultOverclaimResponseFilter,
  type AgentRuntime,
  type GuardStage,
  type HookStage,
  type OutputGuardStage
} from "@muse/agent-core";
import {
  InMemoryAgentSpecRegistry,
  KyselyAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import {
  AsyncAuth,
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  KyselyAuthProvider,
  KyselyUserStore,
  JwtTokenProvider,
  type MuseAuth
} from "@muse/auth";
import {
  InMemoryCacheMetricsRecorder,
  InMemoryCacheStatsStore,
  InMemoryResponseCache
} from "@muse/cache";
import {
  DefaultMcpTransportConnector,
  McpManager,
  McpSecurityPolicyProvider,
  createCalendarMcpServer,
  createTasksMcpServer,
  createDefaultLoopbackMcpServers,
  createFetchMcpServer,
  createFilesystemMcpServer,
  createLoopbackMcpMuseTools,
  createNotesMcpServer,
  createNotesRegistryMcpServer,
  createTasksRegistryMcpServer,
  type LoopbackMcpServer,
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServerStore,
  type NotesProviderRegistry,
  type TasksProviderRegistry
} from "@muse/mcp";
import {
  createUserMemoryAutoExtractHook,
  type ConversationSummaryStore,
  type TaskMemoryMaintenance,
  type TaskMemoryStore,
  type UserMemoryStore
} from "@muse/memory";
import {
  AnthropicProvider,
  DiagnosticModelProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  OpenRouterProvider,
  parseModelName,
  type ModelProvider
} from "@muse/model";
import {
  CostAnomalyDetector,
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  createBudgetTrackingTokenUsageSink,
  createCostAnomalyFeedingTokenUsageSink,
  createDerivedAgentMetrics,
  createMuseObservabilitySnapshotProvider,
  type AgentMetrics,
  type MuseObservabilitySnapshot,
  type LatencyQuery,
  type MuseTracer,
  type QueryableTraceEventSink,
  type TokenCostQuery,
  type TokenUsageSink
} from "@muse/observability";
import { CircuitBreakerRegistry } from "@muse/resilience";
import { RuntimeSettings, type RuntimeSettingsStore } from "@muse/runtime-settings";
import {
  type AgentRunHistoryStore,
  type DebugReplayCaptureStore,
  type HookTraceStore,
  type SessionTagStore
} from "@muse/runtime-state";
import {
  createSchedulerTools,
  DynamicScheduler,
  NodeCronScheduler,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker,
  type DistributedSchedulerLock,
  type ScheduledAgentExecutor,
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";
import {
  createDefaultToolExposurePolicy,
  createMuseTools,
  createRustRunnerTool,
  ToolRegistry,
  type MuseTool,
  type ToolExposurePolicy
} from "@muse/tools";
import { VoiceProviderRegistry } from "@muse/voice";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import {
  buildCalendarRegistry,
  buildNotesRegistry,
  buildTasksRegistry,
  buildVoiceRegistry,
  ensureNotesDir,
  resolveCredentialsFile,
  resolveNotesDir,
  resolveTasksFile
} from "./personal-providers.js";
import {
  createConversationSummaryStore,
  createDebugReplayCaptureStore,
  createHistoryStore,
  createHookTraceStore,
  createMcpSecurityPolicyStore,
  createMcpServerStore,
  createRuntimeSettingsStore,
  createSchedulerExecutionStore,
  createSchedulerLock,
  createSchedulerStore,
  createSessionTagStore,
  createTaskMemoryStore,
  createTracingPipeline,
  createUserMemoryStore
} from "./store-factories.js";

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
  };
  readonly modelProvider?: ModelProvider;
  readonly debugReplayCaptureStore: DebugReplayCaptureStore;
  readonly conversationSummaryStore: ConversationSummaryStore;
  readonly sessionTagStore: SessionTagStore;
  readonly taskMemoryStore: TaskMemoryStore & TaskMemoryMaintenance;
  readonly userMemoryStore: UserMemoryStore;
  readonly observability: {
    readonly budgetTracker: MonthlyBudgetTracker;
    readonly costAnomalyDetector: CostAnomalyDetector;
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
}

export interface ApiServerAssemblyOptions {
  readonly db?: Kysely<MuseDatabase>;
  readonly env?: MuseEnvironment;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function createMuseRuntimeAssembly(options: ApiServerAssemblyOptions = {}): MuseRuntimeAssembly {
  const env = options.env ?? process.env;
  const db = options.db;
  const authService = createAuthService(env, db);
  const agentSpecRegistry = db ? new KyselyAgentSpecRegistry(db) : new InMemoryAgentSpecRegistry();
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
  const costAnomalyDetector = new CostAnomalyDetector({
    minSamples: parseInteger(env.MUSE_COST_ANOMALY_MIN_SAMPLES, 10),
    thresholdMultiplier: parsePositiveFloat(env.MUSE_COST_ANOMALY_THRESHOLD_MULTIPLIER, 3),
    windowSize: parseInteger(env.MUSE_COST_ANOMALY_WINDOW_SIZE, 100)
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
  const tracingPipeline = createTracingPipeline(db);
  const { tracer, latencyQuery, tokenCostQuery, traceSink } = tracingPipeline;
  const tokenUsageSink: TokenUsageSink = createBudgetTrackingTokenUsageSink(
    budgetTracker,
    createCostAnomalyFeedingTokenUsageSink(costAnomalyDetector, tracingPipeline.tokenUsageSink)
  );
  const circuitBreakerRegistry = new CircuitBreakerRegistry({
    failureThreshold: parseInteger(env.MUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
    resetTimeoutMs: parseInteger(env.MUSE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 30_000)
  });
  const modelProvider = createModelProvider(env);
  const conversationSummaryStore = createConversationSummaryStore(db);
  const taskMemoryStore = createTaskMemoryStore(db, env);
  const userMemoryStore = createUserMemoryStore(db);
  const sessionTagStore = createSessionTagStore(db);
  const defaultModel = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  const mcpServerStore = createMcpServerStore(db, env);
  const initialMcpPolicy = {
    allowedServerNames: parseCsv(env.MUSE_MCP_ALLOWED_SERVERS),
    allowedStdioCommands: parseCsv(env.MUSE_MCP_ALLOWED_STDIO_COMMANDS),
    maxToolOutputLength: parseInteger(env.MUSE_MCP_MAX_TOOL_OUTPUT_LENGTH, 50_000)
  };
  const mcpSecurityPolicyStore = createMcpSecurityPolicyStore(db, initialMcpPolicy);
  const mcpSecurityPolicyProvider = new McpSecurityPolicyProvider(mcpSecurityPolicyStore, initialMcpPolicy);
  const allowPrivateMcpAddresses = parseBoolean(env.MUSE_MCP_ALLOW_PRIVATE_ADDRESSES, false);
  const mcpManager = new McpManager(mcpServerStore, {
    connector: new DefaultMcpTransportConnector({
      allowPrivateAddresses: allowPrivateMcpAddresses,
      requestTimeoutMs: parseInteger(env.MUSE_MCP_REQUEST_TIMEOUT_MS, 15_000)
    }),
    reconnect: {
      enabled: parseBoolean(env.MUSE_MCP_RECONNECT_ENABLED, true),
      initialDelayMs: parseInteger(env.MUSE_MCP_RECONNECT_INITIAL_DELAY_MS, 1_000),
      maxAttempts: parseInteger(env.MUSE_MCP_RECONNECT_MAX_ATTEMPTS, 3),
      maxDelayMs: parseInteger(env.MUSE_MCP_RECONNECT_MAX_DELAY_MS, 30_000)
    },
    validation: {
      allowPrivateAddresses: allowPrivateMcpAddresses
    },
    securityPolicyProvider: mcpSecurityPolicyProvider
  });
  const runnerTools = createRunnerTools(env);
  const museTools = parseBoolean(env.MUSE_TOOLS_ENABLED, true) ? createMuseTools() : [];
  const loopbackMcpTools = createLoopbackMcpToolsFromEnv(env);
  const notesDir = resolveNotesDir(env);
  ensureNotesDir(notesDir);
  const notesLoopbackTools = parseBoolean(env.MUSE_NOTES_ENABLED, true)
    ? createLoopbackMcpMuseTools(createNotesMcpServer({ notesDir }))
    : [];
  // Notes registry MCP surface (`muse.notes-multi`): only registered
  // when the user opts into >1 provider via MUSE_NOTES_PROVIDERS.
  // Default users (LocalDir only) get the inline `muse.notes` server
  // above and skip the registry overhead.
  const notesRegistry = parseBoolean(env.MUSE_NOTES_ENABLED, true)
    ? buildNotesRegistry(env)
    : undefined;
  const notesRegistryLoopbackTools = notesRegistry && notesRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createNotesRegistryMcpServer({ registry: notesRegistry }))
    : [];
  const calendarRegistry = buildCalendarRegistry(env);
  const calendarLoopbackTools = parseBoolean(env.MUSE_CALENDAR_ENABLED, true) && calendarRegistry.list().length > 0
    ? createLoopbackMcpMuseTools(createCalendarMcpServer({ registry: calendarRegistry }))
    : [];
  const tasksFile = resolveTasksFile(env);
  const tasksLoopbackTools = parseBoolean(env.MUSE_TASKS_ENABLED, true)
    ? createLoopbackMcpMuseTools(createTasksMcpServer({ file: tasksFile }))
    : [];
  // Tasks registry MCP surface (`muse.tasks-multi`): only registered
  // when the user opts into >1 provider via MUSE_TASKS_PROVIDERS.
  // Default users (LocalFile only) get the inline `muse.tasks` server
  // above and skip the registry overhead. Symmetric with notesRegistry.
  const tasksRegistry = parseBoolean(env.MUSE_TASKS_ENABLED, true)
    ? buildTasksRegistry(env)
    : undefined;
  const tasksRegistryLoopbackTools = tasksRegistry && tasksRegistry.list().length >= 2
    ? createLoopbackMcpMuseTools(createTasksRegistryMcpServer({ registry: tasksRegistry }))
    : [];
  let schedulerService: DynamicScheduler | undefined;
  const toolRegistry = new DynamicToolRegistry([
    () => museTools,
    () => loopbackMcpTools,
    () => notesLoopbackTools,
    () => notesRegistryLoopbackTools,
    () => calendarLoopbackTools,
    () => tasksLoopbackTools,
    () => tasksRegistryLoopbackTools,
    () => runnerTools,
    () => mcpManager.toMuseTools(),
    () => schedulerService ? createSchedulerTools(schedulerService) : []
  ]);
  const runtimeHooks = [
    ...createDefaultRuntimeHooks(env),
    ...(parseBoolean(env.MUSE_USER_MEMORY_AUTO_EXTRACT, false) && modelProvider && defaultModel
      ? [createUserMemoryAutoExtractHook({
        model: env.MUSE_USER_MEMORY_AUTO_EXTRACT_MODEL ?? defaultModel,
        modelProvider,
        store: userMemoryStore
      }) as HookStage]
      : [])
  ];
  const agentRuntime = modelProvider && defaultModel
    ? createAgentRuntime({
      agentSpecResolver,
      cacheMetrics,
      circuitBreaker: circuitBreakerRegistry.get("model.generate"),
      contextWindow: {
        maxContextWindowTokens: parseInteger(env.MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS, 128_000),
        outputReserveTokens: parseInteger(env.MUSE_LLM_MAX_OUTPUT_TOKENS, 4_096)
      },
      historyStore,
      hooks: runtimeHooks,
      hookTraceStore,
      metrics: runtimeAgentMetrics,
      modelProvider,
      guards: createInputGuards(env),
      outputGuards: createOutputGuards(env),
      requestTimeoutMs: parseInteger(env.MUSE_MODEL_REQUEST_TIMEOUT_MS, 45_000),
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
        : undefined
    })
    : undefined;
  const schedulerStore = createSchedulerStore(db, env);
  const schedulerExecutionStore = createSchedulerExecutionStore(db, env);
  const schedulerLock = createSchedulerLock(db, env);
  schedulerService = new DynamicScheduler({
    dispatcher: new ScheduledJobDispatcher({
      agentExecutor: createScheduledAgentExecutor(() => agentRuntime, defaultModel),
      mcpInvoker: new ScheduledMcpToolInvoker(mcpManager)
    }),
    cronScheduler: parseBoolean(env.MUSE_SCHEDULER_CRON_ENABLED, true)
      ? new NodeCronScheduler()
      : undefined,
    executionStore: schedulerExecutionStore,
    distributedLock: schedulerLock,
    store: schedulerStore
  });

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
    mcp: {
      manager: mcpManager,
      securityPolicyProvider: mcpSecurityPolicyProvider,
      securityPolicyStore: mcpSecurityPolicyStore,
      serverStore: mcpServerStore
    },
    modelProvider,
    debugReplayCaptureStore,
    conversationSummaryStore,
    sessionTagStore,
    taskMemoryStore,
    userMemoryStore,
    observability: {
      budgetTracker,
      costAnomalyDetector,
      driftDetector,
      followupSuggestionStore,
      latencyQuery,
      metrics: agentMetrics,
      sloEvaluator,
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
    voice: buildVoiceRegistry(env)
  };
}


export function createApiServerOptions(options: ApiServerAssemblyOptions = {}) {
  const env = options.env ?? process.env;
  const assembly = createMuseRuntimeAssembly(options);

  return {
    admin: {
      cache: {
        metrics: assembly.cache.metrics,
        responseCache: assembly.cache.responseCache
      },
      observability: assembly.observability,
      resilience: assembly.resilience
    },
    agentRuntime: assembly.agentRuntime,
    agentSpecRegistry: assembly.agentSpecRegistry,
    authService: assembly.authService,
    cors: {
      allowCredentials: true
    },
    debugReplayCaptureStore: assembly.debugReplayCaptureStore,
    defaultModel: assembly.defaultModel,
    latencyQuery: assembly.observability.latencyQuery,
    tokenCostQuery: assembly.observability.tokenCostQuery,
    agentCardIdentity: {
      description: parseOptionalString(env.MUSE_AGENT_CARD_DESCRIPTION) ?? "Muse provider-neutral AI conductor",
      name: parseOptionalString(env.MUSE_AGENT_CARD_NAME) ?? "muse",
      version: parseOptionalString(env.MUSE_AGENT_CARD_VERSION) ?? "1.0.0"
    },
    agentCardToolProvider: () =>
      assembly.toolRegistry.list().map((tool) => ({
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema as Record<string, unknown> | null,
        name: tool.definition.name
      })),
    toolCatalogProvider: () =>
      assembly.toolRegistry.list().map((tool) => ({
        description: tool.definition.description,
        inputSchema: tool.definition.inputSchema as Record<string, unknown> | null,
        name: tool.definition.name,
        risk: tool.definition.risk,
        ...(tool.definition.keywords && tool.definition.keywords.length > 0
          ? { keywords: [...tool.definition.keywords] }
          : {}),
        ...(tool.definition.scopes && tool.definition.scopes.length > 0
          ? { scopes: [...tool.definition.scopes] }
          : {}),
        ...(tool.definition.dependsOn && tool.definition.dependsOn.length > 0
          ? { dependsOn: [...tool.definition.dependsOn] }
          : {})
      })),
    museObservabilitySnapshot: () =>
      createMuseObservabilitySnapshotProvider({
        budgetTracker: assembly.observability.budgetTracker,
        costAnomalyDetector: assembly.observability.costAnomalyDetector,
        driftDetector: assembly.observability.driftDetector,
        followupSuggestionStore: assembly.observability.followupSuggestionStore,
        latencyQuery: assembly.observability.latencyQuery,
        sloEvaluator: assembly.observability.sloEvaluator,
        tokenCostQuery: assembly.observability.tokenCostQuery
      }).snapshot(),
    historyStore: assembly.historyStore,
    mcp: {
      manager: assembly.mcp.manager,
      securityPolicyProvider: assembly.mcp.securityPolicyProvider,
      securityPolicyStore: assembly.mcp.securityPolicyStore
    },
    modelProvider: assembly.modelProvider,
    requireAuth: assembly.requireAuth,
    runtimeSettings: assembly.runtimeSettings,
    scheduler: assembly.scheduler,
    sessionTagStore: assembly.sessionTagStore,
    taskMemoryMaintenance: assembly.taskMemoryStore,
    userMemoryStore: assembly.userMemoryStore,
    conversationSummaryStore: assembly.conversationSummaryStore,
    calendar: assembly.calendar,
    calendarCredentialStore: new FileCalendarCredentialStore(resolveCredentialsFile(env)),
    notesDir: resolveNotesDir(env),
    ...(assembly.notesProviderRegistry ? { notesProviderRegistry: assembly.notesProviderRegistry } : {}),
    tasksFile: resolveTasksFile(env),
    ...(assembly.tasksProviderRegistry ? { tasksProviderRegistry: assembly.tasksProviderRegistry } : {}),
    voice: assembly.voice
  };
}

export function requireEnv(env: MuseEnvironment, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${key}`);
  }

  return value;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function createPersonalToolExposurePolicy(env: MuseEnvironment): ToolExposurePolicy {
  // Personal pivot: the agent operates in a single-user environment
  // with no shared workspace to protect, so the workspace-mutation-
  // intent heuristic is the wrong default. Allow `write` tools (notes
  // save, calendar add/update/delete, etc.) without requiring a
  // workspace-edit prompt shape. Operators can still tighten via the
  // env var if running Muse in a multi-user context.
  return createDefaultToolExposurePolicy({
    allowWriteWithoutMutationIntent: parseBoolean(env.MUSE_ALLOW_WRITE_WITHOUT_MUTATION_INTENT, true)
  });
}


export function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createModelProvider(env: MuseEnvironment): ModelProvider | undefined {
  const defaultModel = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  const baseUrl = parseOptionalString(env.MUSE_MODEL_BASE_URL);

  if (!defaultModel) {
    return undefined;
  }

  const explicitProviderId = parseOptionalString(env.MUSE_MODEL_PROVIDER_ID);
  const providerId = explicitProviderId
    ?? (baseUrl ? "openai-compatible" : parseModelName(defaultModel).providerId)
    ?? "openai-compatible";
  const models = parseCsv(env.MUSE_MODEL_LIST) ?? [parseModelName(defaultModel).modelId];

  switch (providerId) {
    case "diagnostic":
      return new DiagnosticModelProvider({
        defaultModel,
        models
      });
    case "anthropic":
      return new AnthropicProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.ANTHROPIC_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "ollama":
      return new OllamaProvider({
        baseUrl,
        defaultModel,
        models
      });
    case "openai":
      return new OpenAIProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl,
        defaultModel,
        models
      });
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENROUTER_API_KEY),
        appName: parseOptionalString(env.MUSE_APP_NAME) ?? "Muse",
        baseUrl,
        defaultModel,
        models,
        siteUrl: parseOptionalString(env.MUSE_SITE_URL)
      });
    default:
      if (!baseUrl) {
        return undefined;
      }

      return new OpenAICompatibleProvider({
        apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
        baseUrl,
        defaultModel,
        id: providerId,
        models
      });
  }
}

function createScheduledAgentExecutor(
  runtime: () => AgentRuntime | undefined,
  defaultModel: string | undefined
): ScheduledAgentExecutor {
  return {
    async execute(job) {
      const agentRuntime = runtime();

      if (!agentRuntime) {
        throw new ConfigurationError("Scheduled agent execution requires a configured model provider");
      }

      const result = await agentRuntime.run({
        messages: [
          ...(job.agentSystemPrompt ? [{ content: job.agentSystemPrompt, role: "system" as const }] : []),
          { content: job.agentPrompt ?? "", role: "user" }
        ],
        metadata: {
          jobId: job.id,
          scheduler: true
        },
        model: job.agentModel ?? defaultModel ?? "default"
      });

      return result.response.output;
    }
  };
}

/**
 * Personal-Muse: no env-driven default runtime hooks. Muse
 * deployments wire hooks directly when assembling the runtime.
 */
function createDefaultRuntimeHooks(_env: MuseEnvironment): readonly HookStage[] {
  return [];
}

function createInputGuards(env: MuseEnvironment): readonly GuardStage[] {
  if (!parseBoolean(env.MUSE_INPUT_GUARDS_ENABLED, true)) {
    return [];
  }

  const guards: GuardStage[] = [];

  if (parseBoolean(env.MUSE_INPUT_GUARD_INJECTION_ENABLED, true)) {
    guards.push(createInjectionInputGuard());
  }

  if (parseBoolean(env.MUSE_INPUT_GUARD_PII_ENABLED, true)) {
    guards.push(createPiiInputGuard());
  }

  return guards;
}

function createOutputGuards(env: MuseEnvironment): readonly OutputGuardStage[] {
  if (!parseBoolean(env.MUSE_OUTPUT_GUARDS_ENABLED, true)) {
    return [];
  }

  const guards: OutputGuardStage[] = [];

  if (parseBoolean(env.MUSE_OUTPUT_GUARD_PII_MASK_ENABLED, true)) {
    guards.push(createPiiMaskingOutputGuard());
  }

  const canaryTokens = parseCsv(env.MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_CANARY_TOKENS);
  if (parseBoolean(env.MUSE_OUTPUT_GUARD_SYSTEM_PROMPT_LEAK_ENABLED, false) && canaryTokens && canaryTokens.length > 0) {
    guards.push(createSystemPromptLeakageOutputGuard({ canaryTokens }));
  }

  return guards;
}

/**
 * Parses MUSE_RESPONSE_LOCALES (CSV, default "ko,en") into the set of
 * locale codes whose response filters should be active. Keeping Korean as
 * a default preserves UX for the original Korean operator base; adding
 * English by default unlocks the same casual-lure / greeting cleanup for
 * English-speaking users.
 */
function responseLocales(env: MuseEnvironment): ReadonlySet<"ko" | "en"> {
  const raw = parseCsv(env.MUSE_RESPONSE_LOCALES) ?? ["ko", "en"];
  const result = new Set<"ko" | "en">();
  for (const entry of raw) {
    const lower = entry.trim().toLowerCase();
    if (lower === "ko" || lower === "en") {
      result.add(lower);
    }
  }
  return result;
}

function buildCasualLureFilters(env: MuseEnvironment) {
  if (!parseBoolean(env.MUSE_RESPONSE_CASUAL_LURE_STRIP_ENABLED, true)) {
    return [];
  }
  const locales = responseLocales(env);
  return [
    ...(locales.has("ko") ? [createCasualLureStripResponseFilter()] : []),
    ...(locales.has("en") ? [createEnglishCasualLureStripResponseFilter()] : [])
  ];
}

function buildGreetingStripFilters(env: MuseEnvironment) {
  if (!parseBoolean(env.MUSE_RESPONSE_GREETING_STRIP_ENABLED, true)) {
    return [];
  }
  const locales = responseLocales(env);
  return [
    ...(locales.has("ko") ? [createGreetingStripResponseFilter()] : []),
    ...(locales.has("en") ? [createEnglishGreetingStripResponseFilter()] : [])
  ];
}

function createResponseFilters(env: MuseEnvironment) {
  const maxLength = parseInteger(env.MUSE_RESPONSE_MAX_LENGTH, 0);

  return [
    ...(maxLength > 0 ? [createMaxLengthResponseFilter({ maxLength })] : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SANITIZED_TEXT_FILTER_ENABLED, true)
      ? [createSanitizedTextResponseFilter({
          inlineReplacement: parseOptionalString(env.MUSE_RESPONSE_SANITIZED_TEXT_REPLACEMENT)
            ?? (responseLocales(env).has("en") && !responseLocales(env).has("ko")
              ? "(redacted)"
              : "(보안 처리됨)")
        })]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_MARKDOWN_STRIP_FILTER_ENABLED, true)
      ? [createMarkdownStripResponseFilter()]
      : []),
    ...buildCasualLureFilters(env),
    ...buildGreetingStripFilters(env),
    ...(parseBoolean(env.MUSE_RESPONSE_FABRICATION_REFUSAL_ENABLED, true)
      ? [createFabricationRequestRefusalFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SOURCE_FILTER_ENABLED, true)
      ? [createSourceBlockResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_VERIFIED_SOURCES_ENABLED, true)
      ? [createVerifiedSourcesResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_TOOL_RESULT_QUALITY_AUDIT_ENABLED, true)
      ? [createToolResultQualityAuditFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_COUNT_INJECTION_ENABLED, true)
      ? [createResponseCountInjectionFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_COUNT_CONSISTENCY_ENABLED, true)
      ? [createResponseCountConsistencyFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_ZERO_RESULT_OVERCLAIM_FILTER_ENABLED, true)
      ? [createZeroResultOverclaimResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_STRUCTURED_OUTPUT_FILTER_ENABLED, true)
      ? [createStructuredOutputResponseFilter()]
      : [])
  ];
}

function createRunnerTools(env: MuseEnvironment): readonly MuseTool[] {
  if (!parseBoolean(env.MUSE_RUNNER_ENABLED, false)) {
    return [];
  }

  return [
    createRustRunnerTool({
      runnerPath: parseOptionalString(env.MUSE_RUNNER_PATH) ?? "muse-runner"
    })
  ];
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

  if (parseBoolean(env.MUSE_LOOPBACK_MCP_ENABLED, false)) {
    servers.push(...createDefaultLoopbackMcpServers());
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

function parseSloErrorRate(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseCsv(value: string | undefined): readonly string[] | undefined {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries && entries.length > 0 ? entries : undefined;
}

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function createAuthService(env: MuseEnvironment, db: Kysely<MuseDatabase> | undefined): MuseAuth | undefined {
  const jwtSecret = env.MUSE_AUTH_JWT_SECRET?.trim();

  if (!jwtSecret) {
    return undefined;
  }

  const jwt = new JwtTokenProvider({
    jwtExpirationMs: parseInteger(env.MUSE_AUTH_JWT_EXPIRATION_MS, 86_400_000),
    jwtSecret
  });

  if (db) {
    const userStore = new KyselyUserStore(db);
    const provider = new KyselyAuthProvider(userStore);
    return new AsyncAuth({
      authProvider: provider,
      jwt,
      userStore
    });
  }

  const userStore = new InMemoryUserStore(parseInteger(env.MUSE_AUTH_MAX_USERS, 10_000));
  const provider = new DefaultAuthProvider(userStore);
  return new Auth({
    authProvider: provider,
    jwt,
    userStore
  });
}

class DynamicToolRegistry extends ToolRegistry {
  constructor(private readonly sources: readonly (() => readonly MuseTool[])[]) {
    super();
  }

  override get(name: string): MuseTool | undefined {
    return super.get(name) ?? this.dynamicTools().find((tool) => tool.definition.name === name);
  }

  override list(): readonly MuseTool[] {
    return [...super.list(), ...this.dynamicTools()];
  }

  private dynamicTools(): readonly MuseTool[] {
    const byName = new Map<string, MuseTool>();

    for (const source of this.sources) {
      for (const tool of source()) {
        byName.set(tool.definition.name, tool);
      }
    }

    return [...byName.values()];
  }
}
