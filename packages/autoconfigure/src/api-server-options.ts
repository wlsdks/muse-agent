import { FileCalendarCredentialStore } from "@muse/calendar";
import { createMuseObservabilitySnapshotProvider } from "@muse/observability";

import { parseOptionalString } from "./env-parsers.js";
import {
  mergeModelKeysFromFile,
  resolveEffectiveLocalOnlyOverride,
  resolveActionLogFile,
  resolveBriefingSidecarFile,
  resolveDiscordInboxFile,
  resolveEpisodesFile,
  resolveFollowupsFile,
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

import { createMuseRuntimeAssembly, type ApiServerAssemblyOptions, type MuseEnvironment } from "./index.js";
import { resolveIntegrationEnvironment } from "./integration-environment.js";

export function createApiServerOptions(options: ApiServerAssemblyOptions = {}) {
  const source: MuseEnvironment = options.env ?? process.env;
  // Calculate the process-backed HA/model strictness before any model-key
  // merge can take its raw `{ ...env }` branch. Feed that same posture into
  // the API integration snapshot so setup status and tick daemons cannot
  // carry a stale false while the assembled runtime is strict. An explicit
  // false still works when the actual process is not strict.
  const modelAndHomeLocalOnlyOverride = resolveEffectiveLocalOnlyOverride(source, options.localOnlyOverride);
  const integrationEnv = resolveIntegrationEnvironment(source, {
    ...(modelAndHomeLocalOnlyOverride === undefined ? {} : { localOnlyOverride: modelAndHomeLocalOnlyOverride })
  });
  const env = mergeModelKeysFromFile(source, {
    ...(modelAndHomeLocalOnlyOverride === undefined ? {} : { localOnlyOverride: modelAndHomeLocalOnlyOverride })
  });
  // One effective env feeds both the runtime assembly and the narrow API
  // integration snapshot. Reusing raw options.env here would let setup routes
  // disagree with the registry the runtime actually assembled.
  const assembly = createMuseRuntimeAssembly({
    ...options,
    env,
    ...(modelAndHomeLocalOnlyOverride === undefined ? {} : { localOnlyOverride: modelAndHomeLocalOnlyOverride })
  });

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
    // The chat-write approval path reads its opt-in flag + pending-file path
    // from this merged env; the confirm-execute endpoint resolves the approved
    // tool straight from the runtime's own registry.
    env,
    approvalToolResolver: (name: string) => assembly.toolRegistry.get(name),
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
    calendarCredentialStore: new FileCalendarCredentialStore(integrationEnv.calendar.credentialsFile),
    integrationEnv,
    localOnly: integrationEnv.localOnly,
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
    lineInboxFile: integrationEnv.messaging.providers.line.inboxFile,
    matrixInboxFile: resolveMatrixInboxFile(env),
    telegramInboxFile: resolveTelegramInboxFile(env),
    discordInboxFile: resolveDiscordInboxFile(env),
    slackInboxFile: resolveSlackInboxFile(env)
  };
}
