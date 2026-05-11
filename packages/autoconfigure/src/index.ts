import {
  CalendarProviderRegistry,
  FileCalendarCredentialStore
} from "@muse/calendar";
import {
  createAgentRuntime,
  type AgentRuntime,
  type HookStage
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
  createContextReferenceMcpServer,
  createTasksMcpServer,
  createDefaultLoopbackMcpServers,
  createFetchMcpServer,
  createFilesystemMcpServer,
  createLoopbackMcpMuseTools,
  createMessagingMcpServer,
  createNotesMcpServer,
  createRemindersMcpServer,
  createNotesRegistryMcpServer,
  createTasksRegistryMcpServer,
  type LoopbackMcpServer,
  type McpSecurityPolicyStore,
  type McpServerInput,
  type McpServerStore,
  type NotesProviderRegistry,
  type TasksProviderRegistry
} from "@muse/mcp";
import {
  createUserMemoryAutoExtractHook,
  DEFAULT_WORKING_BUDGET_RATIO,
  InMemoryContextReferenceStore,
  type ConversationSummaryStore,
  type TaskMemoryMaintenance,
  type TaskMemoryStore,
  type UserMemoryStore
} from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import {
  InMemoryAgentMetrics,
  InMemoryFollowupSuggestionStore,
  MonthlyBudgetTracker,
  PromptDriftDetector,
  SloAlertEvaluator,
  createBudgetTrackingTokenUsageSink,
  createDerivedAgentMetrics,
  createMuseObservabilitySnapshotProvider,
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
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";
import {
  createMuseTools,
  createSkillListTool,
  createSkillReadTool,
  createSkillRunTool,
  ToolRegistry,
  type MuseTool
} from "@muse/tools";
import { VoiceProviderRegistry } from "@muse/voice";
import {
  DiscordProvider,
  SlackProvider,
  TelegramProvider,
  appendInbound,
  type InboundMessage,
  type MessagingProviderRegistry
} from "@muse/messaging";
import type { MuseDatabase } from "@muse/db";
import type { Kysely } from "kysely";

import {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseNonNegativeFloat,
  parseOptionalString,
  parsePositiveFloat,
  parseSloErrorRate
} from "./env-parsers.js";
import { createResponseFilters } from "./response-filters.js";

import {
  buildActiveContextProvider,
  buildCalendarRegistry,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildMessagingRegistry,
  buildNotesRegistry,
  buildSkillCatalogProvider,
  buildSkillRegistry,
  buildTasksRegistry,
  buildToolFilter,
  buildVoiceRegistry,
  ensureNotesDir,
  mergeModelKeysFromFile,
  resolveCredentialsFile,
  resolveDiscordInboxFile,
  resolveLineInboxFile,
  resolveNotesDir,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile
} from "./personal-providers.js";

export {
  buildActiveContextProvider,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildMessagingRegistry,
  buildToolFilter,
  buildVoiceRegistry,
  mergeModelKeysFromFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveReminderHistoryFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile
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
import { DynamicToolRegistry } from "./dynamic-tool-registry.js";
import { loadExternalMcpConfig } from "./external-mcp-config.js";
import {
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
  readMcpEntryCount,
  readMessagingProviderState,
  readModelKeyState,
  readTaskCount,
  statBytes,
  type SetupStatusSnapshot
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
    tracingPipeline.tokenUsageSink
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
  const defaultModel = resolveDefaultModel(env);
  const mcpServerStore = createMcpServerStore(db, env);
  const externalServerInputs = loadExternalMcpConfig(env);
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
      clientRoots: parseCsv(env.MUSE_MCP_CLIENT_ROOTS),
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
  // Round 168: in-process ref store for just-in-time retrieval. Used
  // by AgentRuntime's tool-output truncation to stash full content
  // and surface ref=<id> in the marker; the agent fetches via the
  // muse.context loopback server when the budget is worth it.
  const contextReferenceStore = new InMemoryContextReferenceStore({
    maxEntries: parseInteger(env.MUSE_CONTEXT_REF_MAX_ENTRIES, 1_000),
    ttlMs: parseInteger(env.MUSE_CONTEXT_REF_TTL_MS, 30 * 60 * 1_000)
  });
  const contextReferenceLoopbackTools = createLoopbackMcpMuseTools(
    createContextReferenceMcpServer({ store: contextReferenceStore })
  );
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
  // Messaging loopback (Phase 3): only registered when at least one
  // provider is configured via env tokens, so the LLM doesn't see a
  // tool that always errors with "no providers configured". Read +
  // write surface (`providers` / `send`).
  const messagingRegistry = buildMessagingRegistry(env);
  // Agent-triggered poll-now dispatcher: walks the per-provider
  // concrete pollUpdates → appendInbound chain so the LLM can pull
  // a single provider off-cadence (e.g. "check Telegram now").
  // LINE is webhook-fed only, so it raises a clear error rather
  // than silently succeeding with `ingested: 0`.
  const pollNow = async (providerId: string, source?: string): Promise<{ ingested: number }> => {
    const provider = messagingRegistry.require(providerId);
    let inbound: readonly InboundMessage[];
    let inboxFile: string;
    if (provider instanceof TelegramProvider) {
      inbound = await provider.pollUpdates();
      inboxFile = resolveTelegramInboxFile(env);
    } else if (provider instanceof DiscordProvider) {
      if (!source) {
        throw new Error("source (channel id) is required for discord");
      }
      inbound = await provider.pollUpdates({ source });
      inboxFile = resolveDiscordInboxFile(env);
    } else if (provider instanceof SlackProvider) {
      if (!source) {
        throw new Error("source (channel id) is required for slack");
      }
      inbound = await provider.pollUpdates({ source });
      inboxFile = resolveSlackInboxFile(env);
    } else {
      throw new Error(`poll_now is not supported for provider: ${providerId} (LINE uses webhooks; call inbox directly)`);
    }
    for (const message of inbound) {
      await appendInbound(inboxFile, message);
    }
    return { ingested: inbound.length };
  };
  // Agent-triggered poll-all dispatcher: walks every wired provider
  // in one call. Per-channel providers use the same channel CSVs the
  // daemon respects (MUSE_DISCORD_POLL_CHANNELS / MUSE_SLACK_POLL_CHANNELS);
  // LINE is webhook-fed and skipped. One bad channel per provider
  // emits an error entry but doesn't black out the rest.
  const discordChannelsForPollAll = parseCsv(env.MUSE_DISCORD_POLL_CHANNELS) ?? [];
  const slackChannelsForPollAll = parseCsv(env.MUSE_SLACK_POLL_CHANNELS) ?? [];
  const pollAll = async (): Promise<{
    ingestedByProvider: Record<string, number>;
    errors: { providerId: string; message: string }[];
  }> => {
    const ingestedByProvider: Record<string, number> = {};
    const errors: { providerId: string; message: string }[] = [];
    for (const provider of messagingRegistry.list()) {
      if (provider instanceof TelegramProvider) {
        try {
          const got = await pollNow("telegram");
          ingestedByProvider["telegram"] = got.ingested;
        } catch (cause) {
          errors.push({ message: cause instanceof Error ? cause.message : String(cause), providerId: "telegram" });
        }
      } else if (provider instanceof DiscordProvider) {
        let total = 0;
        for (const channel of discordChannelsForPollAll) {
          try {
            const got = await pollNow("discord", channel);
            total += got.ingested;
          } catch (cause) {
            errors.push({
              message: `channel ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`,
              providerId: "discord"
            });
          }
        }
        ingestedByProvider["discord"] = total;
      } else if (provider instanceof SlackProvider) {
        let total = 0;
        for (const channel of slackChannelsForPollAll) {
          try {
            const got = await pollNow("slack", channel);
            total += got.ingested;
          } catch (cause) {
            errors.push({
              message: `channel ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`,
              providerId: "slack"
            });
          }
        }
        ingestedByProvider["slack"] = total;
      }
      // LINE intentionally skipped — webhook-fed, nothing to poll.
    }
    return { errors, ingestedByProvider };
  };
  const messagingLoopbackTools = messagingRegistry.list().length > 0
    ? createLoopbackMcpMuseTools(createMessagingMcpServer({ pollAll, pollNow, registry: messagingRegistry }))
    : [];
  // Reminders loopback: always registered. The store self-creates on
  // first write, so a fresh install sees the tool but the file is
  // absent until the LLM adds the first reminder.
  const remindersFile = resolveRemindersFile(env);
  const reminderHistoryFile = resolveReminderHistoryFile(env);
  const remindersLoopbackTools = createLoopbackMcpMuseTools(
    createRemindersMcpServer({ file: remindersFile, historyFile: reminderHistoryFile })
  );
  const schedulerHandle: { current: DynamicScheduler | undefined } = { current: undefined };

  // Skills (SKILL.md) registry — async disk scan deferred via
  // Promise wrap so this assembly stays synchronous. Tools that
  // need the registry (`muse.skills.*`) read through a small view
  // that resolves the promise lazily on the first invocation.
  const skillRegistryPromise = buildSkillRegistry(env);
  let skillRegistryCache: Awaited<typeof skillRegistryPromise>;
  const skillRegistryView = {
    list: () => {
      if (!skillRegistryCache) return [];
      return skillRegistryCache.list().map((skill) => ({
        body: skill.body,
        description: skill.description,
        ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
        name: skill.name,
        ...(skill.frontmatter.requires?.anyBins
          ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
          : {}),
        ...(skill.frontmatter.requires?.bins ? { requiresBins: [...skill.frontmatter.requires.bins] } : {})
      }));
    },
    get: (name: string) => {
      if (!skillRegistryCache) return undefined;
      const skill = skillRegistryCache.get(name);
      if (!skill) return undefined;
      return {
        body: skill.body,
        description: skill.description,
        ...(skill.frontmatter.emoji ? { emoji: skill.frontmatter.emoji } : {}),
        name: skill.name,
        ...(skill.frontmatter.requires?.anyBins
          ? { requiresAnyBins: [...skill.frontmatter.requires.anyBins] }
          : {}),
        ...(skill.frontmatter.requires?.bins ? { requiresBins: [...skill.frontmatter.requires.bins] } : {})
      };
    }
  };
  void skillRegistryPromise.then((registry) => {
    skillRegistryCache = registry;
  });

  const skillTools = parseBoolean(env.MUSE_SKILLS_ENABLED, true)
    ? [
        createSkillListTool(skillRegistryView),
        createSkillReadTool(skillRegistryView),
        createSkillRunTool(skillRegistryView)
      ]
    : [];

  const toolRegistry = new DynamicToolRegistry([
    () => museTools,
    () => loopbackMcpTools,
    () => contextReferenceLoopbackTools,
    () => notesLoopbackTools,
    () => notesRegistryLoopbackTools,
    () => calendarLoopbackTools,
    () => tasksLoopbackTools,
    () => tasksRegistryLoopbackTools,
    () => messagingLoopbackTools,
    () => remindersLoopbackTools,
    () => runnerTools,
    () => skillTools,
    () => mcpManager.toMuseTools(),
    () => schedulerHandle.current ? createSchedulerTools(schedulerHandle.current) : []
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
      contextReferenceStore,
      contextWindow: (() => {
        // Working-budget compaction trigger (round 157 + 158): proactive
        // compaction at ~40% of nominal so quality stays high before the
        // hard cap is hit (Anthropic effective-context-engineering /
        // NoLiMa context-rot research). User can override the soft target
        // via MUSE_LLM_WORKING_BUDGET_TOKENS; setting it to 0 disables
        // proactive compaction entirely (legacy hard-cap-only behavior).
        const maxContextWindowTokens = parseInteger(env.MUSE_LLM_MAX_CONTEXT_WINDOW_TOKENS, 128_000);
        const outputReserveTokens = parseInteger(env.MUSE_LLM_MAX_OUTPUT_TOKENS, 4_096);
        const explicitWorkingBudget = env.MUSE_LLM_WORKING_BUDGET_TOKENS;
        const workingBudgetTokens = explicitWorkingBudget !== undefined
          ? parseInteger(explicitWorkingBudget, 0)
          : Math.floor(maxContextWindowTokens * DEFAULT_WORKING_BUDGET_RATIO);
        // Context Engineering Phase 5: importance-aware compaction.
        // `MUSE_COMPACTION_STRATEGY=importance` enables score-aware
        // trimming so multi-day task state survives longer than casual
        // chat. Default stays `temporal` (legacy oldest-first).
        const strategyRaw = env.MUSE_COMPACTION_STRATEGY?.trim().toLowerCase();
        const compactionStrategy: "temporal" | "importance" =
          strategyRaw === "importance" ? "importance" : "temporal";
        const importanceThresholdRaw = env.MUSE_COMPACTION_IMPORTANCE_THRESHOLD?.trim();
        const importanceThreshold = importanceThresholdRaw
          ? Number.parseFloat(importanceThresholdRaw)
          : Number.NaN;
        return {
          maxContextWindowTokens,
          outputReserveTokens,
          // 0 disables; positive values pass through to trimConversationMessages.
          ...(workingBudgetTokens > 0 ? { workingBudgetTokens } : {}),
          compactionStrategy,
          ...(Number.isFinite(importanceThreshold) ? { importanceThreshold } : {})
        };
      })(),
      historyStore,
      hooks: runtimeHooks,
      hookTraceStore,
      // Round 161: per-tool-result character cap. Default 8_000
      // chars (~2_000 tokens at the rough 1-token-per-4-chars
      // approximation) — large enough for small file reads and
      // typical tool replies, small enough that a single huge
      // result can't blow the working budget. Tunable via
      // MUSE_MAX_TOOL_OUTPUT_CHARS; 0 disables the cap.
      maxToolOutputChars: parseInteger(env.MUSE_MAX_TOOL_OUTPUT_CHARS, 8_000),
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
        : undefined,
      // Context Engineering Phases 1, 2, 4. Each is opt-out (Phase 1)
      // or opt-in (Phases 2, 4) — see `buildActiveContextProvider`,
      // `buildInboxContextProvider`, `buildToolFilter` for the toggle
      // semantics.
      activeContextProvider: buildActiveContextProvider(
        env,
        parseBoolean(env.MUSE_USER_MEMORY_INJECTION, true) ? userMemoryStore : undefined,
        taskMemoryStore,
        calendarRegistry
      ),
      inboxContextProvider: buildInboxContextProvider(env),
      // Phase 3: store-backed episodic recall. Reuses the same
      // ConversationSummaryStore that conversation-summary persistence
      // already writes to, so cross-session memory works the moment a
      // session compacts.
      episodicRecallProvider: parseBoolean(env.MUSE_CONVERSATION_SUMMARY_PERSIST, true)
        ? buildEpisodicRecallProvider(env, conversationSummaryStore)
        : undefined,
      toolFilter: buildToolFilter(env),
      skillCatalogProvider: buildSkillCatalogProvider(skillRegistryPromise)
    })
    : undefined;
  const schedulerStore = createSchedulerStore(db, env);
  const schedulerExecutionStore = createSchedulerExecutionStore(db, env);
  const schedulerLock = createSchedulerLock(db, env);
  const schedulerService = new DynamicScheduler({
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
    mcp: {
      externalServerInputs,
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
    voice: buildVoiceRegistry(env),
    messaging: messagingRegistry,
    ...(messagingRegistry.list().length > 0
      ? { messagingPollAll: pollAll, messagingPollNow: pollNow }
      : {})
  };
}


export function createApiServerOptions(options: ApiServerAssemblyOptions = {}) {
  const env = mergeModelKeysFromFile(options.env ?? process.env);
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
    /**
     * Full MCP wiring needed for boot-time external-server seeding.
     * The narrow `mcp` field above stays focused on what the route
     * handlers consume; this carries the store + parsed external
     * entries so callers can `await seedExternalMcpServers(...)`
     * before listening on the port.
     */
    mcpBootstrap: {
      externalServerInputs: assembly.mcp.externalServerInputs,
      serverStore: assembly.mcp.serverStore
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
    voice: assembly.voice,
    messaging: assembly.messaging,
    ...(assembly.messagingPollNow ? { messagingPollNow: assembly.messagingPollNow } : {}),
    ...(assembly.messagingPollAll ? { messagingPollAll: assembly.messagingPollAll } : {}),
    remindersFile: resolveRemindersFile(env),
    reminderHistoryFile: resolveReminderHistoryFile(env),
    lineInboxFile: resolveLineInboxFile(env),
    telegramInboxFile: resolveTelegramInboxFile(env),
    discordInboxFile: resolveDiscordInboxFile(env),
    slackInboxFile: resolveSlackInboxFile(env)
  };
}

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
  resolveDefaultModel
} from "./autoconfigure-model-provider.js";

export { createModelProvider, resolveDefaultModel };

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

