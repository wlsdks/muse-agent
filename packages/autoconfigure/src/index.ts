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
  createSlackUserIdMaskResponseFilter,
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
  InMemoryMcpSecurityPolicyStore,
  InMemoryMcpServerStore,
  KyselyMcpSecurityPolicyStore,
  KyselyMcpServerStore,
  McpManager,
  McpSecurityPolicyProvider,
  createDefaultLoopbackMcpServers,
  createFetchMcpServer,
  createFilesystemMcpServer,
  createLoopbackMcpMuseTools,
  type LoopbackMcpServer,
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServerStore
} from "@muse/mcp";
import {
  InMemoryTaskMemoryStore,
  InMemoryConversationSummaryStore,
  InMemoryUserMemoryStore,
  KyselyConversationSummaryStore,
  KyselyTaskMemoryStore,
  KyselyUserMemoryStore,
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
  InMemoryRagIngestionCandidateStore,
  InMemoryRagDocumentStore,
  InMemoryRagIngestionPolicyStore,
  KyselyRagDocumentStore,
  KyselyRagIngestionCandidateStore,
  KyselyRagIngestionPolicyStore,
  type RagDocumentStore,
  type RagIngestionCandidateStore,
  type RagIngestionPolicyStore
} from "@muse/rag";
import {
  CostAnomalyDetector,
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  InMemoryLatencyQuery,
  InMemoryMuseTracer,
  InMemoryTokenCostQuery,
  InMemoryTokenUsageSink,
  InMemoryTraceEventSink,
  KyselyLatencyQuery,
  KyselyTokenCostQuery,
  KyselyTokenUsageSink,
  KyselyTraceEventSink,
  MonthlyBudgetTracker,
  PersistedMuseTracer,
  PromptDriftDetector,
  SloAlertEvaluator,
  createBudgetTrackingTokenUsageSink,
  createCostAnomalyFeedingTokenUsageSink,
  createDerivedAgentMetrics,
  createJarvisObservabilitySnapshotProvider,
  type AgentMetrics,
  type JarvisObservabilitySnapshot,
  type LatencyQuery,
  type MuseTracer,
  type QueryableTraceEventSink,
  type TokenCostQuery,
  type TokenUsageSink
} from "@muse/observability";
import { CircuitBreakerRegistry } from "@muse/resilience";
import { createDefaultRagPipeline } from "./rag-query.js";
import {
  InMemoryRuntimeSettingsStore,
  KyselyRuntimeSettingsStore,
  RuntimeSettings,
  type RuntimeSettingsStore
} from "@muse/runtime-settings";
import {
  InMemoryAdminOperationsStore,
  InMemoryAgentRunHistoryStore,
  InMemoryDebugReplayCaptureStore,
  InMemoryHookTraceStore,
  InMemoryMetricAuditEventStore,
  InMemorySessionTagStore,
  KyselyAdminOperationsStore,
  KyselyAgentRunHistoryStore,
  KyselyDebugReplayCaptureStore,
  KyselyHookTraceStore,
  KyselyMetricAuditEventStore,
  KyselySessionTagStore,
  type AdminOperationsStore,
  type AgentRunHistoryStore,
  type DebugReplayCaptureStore,
  type HookTraceStore,
  type MetricAuditEventStore,
  type SessionTagStore
} from "@muse/runtime-state";
import {
  createSchedulerTools,
  DynamicScheduler,
  InMemoryDistributedSchedulerLock,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  KyselyDistributedSchedulerLock,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore,
  NodeCronScheduler,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker,
  type DistributedSchedulerLock,
  type ScheduledAgentExecutor,
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";
import { createJarvisTools, createRustRunnerTool, ToolRegistry, type MuseTool } from "@muse/tools";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

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
  readonly adminOperationsStore: AdminOperationsStore;
  readonly mcp: {
    readonly manager: McpManager;
    readonly securityPolicyProvider: McpSecurityPolicyProvider;
    readonly securityPolicyStore: McpSecurityPolicyStore;
    readonly serverStore: McpServerStore;
  };
  readonly modelProvider?: ModelProvider;
  readonly metricAuditEventStore: MetricAuditEventStore;
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
  readonly ragIngestion: {
    readonly candidateStore: RagIngestionCandidateStore;
    readonly documentStore: RagDocumentStore;
    readonly policyStore: RagIngestionPolicyStore;
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
  const adminOperationsStore = createAdminOperationsStore(db);
  const metricAuditEventStore = createMetricAuditEventStore(db);
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
  const ragIngestionPolicyStore = createRagIngestionPolicyStore(db);
  const ragIngestionCandidateStore = createRagIngestionCandidateStore(db);
  const ragDocumentStore = createRagDocumentStore(db);
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
  const jarvisTools = parseBoolean(env.MUSE_JARVIS_TOOLS_ENABLED, true) ? createJarvisTools() : [];
  const loopbackMcpTools = createLoopbackMcpToolsFromEnv(env);
  let schedulerService: DynamicScheduler | undefined;
  const toolRegistry = new DynamicToolRegistry([
    () => jarvisTools,
    () => loopbackMcpTools,
    () => runnerTools,
    () => mcpManager.toMuseTools(),
    () => schedulerService ? createSchedulerTools(schedulerService) : []
  ]);
  const runtimeHooks = createDefaultRuntimeHooks(env);
  const ragPipeline = createDefaultRagPipeline({
    documentStore: ragDocumentStore,
    env,
    ...(modelProvider ? { modelProvider } : {}),
    ...(defaultModel ? { defaultModel } : {})
  });
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
      ...(ragPipeline ? { ragPipeline } : {}),
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
    adminOperationsStore,
    mcp: {
      manager: mcpManager,
      securityPolicyProvider: mcpSecurityPolicyProvider,
      securityPolicyStore: mcpSecurityPolicyStore,
      serverStore: mcpServerStore
    },
    modelProvider,
    metricAuditEventStore,
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
    ragIngestion: {
      candidateStore: ragIngestionCandidateStore,
      documentStore: ragDocumentStore,
      policyStore: ragIngestionPolicyStore
    },
    requireAuth: parseBoolean(env.MUSE_REQUIRE_AUTH, Boolean(authService)),
    resilience: {
      circuitBreakerRegistry
    },
    runtimeSettings: new RuntimeSettings(createRuntimeSettingsStore(db)),
    toolRegistry,
    scheduler: {
      executionStore: schedulerExecutionStore,
      service: schedulerService,
      store: schedulerStore
    }
  };
}

