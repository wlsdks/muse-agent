import {
  createAgentRuntime,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  type AgentRuntime
} from "@muse/agent-core";
import { InMemoryAgentSpecRegistry, RuleBasedAgentSpecResolver } from "@muse/agent-specs";
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
  McpManager,
  McpSecurityPolicyProvider
} from "@muse/mcp";
import { OpenAICompatibleProvider, type ModelProvider } from "@muse/model";
import { InMemoryAgentMetrics, InMemoryMuseTracer } from "@muse/observability";
import { CircuitBreakerRegistry } from "@muse/resilience";
import { InMemoryRuntimeSettingsStore, RuntimeSettingsService } from "@muse/runtime-settings";
import { InMemoryAgentRunHistoryStore, InMemoryHookTraceStore } from "@muse/runtime-state";
import {
  DynamicSchedulerService,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  NodeCronScheduler,
  ScheduledJobDispatcher,
  ScheduledMcpToolInvoker,
  type ScheduledAgentExecutor
} from "@muse/scheduler";
import { ToolRegistry, type MuseTool } from "@muse/tools";

export interface MuseEnvironment {
  readonly [key: string]: string | undefined;
}

export interface MuseRuntimeAssembly {
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: InMemoryAgentSpecRegistry;
  readonly authService?: AuthService;
  readonly cache: {
    readonly metrics: InMemoryCacheMetricsRecorder;
    readonly responseCache: InMemoryResponseCache;
    readonly statsStore: InMemoryCacheStatsStore;
  };
  readonly defaultModel?: string;
  readonly historyStore: InMemoryAgentRunHistoryStore;
  readonly hookTraceStore: InMemoryHookTraceStore;
  readonly mcp: {
    readonly manager: McpManager;
    readonly securityPolicyProvider: McpSecurityPolicyProvider;
    readonly securityPolicyStore: InMemoryMcpSecurityPolicyStore;
    readonly serverStore: InMemoryMcpServerStore;
  };
  readonly modelProvider?: ModelProvider;
  readonly observability: {
    readonly metrics: InMemoryAgentMetrics;
    readonly tracer: InMemoryMuseTracer;
  };
  readonly requireAuth: boolean;
  readonly resilience: {
    readonly circuitBreakerRegistry: CircuitBreakerRegistry;
  };
  readonly runtimeSettings: RuntimeSettingsService;
  readonly scheduler: {
    readonly executionStore: InMemoryScheduledJobExecutionStore;
    readonly service: DynamicSchedulerService;
    readonly store: InMemoryScheduledJobStore;
  };
  readonly toolRegistry: ToolRegistry;
}

export interface ApiServerAssemblyOptions {
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
  const userStore = new InMemoryUserStore(parseInteger(env.MUSE_AUTH_MAX_USERS, 10_000));
  const authService = createAuthService(env, userStore);
  const agentSpecRegistry = new InMemoryAgentSpecRegistry();
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
  const historyStore = new InMemoryAgentRunHistoryStore();
  const hookTraceStore = new InMemoryHookTraceStore({
    maxTraces: parseInteger(env.MUSE_HOOK_TRACE_MAX_ENTRIES, 10_000)
  });
  const cacheStatsStore = new InMemoryCacheStatsStore();
  const cacheMetrics = new InMemoryCacheMetricsRecorder(cacheStatsStore);
  const responseCache = new InMemoryResponseCache({
    maxSize: parseInteger(env.MUSE_CACHE_MAX_SIZE, 1_000),
    ttlMs: parseInteger(env.MUSE_CACHE_TTL_MS, 3_600_000)
  });
  const agentMetrics = new InMemoryAgentMetrics();
  const tracer = new InMemoryMuseTracer();
  const circuitBreakerRegistry = new CircuitBreakerRegistry({
    failureThreshold: parseInteger(env.MUSE_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
    resetTimeoutMs: parseInteger(env.MUSE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 30_000)
  });
  const modelProvider = createModelProvider(env);
  const defaultModel = parseOptionalString(env.MUSE_MODEL ?? env.MUSE_DEFAULT_MODEL);
  const mcpServerStore = new InMemoryMcpServerStore({
    maxServers: parseInteger(env.MUSE_MCP_MAX_SERVERS, 1_000)
  });
  const mcpSecurityPolicyStore = new InMemoryMcpSecurityPolicyStore({
    initial: {
      allowedServerNames: parseCsv(env.MUSE_MCP_ALLOWED_SERVERS),
      allowedStdioCommands: parseCsv(env.MUSE_MCP_ALLOWED_STDIO_COMMANDS),
      maxToolOutputLength: parseInteger(env.MUSE_MCP_MAX_TOOL_OUTPUT_LENGTH, 50_000)
    }
  });
  const mcpSecurityPolicyProvider = new McpSecurityPolicyProvider(mcpSecurityPolicyStore);
  const allowPrivateMcpAddresses = parseBoolean(env.MUSE_MCP_ALLOW_PRIVATE_ADDRESSES, false);
  const mcpManager = new McpManager(mcpServerStore, {
    connector: new DefaultMcpTransportConnector({
      allowPrivateAddresses: allowPrivateMcpAddresses,
      requestTimeoutMs: parseInteger(env.MUSE_MCP_REQUEST_TIMEOUT_MS, 15_000)
    }),
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
  const schedulerStore = new InMemoryScheduledJobStore({
    maxJobs: parseInteger(env.MUSE_SCHEDULER_MAX_JOBS, 1_000)
  });
  const schedulerExecutionStore = new InMemoryScheduledJobExecutionStore({
    maxEntries: parseInteger(env.MUSE_SCHEDULER_MAX_EXECUTIONS, 200)
  });
  const schedulerService = new DynamicSchedulerService({
    dispatcher: new ScheduledJobDispatcher({
      agentExecutor: createScheduledAgentExecutor(() => agentRuntime, defaultModel),
      mcpInvoker: new ScheduledMcpToolInvoker(mcpManager)
    }),
    cronScheduler: parseBoolean(env.MUSE_SCHEDULER_CRON_ENABLED, true)
      ? new NodeCronScheduler()
      : undefined,
    executionStore: schedulerExecutionStore,
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
    observability: {
      metrics: agentMetrics,
      tracer
    },
    requireAuth: parseBoolean(env.MUSE_REQUIRE_AUTH, Boolean(authService)),
    resilience: {
      circuitBreakerRegistry
    },
    runtimeSettings: new RuntimeSettingsService(new InMemoryRuntimeSettingsStore()),
    toolRegistry,
    scheduler: {
      executionStore: schedulerExecutionStore,
      service: schedulerService,
      store: schedulerStore
    }
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
    defaultModel: assembly.defaultModel,
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
  return [
    ...(parseBoolean(env.MUSE_RESPONSE_SOURCE_FILTER_ENABLED, true)
      ? [createSourceBlockResponseFilter()]
      : []),
    ...(parseBoolean(env.MUSE_RESPONSE_STRUCTURED_OUTPUT_FILTER_ENABLED, true)
      ? [createStructuredOutputResponseFilter()]
      : [])
  ];
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
