import { createAgentRuntime, type AgentRuntime } from "@muse/agent-core";
import { InMemoryAgentSpecRegistry, RuleBasedAgentSpecResolver } from "@muse/agent-specs";
import {
  AuthService,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  JwtTokenProvider
} from "@muse/auth";
import {
  InMemoryMcpSecurityPolicyStore,
  InMemoryMcpServerStore,
  McpManager,
  McpSecurityPolicyProvider
} from "@muse/mcp";
import { OpenAICompatibleProvider, type ModelProvider } from "@muse/model";
import { InMemoryRuntimeSettingsStore, RuntimeSettingsService } from "@muse/runtime-settings";
import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";
import {
  DynamicSchedulerService,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
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
  readonly defaultModel?: string;
  readonly historyStore: InMemoryAgentRunHistoryStore;
  readonly mcp: {
    readonly manager: McpManager;
    readonly securityPolicyProvider: McpSecurityPolicyProvider;
    readonly securityPolicyStore: InMemoryMcpSecurityPolicyStore;
    readonly serverStore: InMemoryMcpServerStore;
  };
  readonly modelProvider?: ModelProvider;
  readonly requireAuth: boolean;
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
  const mcpManager = new McpManager(mcpServerStore, {
    securityPolicyProvider: mcpSecurityPolicyProvider
  });
  const toolRegistry = new DynamicToolRegistry([() => mcpManager.toMuseTools()]);
  const agentRuntime = modelProvider && defaultModel
    ? createAgentRuntime({
      agentSpecResolver,
      historyStore,
      modelProvider,
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
    executionStore: schedulerExecutionStore,
    store: schedulerStore
  });

  return {
    agentRuntime,
    agentSpecRegistry,
    authService,
    defaultModel,
    historyStore,
    mcp: {
      manager: mcpManager,
      securityPolicyProvider: mcpSecurityPolicyProvider,
      securityPolicyStore: mcpSecurityPolicyStore,
      serverStore: mcpServerStore
    },
    modelProvider,
    requireAuth: parseBoolean(env.MUSE_REQUIRE_AUTH, Boolean(authService)),
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
  const assembly = createMuseRuntimeAssembly(options);

  return {
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
    scheduler: assembly.scheduler
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