function createHistoryStore(db: Kysely<MuseDatabase> | undefined): AgentRunHistoryStore {
  return db ? new KyselyAgentRunHistoryStore(db) : new InMemoryAgentRunHistoryStore();
}

function createTracer(db: Kysely<MuseDatabase> | undefined): MuseTracer {
  return db ? new PersistedMuseTracer(new KyselyTraceEventSink(db)) : new InMemoryMuseTracer();
}

function createTracingPipeline(db: Kysely<MuseDatabase> | undefined): {
  readonly tracer: MuseTracer;
  readonly latencyQuery: LatencyQuery;
  readonly tokenUsageSink: TokenUsageSink;
  readonly tokenCostQuery: TokenCostQuery;
  readonly traceSink?: QueryableTraceEventSink;
} {
  if (db) {
    const tokenUsageSink = new KyselyTokenUsageSink(db);
    return {
      latencyQuery: new KyselyLatencyQuery(db),
      tokenCostQuery: new KyselyTokenCostQuery(db),
      tokenUsageSink,
      tracer: new PersistedMuseTracer(new KyselyTraceEventSink(db))
    };
  }

  const traceSink: QueryableTraceEventSink = new InMemoryTraceEventSink();
  const tokenSink = new InMemoryTokenUsageSink();
  return {
    latencyQuery: new InMemoryLatencyQuery(traceSink),
    tokenCostQuery: new InMemoryTokenCostQuery(tokenSink),
    tokenUsageSink: tokenSink,
    traceSink,
    tracer: new PersistedMuseTracer(traceSink)
  };
}

function createHookTraceStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): HookTraceStore {
  return db
    ? new KyselyHookTraceStore(db)
    : new InMemoryHookTraceStore({ maxTraces: parseInteger(env.MUSE_HOOK_TRACE_MAX_ENTRIES, 10_000) });
}

function createAdminOperationsStore(db: Kysely<MuseDatabase> | undefined): AdminOperationsStore {
  return db ? new KyselyAdminOperationsStore(db) : new InMemoryAdminOperationsStore();
}

function createMetricAuditEventStore(db: Kysely<MuseDatabase> | undefined): MetricAuditEventStore {
  return db ? new KyselyMetricAuditEventStore(db) : new InMemoryMetricAuditEventStore();
}

function createDebugReplayCaptureStore(db: Kysely<MuseDatabase> | undefined): DebugReplayCaptureStore {
  return db ? new KyselyDebugReplayCaptureStore(db) : new InMemoryDebugReplayCaptureStore();
}

function createRuntimeSettingsStore(db: Kysely<MuseDatabase> | undefined): RuntimeSettingsStore {
  return db ? new KyselyRuntimeSettingsStore(db) : new InMemoryRuntimeSettingsStore();
}

function createTaskMemoryStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): InMemoryTaskMemoryStore | KyselyTaskMemoryStore {
  const retentionMs = parseInteger(env.MUSE_TASK_MEMORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000);
  return db
    ? new KyselyTaskMemoryStore(db, { retentionMs })
    : new InMemoryTaskMemoryStore({
      maxTasks: parseInteger(env.MUSE_TASK_MEMORY_MAX_TASKS, 10_000),
      retentionMs
    });
}

function createConversationSummaryStore(db: Kysely<MuseDatabase> | undefined): ConversationSummaryStore {
  return db ? new KyselyConversationSummaryStore(db) : new InMemoryConversationSummaryStore();
}

function createUserMemoryStore(db: Kysely<MuseDatabase> | undefined): UserMemoryStore {
  return db ? new KyselyUserMemoryStore(db) : new InMemoryUserMemoryStore();
}

function createSessionTagStore(db: Kysely<MuseDatabase> | undefined): SessionTagStore {
  return db ? new KyselySessionTagStore(db) : new InMemorySessionTagStore();
}

function createMcpServerStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): McpServerStore {
  return db
    ? new KyselyMcpServerStore(db)
    : new InMemoryMcpServerStore({ maxServers: parseInteger(env.MUSE_MCP_MAX_SERVERS, 1_000) });
}

function createMcpSecurityPolicyStore(
  db: Kysely<MuseDatabase> | undefined,
  initial: McpSecurityPolicyInput
): McpSecurityPolicyStore {
  return db ? new KyselyMcpSecurityPolicyStore(db) : new InMemoryMcpSecurityPolicyStore({ initial });
}

function createSchedulerStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): ScheduledJobStore {
  return db
    ? new KyselyScheduledJobStore(db)
    : new InMemoryScheduledJobStore({ maxJobs: parseInteger(env.MUSE_SCHEDULER_MAX_JOBS, 1_000) });
}

function createSchedulerExecutionStore(
  db: Kysely<MuseDatabase> | undefined,
  env: MuseEnvironment
): ScheduledJobExecutionStore {
  return db
    ? new KyselyScheduledJobExecutionStore(db)
    : new InMemoryScheduledJobExecutionStore({
      maxEntries: parseInteger(env.MUSE_SCHEDULER_MAX_EXECUTIONS, 200)
    });
}

function createSchedulerLock(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): DistributedSchedulerLock {
  const ownerId = env.MUSE_SCHEDULER_OWNER_ID;
  return db
    ? new KyselyDistributedSchedulerLock(db, { ownerId })
    : new InMemoryDistributedSchedulerLock({ ownerId });
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
      metricEventStore: assembly.metricAuditEventStore,
      operations: assembly.adminOperationsStore,
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
    jarvisObservabilitySnapshot: () =>
      createJarvisObservabilitySnapshotProvider({
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
    ragIngestion: assembly.ragIngestion,
    runtimeSettings: assembly.runtimeSettings,
    scheduler: assembly.scheduler,
    sessionTagStore: assembly.sessionTagStore,
    taskMemoryMaintenance: assembly.taskMemoryStore,
    userMemoryStore: assembly.userMemoryStore,
    conversationSummaryStore: assembly.conversationSummaryStore
  };
}

function createRagIngestionPolicyStore(db: Kysely<MuseDatabase> | undefined): RagIngestionPolicyStore {
  return db ? new KyselyRagIngestionPolicyStore(db) : new InMemoryRagIngestionPolicyStore();
}

function createRagIngestionCandidateStore(db: Kysely<MuseDatabase> | undefined): RagIngestionCandidateStore {
  return db ? new KyselyRagIngestionCandidateStore(db) : new InMemoryRagIngestionCandidateStore();
}

function createRagDocumentStore(db: Kysely<MuseDatabase> | undefined): RagDocumentStore {
  return db ? new KyselyRagDocumentStore(db) : new InMemoryRagDocumentStore();
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
 * Personal-Muse: no env-driven default runtime hooks. JARVIS-style
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
    ...(parseBoolean(env.MUSE_RESPONSE_SLACK_USER_ID_MASK_ENABLED, true)
      ? [createSlackUserIdMaskResponseFilter()]
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
 * `GET /api/jarvis/loopback` lists what is available regardless of which are
 * actually wired here.
 */
export {
  composeQueryTransformers,
  createDefaultRagPipeline,
  createDefaultRagQueryTransformer,
  createDocumentStoreRetriever,
  type CreateDefaultRagPipelineArgs,
  type CreateDefaultRagQueryTransformerArgs,
  type RagPipelineEnv,
  type RagQueryTransformerEnv
} from "./rag-query.js";

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
