import { FileCalendarCredentialStore } from "@muse/calendar";
import { createMuseObservabilitySnapshotProvider } from "@muse/observability";

import { parseOptionalString } from "./env-parsers.js";
import {
  mergeModelKeysFromFile,
  resolveActionLogFile,
  resolveBriefingSidecarFile,
  resolveCredentialsFile,
  resolveDiscordInboxFile,
  resolveEpisodesFile,
  resolveFollowupsFile,
  resolveLineInboxFile,
  resolveMatrixInboxFile,
  resolveNotesDir,
  resolveObjectivesFile,
  resolvePatternsFiredFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveRemindersFile,
  resolveSessionLockFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTelegramInboxFile
} from "./personal-providers.js";

import { createMuseRuntimeAssembly, type ApiServerAssemblyOptions } from "./index.js";

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
      allowCredentials: true,
      // Reject `*` so a typoed env can't silently downgrade to
      // wildcard CORS.
      ...(() => {
        const raw = env.MUSE_CORS_ALLOWED_ORIGINS?.trim();
        if (!raw) return {};
        const origins = raw.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && s !== "*");
        return origins.length > 0 ? { allowedOrigins: origins } : {};
      })()
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
    promptLayerRegistry: assembly.promptLayerRegistry,
    personaFilePath: assembly.personaFilePath,
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
    ...(assembly.activeContextProvider ? { activeContextProvider: assembly.activeContextProvider } : {}),
    agentInitiatedNoticeBroker: assembly.agentInitiatedNoticeBroker,
    messaging: assembly.messaging,
    ...(assembly.messagingPollNow ? { messagingPollNow: assembly.messagingPollNow } : {}),
    ...(assembly.messagingPollAll ? { messagingPollAll: assembly.messagingPollAll } : {}),
    remindersFile: resolveRemindersFile(env),
    reminderHistoryFile: resolveReminderHistoryFile(env),
    proactiveHistoryFile: resolveProactiveHistoryFile(env),
    sessionLockFile: resolveSessionLockFile(env),
    followupsFile: resolveFollowupsFile(env),
    objectivesFile: resolveObjectivesFile(env),
    actionLogFile: resolveActionLogFile(env),
    briefingSidecarFile: resolveBriefingSidecarFile(env),
    patternsFiredFile: resolvePatternsFiredFile(env),
    episodesFile: resolveEpisodesFile(env),
    lineInboxFile: resolveLineInboxFile(env),
    matrixInboxFile: resolveMatrixInboxFile(env),
    telegramInboxFile: resolveTelegramInboxFile(env),
    discordInboxFile: resolveDiscordInboxFile(env),
    slackInboxFile: resolveSlackInboxFile(env)
  };
}
