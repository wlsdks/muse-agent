import {
  createAgentRuntime,
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
  createSourceBlockResponseFilter,
  createSlackUserIdMaskResponseFilter,
  createStructuredOutputResponseFilter,
  createToolResultQualityAuditFilter,
  createZeroResultOverclaimResponseFilter,
  type AgentRuntime
} from "@muse/agent-core";
import {
  InMemoryAgentSpecRegistry,
  KyselyAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import {
  AuthService,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  JwtTokenProvider
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
  type McpSecurityPolicyInput,
  type McpSecurityPolicyStore,
  type McpServerStore
} from "@muse/mcp";
import { InMemoryTaskMemoryStore } from "@muse/memory";
import { OpenAICompatibleProvider, type ModelProvider } from "@muse/model";
import { InMemoryAgentMetrics, InMemoryFollowupSuggestionStore, InMemoryMuseTracer } from "@muse/observability";
import { CircuitBreakerRegistry } from "@muse/resilience";
import {
  InMemoryRuntimeSettingsStore,
  KyselyRuntimeSettingsStore,
  RuntimeSettingsService,
  type RuntimeSettingsStore
} from "@muse/runtime-settings";
import {
  InMemoryAdminOperationsStore,
  InMemoryAgentRunHistoryStore,
  InMemoryHookTraceStore,
  InMemoryPendingApprovalStore,
  KyselyAdminOperationsStore,
  KyselyAgentRunHistoryStore,
  KyselyHookTraceStore,
  KyselyPendingApprovalStore,
  type AdminOperationsStore,
  type AgentRunHistoryStore,
  type HookTraceStore,
  type PendingApprovalStore
} from "@muse/runtime-state";
import {
  DynamicSchedulerService,
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
import { ToolRegistry, type MuseTool } from "@muse/tools";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

export interface MuseEnvironment {
  readonly [key: string]: string | undefined;
}

export interface MuseRuntimeAssembly {
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authService?: AuthService;
  readonly cache: {
    readonly metrics: InMemoryCacheMetricsRecorder;
    readonly responseCache: InMemoryResponseCache;
    readonly statsStore: InMemoryCacheStatsStore;
  };
  readonly defaultModel?: string;
  readonly historyStore: AgentRunHistoryStore;
  readonly hookTraceStore: HookTraceStore;
  readonly adminOperationsStore: AdminOperationsStore;
  readonly approvalStore: PendingApprovalStore;
  readonly mcp: {
    readonly manager: McpManager;
    readonly securityPolicyProvider: McpSecurityPolicyProvider;
    readonly securityPolicyStore: McpSecurityPolicyStore;
    readonly serverStore: McpServerStore;
  };
  readonly modelProvider?: ModelProvider;
  readonly taskMemoryStore: InMemoryTaskMemoryStore;
  readonly observability: {
    readonly followupSuggestionStore: InMemoryFollowupSuggestionStore;
    readonly metrics: InMemoryAgentMetrics;
    readonly tracer: InMemoryMuseTracer;
  };
  readonly requireAuth: boolean;
  readonly resilience: {
    readonly circuitBreakerRegistry: CircuitBreakerRegistry;
  };
  readonly runtimeSettings: RuntimeSettingsService;
  readonly scheduler: {
    readonly executionStore: ScheduledJobExecutionStore;
    readonly service: DynamicSchedulerService;
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
  const userStore = new InMemoryUserStore(parseInteger(env.MUSE_AUTH_MAX_USERS, 10_000));
  const authService = createAuthService(env, userStore);
  const agentSpecRegistry = db ? new KyselyAgentSpecRegistry(db) : new InMemoryAgentSpecRegistry();
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
  const historyStore = createHistoryStore(db);
  const hookTraceStore = createHookTraceStore(db, env);
  const adminOperationsStore = createAdminOperationsStore(db);
  const approvalStore = createApprovalStore(db, env);
  const cacheStatsStore = new InMemoryCacheStatsStore();
  const cacheMetrics = new InMemoryCacheMetricsRecorder(cacheStatsStore);
  const responseCache = new InMemoryResponseCache({
    maxSize: parseInteger(env.MUSE_CACHE_MAX_SIZE, 1_000),
    ttlMs: parseInteger(env.MUSE_CACHE_TTL_MS, 3_600_000)
  });
  const agentMetrics = new InMemoryAgentMetrics();
  const followupSuggestionStore = new InMemoryFollowupSuggestionStore({
    maxEvents: parseInteger(env.MUSE_FOLLOWUP_SUGGESTION_MAX_EVENTS, 50_000),
    retentionMs: parseInteger(env.MUSE_FOLLOWUP_SUGGESTION_RETENTION_MS, 72 * 60 * 60 * 1000)
  });
  const tracer = new InMemoryMuseTracer();
  const circuitBreakerRegistry = new CircuitBreakerRegistry({
    failureThreshold: parseInteger(env.MUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
    resetTimeoutMs: parseInteger(env.MUSE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 30_000)
  });
  const modelProvider = createModelProvider(env);
  const taskMemoryStore = new InMemoryTaskMemoryStore({
    maxTasks: parseInteger(env.MUSE_TASK_MEMORY_MAX_TASKS, 10_000),
    retentionMs: parseInteger(env.MUSE_TASK_MEMORY_RETENTION_MS, 30 * 24 * 60 * 60 * 1_000)
  });
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
  const toolRegistry = new DynamicToolRegistry([() => mcpManager.toMuseTools()]);
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
      hookTraceStore,
      metrics: agentMetrics,
      modelProvider,
      requestTimeoutMs: parseInteger(env.MUSE_MODEL_REQUEST_TIMEOUT_MS, 45_000),
      toolApprovalPolicy: createToolApprovalPolicy(env),
      toolApprovalStore: approvalStore,
      responseFilters: createResponseFilters(env),
      responseCache: parseBoolean(env.MUSE_CACHE_ENABLED, true) ? responseCache : undefined,
      retry: {
        initialDelayMs: parseInteger(env.MUSE_RETRY_INITIAL_DELAY_MS, 100),
        maxAttempts: parseInteger(env.MUSE_RETRY_MAX_ATTEMPTS, 3)
      },
      tracer,
      toolRegistry
    })
    : undefined;
  const schedulerStore = createSchedulerStore(db, env);
  const schedulerExecutionStore = createSchedulerExecutionStore(db, env);
  const schedulerLock = createSchedulerLock(db, env);
  const schedulerService = new DynamicSchedulerService({
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
    approvalStore,
    mcp: {
      manager: mcpManager,
      securityPolicyProvider: mcpSecurityPolicyProvider,
      securityPolicyStore: mcpSecurityPolicyStore,
      serverStore: mcpServerStore
    },
    modelProvider,
    taskMemoryStore,
    observability: {
      followupSuggestionStore,
      metrics: agentMetrics,
      tracer
    },
    requireAuth: parseBoolean(env.MUSE_REQUIRE_AUTH, Boolean(authService)),
    resilience: {
      circuitBreakerRegistry
    },
    runtimeSettings: new RuntimeSettingsService(createRuntimeSettingsStore(db)),
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

function createApprovalStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): PendingApprovalStore {
  const defaultTimeoutMs = parseInteger(env.MUSE_APPROVAL_TIMEOUT_MS, 300_000);
  return db
    ? new KyselyPendingApprovalStore(db, { defaultTimeoutMs })
    : new InMemoryPendingApprovalStore({ defaultTimeoutMs });
}

function createHookTraceStore(db: Kysely<MuseDatabase> | undefined, env: MuseEnvironment): HookTraceStore {
  return db
    ? new KyselyHookTraceStore(db)
    : new InMemoryHookTraceStore({ maxTraces: parseInteger(env.MUSE_HOOK_TRACE_MAX_ENTRIES, 10_000) });
}

function createAdminOperationsStore(db: Kysely<MuseDatabase> | undefined): AdminOperationsStore {
  return db ? new KyselyAdminOperationsStore(db) : new InMemoryAdminOperationsStore();
}

function createRuntimeSettingsStore(db: Kysely<MuseDatabase> | undefined): RuntimeSettingsStore {
  return db ? new KyselyRuntimeSettingsStore(db) : new InMemoryRuntimeSettingsStore();
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
      operations: assembly.adminOperationsStore,
      resilience: assembly.resilience
    },
    agentRuntime: assembly.agentRuntime,
    agentSpecRegistry: assembly.agentSpecRegistry,
    authService: assembly.authService,
    pendingApprovalStore: assembly.approvalStore,
    defaultModel: assembly.defaultModel,
    followupSuggestionStore: assembly.observability.followupSuggestionStore,
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
    taskMemoryMaintenance: assembly.taskMemoryStore,
    slack: {
      enabled: parseBoolean(env.MUSE_SLACK_ENABLED, false),
      signingSecret: parseOptionalString(env.MUSE_SLACK_SIGNING_SECRET)
    }
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

  if (!defaultModel || !baseUrl) {
    return undefined;
  }

  return new OpenAICompatibleProvider({
    apiKey: parseOptionalString(env.MUSE_MODEL_API_KEY ?? env.OPENAI_API_KEY),
    baseUrl,
    defaultModel,
    id: parseOptionalString(env.MUSE_MODEL_PROVIDER_ID) ?? "openai-compatible",
    models: parseCsv(env.MUSE_MODEL_LIST) ?? [defaultModel]
  });
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

function createResponseFilters(env: MuseEnvironment) {
  const maxLength = parseInteger(env.MUSE_RESPONSE_MAX_LENGTH, 0);

  return [
    ...(maxLength > 0 ? [createMaxLengthResponseFilter({ maxLength })] : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SANITIZED_TEXT_FILTER_ENABLED, true)
      ? [createSanitizedTextResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_MARKDOWN_STRIP_FILTER_ENABLED, true)
      ? [createMarkdownStripResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SLACK_USER_ID_MASK_ENABLED, true)
      ? [createSlackUserIdMaskResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_INTERNAL_BRAND_MASK_ENABLED, true)
      ? [createInternalBrandMaskResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_CASUAL_LURE_STRIP_ENABLED, true)
      ? [createCasualLureStripResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_GREETING_STRIP_ENABLED, true)
      ? [createGreetingStripResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_FABRICATION_REFUSAL_ENABLED, true)
      ? [createFabricationRequestRefusalFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_POLICY_STRONG_PRIOR_WARNING_ENABLED, true)
      ? [createPolicyStrongPriorWarningFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_SOURCE_FILTER_ENABLED, true)
      ? [createSourceBlockResponseFilter()]
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
    ...(parseBoolean(env.MUSE_RESPONSE_RELEASE_RISK_DATA_GAP_FILTER_ENABLED, true)
      ? [createReleaseRiskDataGapResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_STRUCTURED_OUTPUT_FILTER_ENABLED, true)
      ? [createStructuredOutputResponseFilter()]
      : [])
  ];
}

function createToolApprovalPolicy(env: MuseEnvironment) {
  const toolNames = new Set(parseCsv(env.MUSE_TOOL_APPROVAL_NAMES) ?? []);
  const risks = new Set(parseCsv(env.MUSE_TOOL_APPROVAL_RISKS) ?? []);

  if (toolNames.size === 0 && risks.size === 0) {
    return undefined;
  }

  return {
    requiresApproval(toolName: string, args: { readonly [key: string]: unknown }): boolean {
      const risk = args.risk;
      return toolNames.has(toolName) || (typeof risk === "string" && risks.has(risk));
    }
  };
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

function createAuthService(env: MuseEnvironment, userStore: InMemoryUserStore): AuthService | undefined {
  const jwtSecret = env.MUSE_AUTH_JWT_SECRET?.trim();

  if (!jwtSecret) {
    return undefined;
  }

  const provider = new DefaultAuthProvider(userStore);
  return new AuthService({
    authProvider: provider,
    jwt: new JwtTokenProvider({
      defaultTenantId: env.MUSE_DEFAULT_TENANT_ID ?? "default",
      jwtExpirationMs: parseInteger(env.MUSE_AUTH_JWT_EXPIRATION_MS, 86_400_000),
      jwtSecret
    }),
    revocationStore: new InMemoryTokenRevocationStore(),
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
