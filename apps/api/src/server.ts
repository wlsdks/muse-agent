import {
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver
} from "@muse/agent-specs";
import { extractBearerToken } from "@muse/auth";
import { errorMessage } from "@muse/shared";
import {
  ConfigurationError,
  createGateEmbedder,
  parseBoolean,
  resolveAttunementFile,
  resolveDefaultUserId,
  resolveNotesDir,
  resolveActionLogFile,
  resolveContactsFile,
  resolveIntegrationEnvironment,
  resolveMuseCliConfigFilePath,
  resolveNotesIndexFile,
  resolveObjectivesFile,
  resolveRejectedProposalsFile,
  resolveProgressiveAutonomyOpportunitiesFile,
  resolveRemindersFile,
  resolveReconfirmCardAnsweredFile,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveWeaknessesFile,
  resolveAuthoredSkillsDir,
  resolveReflectionsFile,
  resolveTasksFile,
  resolveSkillRewardsFile,
  resolveWorksFile
} from "@muse/autoconfigure";
import { defaultBeliefProvenanceFile } from "@muse/memory";
import { SubAgentRunRegistry } from "@muse/multi-agent";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import Fastify, { type FastifyInstance } from "fastify";

import { registerStaticWeb } from "./static-web.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerAttunementRoutes } from "./attunement-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerMultiAgentRoutes, resolveWorkerTimeoutMs } from "./multi-agent-routes.js";
import { registerCompatibilityRoutes } from "./compat-routes.js";
import { registerNotesRoutes } from "./notes-routes.js";
import { registerMessagingRoutes } from "./messaging-routes.js";
import { registerMessagingSetupRoutes } from "./messaging-setup-routes.js";
import { registerDayRhythmRoutes } from "./day-rhythm-routes.js";
import { registerActuatorModeRoutes } from "./actuator-mode-routes.js";
import { registerConversationsRoutes } from "./conversations-routes.js";
import { registerEmailStatusRoutes } from "./email-status-routes.js";
import { lineWebhookPlugin } from "./messaging-webhooks-routes.js";
import { registerAskRoutes } from "./ask-routes.js";
import { registerBoardRoutes } from "./board-routes.js";
import { registerHistoryRoutes } from "./history-routes.js";
import { registerProactiveRoutes } from "./proactive-routes.js";
import { registerRemindersRoutes } from "./reminders-routes.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import { registerAutomationProposalsRoutes } from "./automation-proposals-routes.js";
import { registerFlowsRoutes } from "./flows-routes.js";
import { registerFlowDraftRoutes } from "./flows-draft-routes.js";
import { registerWorksRoutes } from "./works-routes.js";
import { parseDiscordPollChannels, startDiscordPollTick } from "./discord-poll-tick.js";
import { createFileBackedActivityTracker, createInMemoryActivityTracker } from "./proactive-tick.js";
import {
  startAmbientDaemonIfConfigured,
  startConsolidateDaemonIfConfigured,
  startDigestDaemonIfConfigured,
  startFollowupDaemonIfConfigured,
  startPatternDaemonIfConfigured,
  startObjectivesDaemonIfConfigured,
  startProactiveDaemonIfConfigured,
  startHomeWatchDaemonIfConfigured,
  startReminderDaemonIfConfigured,
  startSituationalBriefingDaemonIfConfigured,
  startWebWatchDaemonIfConfigured
} from "./tick-daemons.js";
import { warmUpModelIfConfigured } from "./model-warmup.js";
import { parseSlackPollChannels, startSlackPollTick } from "./slack-poll-tick.js";
import { startTelegramPollTick } from "./telegram-poll-tick.js";
import { startMatrixSyncTick } from "./matrix-sync-tick.js";
import { createChannelDaemonSupervisor } from "./channel-daemon-supervisor.js";
import { readDaemonSettingsSync, resolveDaemonSettingsFile } from "./daemon-settings-store.js";
import { createComposeAck } from "./inbound-ack.js";
import { createInboundAgentRun } from "./inbound-agent-run.js";
import { createComposeChatReply } from "./inbound-chat-reply.js";
import { startInboundReplyTick } from "./inbound-reply-tick.js";
import { createThreadedInboundRunner, type InboundAgentRunner } from "@muse/messaging";
import { conversationStoreThreadedTurnStore, migrateLegacyThreadFile } from "./threaded-conversation-store.js";
import { defaultConversationsFile, FileConversationStore } from "@muse/stores";

import { DiscordProvider, MatrixProvider, SlackProvider, TelegramProvider } from "@muse/messaging";
import { registerSchedulerRoutes } from "./scheduler-routes.js";
import { registerWebhookTriggerRoutes } from "./webhook-trigger-routes.js";
import { registerAccountabilityRoutes } from "./accountability-routes.js";
import { registerSelfImprovementRoutes } from "./self-improvement-routes.js";
import { registerJourneyRoutes } from "./journey-routes.js";
import { registerDoctorRoutes } from "./doctor-routes.js";
import { defaultOrchestrationHistoryFile, FileOrchestrationHistoryStore } from "./orchestration-history-file.js";
import { registerSwarmRoutes } from "./swarm-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerActiveContextRoutes } from "./active-context-routes.js";
import { registerIdentityTaglineRoutes } from "./identity-tagline-routes.js";
import { registerPromptRoutes } from "./prompt-routes.js";
import { registerProgressiveAutonomyRoutes } from "./progressive-autonomy-routes.js";
import { registerUserModelReconfirmRoutes } from "./user-model-reconfirm-routes.js";
import { registerAgentNoticesRoutes } from "./agent-notices-routes.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { registerTodayRoutes } from "./today-routes.js";
import { registerVoiceRoutes } from "./voice-routes.js";
import {
  applyCompatWebContractHeaders,
  applyCorsHeaders,
  attachAuthIdentity,
  requireAuthenticated,
  headerValue,
  isPublicRequest,
  parseMultipartBody,
  routeMethods,
  supportedCompatApiVersions,
  toSpringPathTemplate,
  unwrapErrorMessage
} from "./server-helpers.js";
import {
  registerAdminRunRoutes,
  registerAgentSpecRoutes,
  registerAuthRoutes,
  registerCalendarRoutes,
  registerChatRoutes,
  registerCoreRoutes,
  registerRuntimeSettingsRoutes,
  registerSessionSummaryRoutes,
  registerTasksRoutes,
  registerToolsRoutes
} from "./server-routes.js";

export { unwrapErrorMessage };

export type { CorsOptions, ServerOptions } from "./server-options.js";
import type { ServerOptions } from "./server-options.js";
import type { TaglineModelFn } from "./identity-tagline.js";

/**
 * The local-model layer for the personalized sidebar tagline, or undefined when
 * no provider/model is wired or `MUSE_TAGLINE_NO_MODEL` is set. Bounded output —
 * a subtitle is a handful of words. Fail-soft: the route keeps its deterministic
 * line if the model errors.
 */
function resolveTaglineModel(
  options: ServerOptions,
  env: Readonly<Record<string, string | undefined>>
): TaglineModelFn | undefined {
  if ((env.MUSE_TAGLINE_NO_MODEL ?? "").trim().length > 0) return undefined;
  const provider = options.modelProvider;
  const model = options.defaultModel;
  if (!provider || !model) return undefined;
  return async ({ system, prompt }) => {
    const response = await provider.generate({
      maxOutputTokens: 40,
      messages: [
        { content: system, role: "system" },
        { content: prompt, role: "user" }
      ],
      model,
      temperature: 0.8
    });
    return response.output ?? "";
  };
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const integrationEnv = options.integrationEnv
    ?? resolveIntegrationEnvironment(env, { localOnlyOverride: options.localOnly });
  if (
    options.integrationEnv
    && options.localOnly !== undefined
    && options.localOnly !== options.integrationEnv.localOnly
  ) {
    throw new ConfigurationError("ServerOptions.localOnly must match ServerOptions.integrationEnv.localOnly");
  }
  const agentSpecRegistry = options.agentSpecRegistry ?? new InMemoryAgentSpecRegistry();
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
  // S3b shared conversation store — SAME file the CLI/web threads use, so a
  // Telegram/Matrix chat shows up in `muse chats` too. Cheap to construct
  // (no I/O until a call touches it), so built unconditionally.
  const conversationStore = new FileConversationStore({ file: options.conversationsFile ?? defaultConversationsFile(env) });
  const runtimeSettings =
    options.runtimeSettings ?? new RuntimeSettings(new InMemoryRuntimeSettingsStore());
  const authService = options.authService;
  const server = Fastify({
    logger: options.logger ?? true
  });
  server.addHook("onRequest", async (request, reply) => {
    applyCompatWebContractHeaders(request.url, request.headers["x-request-id"], reply);
    applyCorsHeaders(options.cors, request.headers.origin, reply);

    // Admin responses must reflect live state — block any
    // intermediate proxy / browser cache.
    if (request.url.startsWith("/api/admin/")) {
      reply.header("Cache-Control", "no-store");
    }

    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }

    const requestedVersion = headerValue(request.headers["x-muse-api-version"])?.trim();
    if (requestedVersion && !supportedCompatApiVersions().includes(requestedVersion)) {
      return reply.status(400).send({
        error: `Unsupported API version '${requestedVersion}'. Supported versions: ${supportedCompatApiVersions().join(", ")}`,
        timestamp: new Date().toISOString()
      });
    }
  });
  const apiPaths = new Set<string>();
  const apiRouteMethods = new Map<string, Set<string>>();
  server.addHook("onRoute", (routeOptions) => {
    const path = routeOptions.url;

    if (typeof path === "string" && path.startsWith("/api/")) {
      const template = toSpringPathTemplate(path);
      apiPaths.add(template);
      const methods = apiRouteMethods.get(template) ?? new Set<string>();

      for (const method of routeMethods(routeOptions.method)) {
        methods.add(method.toLowerCase());
      }

      apiRouteMethods.set(template, methods);
    }
  });
  server.addContentTypeParser(/^multipart\/form-data/u, { parseAs: "buffer" }, (request, body, done) => {
    try {
      done(null, parseMultipartBody(request.headers["content-type"], body as Buffer));
    } catch (error) {
      done(new Error(errorMessage(error, "Invalid multipart body")));
    }
  });

  if (authService) {
    server.addHook("preHandler", async (request, reply) => {
      if (isPublicRequest(request.method, request.url)) {
        return;
      }

      if (!options.requireAuth) {
        attachAuthIdentity(request, await authService.authenticateBearer(extractBearerToken(request.headers.authorization)));
        return;
      }

      const identity = await authService.authenticateBearer(extractBearerToken(request.headers.authorization));

      if (!identity) {
        return reply.status(401).send({
          error: "인증이 필요합니다",
          timestamp: new Date().toISOString()
        });
      }

      attachAuthIdentity(request, identity);
    });
  }

  registerCoreRoutes(server, apiRouteMethods);
  registerChatRoutes(server, options);
  registerAdminRunRoutes(server, options, agentSpecRegistry, runtimeSettings, { authService });


  registerSchedulerRoutes(server, {
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService)),
    scheduler: options.scheduler,
    worksFile: options.worksFile ?? resolveWorksFile(env)
  });
  registerWebhookTriggerRoutes(server, {
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService)),
    scheduler: options.scheduler
  });
  registerMcpRoutes(server, {
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService)),
    mcp: options.mcp
  });
  registerAdminRoutes(server, {
    admin: options.admin,
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService))
  });
  // One registry instance shared by the routes AND the AgentRuntime's
  // liveness heartbeat. The runtime is a single shared instance built
  // before this registry can exist, so the heartbeat is late-bound here —
  // orchestration registers the parent runId and workers run under that
  // same runId, so each model-loop beat refreshes the right record and a
  // hung run becomes detectStalled-visible instead of "running" forever.
  const multiAgentRunRegistry = new SubAgentRunRegistry();
  options.agentRuntime?.setHeartbeat?.((runId) => {
    multiAgentRunRegistry.heartbeat(runId);
  });
  registerMultiAgentRoutes(server, {
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    defaultModel: options.defaultModel,
    historyStore: new FileOrchestrationHistoryStore(defaultOrchestrationHistoryFile(env)),
    modelProvider: options.modelProvider,
    embed: createGateEmbedder(env),
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService)),
    runRegistry: multiAgentRunRegistry,
    ...(resolveWorkerTimeoutMs(env) !== undefined
      ? { workerTimeoutMs: resolveWorkerTimeoutMs(env) }
      : {})
  });
  registerCompatibilityRoutes(server, {
    admin: options.admin,
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    authService,
    requireAuthenticated: (request, reply) => requireAuthenticated(request, reply, Boolean(authService)),
    apiPathRegistry: () => [...apiPaths].sort(),
    debugReplayCaptureStore: options.debugReplayCaptureStore,
    defaultModel: options.defaultModel,
    latencyQuery: options.latencyQuery,
    tokenCostQuery: options.tokenCostQuery,
    agentCardIdentity: options.agentCardIdentity,
    agentCardToolProvider: options.agentCardToolProvider,
    museObservabilitySnapshot: options.museObservabilitySnapshot,
    historyStore: options.historyStore,
    mcp: options.mcp,
    modelProvider: options.modelProvider,
    runtimeSettings,
    scheduler: options.scheduler,
    sessionTagStore: options.sessionTagStore,
    taskMemoryMaintenance: options.taskMemoryMaintenance,
    userMemoryStore: options.userMemoryStore
  });

  if (authService) {
    registerAuthRoutes(server, authService);
  }
  registerAgentSpecRoutes(server, agentSpecRegistry, agentSpecResolver);
  registerToolsRoutes(server, options, agentSpecRegistry, runtimeSettings, authService);
  registerSessionSummaryRoutes(server, options, { authService });
  registerRuntimeSettingsRoutes(server, runtimeSettings, {
    useAuthenticatedActor: Boolean(authService && options.requireAuth)
  });
  if (options.calendar) {
    registerCalendarRoutes(server, {
      authService,
      credentialStore: options.calendarCredentialStore,
      integrationEnv,
      registry: options.calendar
    });
  }
  if (options.tasksFile) {
    registerTasksRoutes(server, {
      attunementFile: options.attunementFile ?? resolveAttunementFile(env),
      authService,
      tasksFile: options.tasksFile,
      ...(options.tasksProviderRegistry ? { tasksProviderRegistry: options.tasksProviderRegistry } : {})
    });
  }
  registerAttunementRoutes(server, {
    attunementFile: options.attunementFile ?? resolveAttunementFile(env),
    authService,
    notesDir: options.notesDir ?? resolveNotesDir(env),
    remindersFile: options.remindersFile ?? resolveRemindersFile(env),
    tasksFile: options.tasksFile ?? resolveTasksFile(env)
  });
  registerProgressiveAutonomyRoutes(server, {
    attunementFile: options.attunementFile ?? resolveAttunementFile(env),
    authService,
    defaultUserId: resolveDefaultUserId(env),
    opportunitiesFile: resolveProgressiveAutonomyOpportunitiesFile(env),
    tasksFile: options.tasksFile ?? resolveTasksFile(env)
  });
  if (options.notesDir) {
    registerNotesRoutes(server, {
      authService,
      notesDir: options.notesDir,
      ...(options.notesProviderRegistry ? { notesProviderRegistry: options.notesProviderRegistry } : {})
    });
  }
  if (options.notesDir && options.modelProvider && options.defaultModel) {
    const askModelProvider = options.modelProvider;
    const envEmbedModel = env.MUSE_EMBED_MODEL?.trim();
    registerAskRoutes(server, {
      answerModel: options.defaultModel,
      authService,
      ...(envEmbedModel ? { embedModel: envEmbedModel } : {}),
      generateAnswer: async ({ system, user, model, temperature }) => {
        const response = await askModelProvider.generate({
          messages: [
            { content: system, role: "system" },
            { content: user, role: "user" }
          ],
          model,
          ...(temperature !== undefined ? { temperature } : {})
        });
        return response.output;
      },
      notesDir: options.notesDir,
      notesIndexFile: resolveNotesIndexFile(env),
      streamAnswer: async function* ({ system, user, model, temperature }) {
        for await (const event of askModelProvider.stream({
          messages: [
            { content: system, role: "system" },
            { content: user, role: "user" }
          ],
          model,
          ...(temperature !== undefined ? { temperature } : {})
        })) {
          if (event.type === "text-delta") {
            yield event.text;
          } else if (event.type === "error") {
            throw event.error;
          }
        }
      }
    });
  }
  if (options.voice) {
    registerVoiceRoutes(server, { authService, registry: options.voice });
  }
  // Live channel-daemon registry: truthful running-state for the settings
  // surface and the hot-start seam for a UI connect (no restart needed).
  const channelDaemons = createChannelDaemonSupervisor();
  server.addHook("onClose", async () => {
    channelDaemons.stopAll();
  });
  const ingestStarters: { telegram?: () => void; matrix?: () => void } = {};
  const replyStarters: { telegram?: () => void; matrix?: () => void } = {};
  const daemonSettingsFile = resolveDaemonSettingsFile(env);

  if (options.messaging) {
    registerMessagingRoutes(server, {
      authService,
      registry: options.messaging,
      ...(options.messagingPollNow ? { pollNow: options.messagingPollNow } : {}),
      ...(options.messagingPollAll ? { pollAll: options.messagingPollAll } : {})
    });
    registerMessagingSetupRoutes(server, {
      authService,
      integrationEnv,
      onConnected: (providerId) => {
        if (providerId === "telegram" || providerId === "matrix") {
          ingestStarters[providerId]?.();
        }
      },
      registry: options.messaging
    });
  }
  registerDayRhythmRoutes(server, {
    authService,
    channelOwnersFile: integrationEnv.messaging.ownersFile,
    configFile: resolveMuseCliConfigFilePath(env),
    ...(options.messaging ? { registry: options.messaging } : {})
  });
  registerActuatorModeRoutes(server, {
    authService,
    configFile: resolveMuseCliConfigFilePath(env)
  });
  registerEmailStatusRoutes(server, {
    authService,
    ...(options.emailCredentialsDir ? { credentialsDir: options.emailCredentialsDir } : {}),
    ...(options.env ? { env: options.env } : {})
  });
  registerConversationsRoutes(server, { authService, conversationStore });
  if (options.remindersFile) {
    registerRemindersRoutes(server, {
      authService,
      remindersFile: options.remindersFile,
      ...(options.reminderHistoryFile ? { reminderHistoryFile: options.reminderHistoryFile } : {})
    });
  }
  if (options.proactiveHistoryFile) {
    registerProactiveRoutes(server, {
      authService,
      proactiveHistoryFile: options.proactiveHistoryFile
    });
  }
  // LINE webhook: only registered when both the channel
  // secret and an inbox file path are configured. The plugin scopes a
  // buffer-mode JSON parser so signature verification sees raw bytes.
  const lineSecret = integrationEnv.localOnly ? undefined : integrationEnv.messaging.lineChannelSecret;
  if (lineSecret && options.lineInboxFile) {
    void server.register(lineWebhookPlugin, {
      channelSecret: lineSecret,
      inboxFile: options.lineInboxFile
    });
  }
  registerSetupRoutes(server, { authService, integrationEnv });
  registerActiveContextRoutes(server, {
    authService,
    ...(options.activeContextProvider ? { activeContextProvider: options.activeContextProvider } : {})
  });
  const taglineModel = resolveTaglineModel(options, env);
  registerIdentityTaglineRoutes(server, {
    authService,
    env,
    ...(options.userMemoryStore ? { userMemoryStore: options.userMemoryStore } : {}),
    ...(taglineModel ? { model: taglineModel } : {})
  });
  registerUserModelReconfirmRoutes(server, {
    authService,
    defaultUserId: resolveDefaultUserId(env),
    reconfirmCardAnsweredFile: options.reconfirmCardAnsweredFile ?? resolveReconfirmCardAnsweredFile(env),
    ...(options.userMemoryStore ? { userMemoryStore: options.userMemoryStore } : {})
  });
  registerPromptRoutes(server, {
    authService,
    ...(options.personaFilePath ? { personaFilePath: options.personaFilePath } : {}),
    ...(options.promptLayerRegistry ? { promptLayerRegistry: options.promptLayerRegistry } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {})
  });
  if (options.agentInitiatedNoticeBroker) {
    registerAgentNoticesRoutes(server, {
      agentInitiatedNoticeBroker: options.agentInitiatedNoticeBroker,
      authService
    });
  }
  registerTodayRoutes(server, {
    authService,
    calendar: options.calendar,
    notesDir: options.notesDir,
    tasksFile: options.tasksFile,
    ...(options.remindersFile ? { remindersFile: options.remindersFile } : {}),
    ...(options.followupsFile ? { followupsFile: options.followupsFile } : {})
  });
  registerAutomationRoutes(server, {
    authService,
    env,
    scheduler: options.scheduler,
    ...(options.remindersFile ? { remindersFile: options.remindersFile } : {})
  });
  registerAutomationProposalsRoutes(server, {
    authService,
    notesDir: options.notesDir ?? resolveNotesDir(env),
    rejectedProposalsFile: options.rejectedProposalsFile ?? resolveRejectedProposalsFile(env),
    tasksFile: options.tasksFile ?? resolveTasksFile(env)
  });
  registerFlowsRoutes(server, { authService, scheduler: options.scheduler });
  if (options.modelProvider && options.defaultModel) {
    const draftModelProvider = options.modelProvider;
    const draftModel = options.defaultModel;
    // Draftable tools = the RUNTIME registry's read-risk loopback tools
    // (name shape `muse.<server>.<tool>`) — the same set the scheduler's
    // extraTools seam can actually execute, so the copilot never drafts a
    // stored-but-unrunnable tool flow. Resolved fresh per request via the
    // route's callback (cheap: an in-memory list()).
    const LOOPBACK_TOOL_NAME_RE = /^(muse\.[a-z_]+)\.([a-z0-9_]+)$/u;
    registerFlowDraftRoutes(server, {
      authService,
      generateDraft: async (prompt) => {
        const response = await draftModelProvider.generate({
          messages: [
            { content: prompt.system, role: "system" },
            { content: prompt.user, role: "user" }
          ],
          model: draftModel,
          temperature: 0
        });
        return response.output;
      },
      listDraftableTools: () => {
        const catalog = options.toolCatalogProvider ? options.toolCatalogProvider() : [];
        if (catalog instanceof Promise) {
          return [];
        }
        const draftable: { server: string; tool: string; description: string; inputSchema: Record<string, unknown> | null }[] = [];
        for (const entry of catalog) {
          const match = LOOPBACK_TOOL_NAME_RE.exec(entry.name);
          // Outbound-capable write servers (messaging) stay un-schedulable — an
          // unattended send toward an arbitrary destination is draft-first
          // territory, never a cron job (outbound-safety.md).
          const writeAllowed = entry.risk === "write" && match?.[1] !== "muse.messaging";
          if (match && (entry.risk === "read" || writeAllowed)) {
            draftable.push({
              description: entry.description,
              inputSchema: entry.inputSchema ?? null,
              server: match[1]!,
              tool: match[2]!
            });
          }
        }
        return draftable;
      }
    });
  }
  registerBoardRoutes(server);
  registerWorksRoutes(server, {
    attunementFile: options.attunementFile ?? resolveAttunementFile(env),
    authService,
    scheduler: options.scheduler,
    worksFile: options.worksFile ?? resolveWorksFile(env)
  });
  registerHistoryRoutes(server, {
    authService,
    ...(options.reminderHistoryFile ? { reminderHistoryFile: options.reminderHistoryFile } : {}),
    ...(options.proactiveHistoryFile ? { proactiveHistoryFile: options.proactiveHistoryFile } : {}),
    ...(options.followupsFile ? { followupsFile: options.followupsFile } : {}),
    ...(options.patternsFiredFile ? { patternsFiredFile: options.patternsFiredFile } : {}),
    ...(options.episodesFile ? { episodesFile: options.episodesFile } : {})
  });

  // Read-only accountability / autonomy surface (objectives, action
  // log, contacts, vetoes). Paths fall back to the conventional
  // ~/.muse resolvers so this works without explicit option wiring,
  // matching what the CLI reads.
  registerAccountabilityRoutes(server, {
    authService,
    actionLogFile: options.actionLogFile ?? resolveActionLogFile(env),
    contactsFile: options.contactsFile ?? resolveContactsFile(env),
    objectivesFile: options.objectivesFile ?? resolveObjectivesFile(env),
    vetoesFile: options.vetoesFile ?? resolveVetoesFile(env)
  });

  registerSelfImprovementRoutes(server, {
    authService,
    weaknessesFile: options.weaknessesFile ?? resolveWeaknessesFile(env),
    playbookFile: options.playbookFile ?? resolvePlaybookFile(env),
    authoredSkillsDir: options.authoredSkillsDir ?? resolveAuthoredSkillsDir(env),
    skillRewardsFile: options.skillRewardsFile ?? resolveSkillRewardsFile(env),
    reflectionsFile: options.reflectionsFile ?? resolveReflectionsFile(env)
  });

  // One merged "what Muse learned about you" timeline (facts + skills +
  // strategies) for the web console's Journey view — same stores as above,
  // read-only, no new state-changing surface.
  registerJourneyRoutes(server, {
    authService,
    beliefProvenanceFile: options.beliefProvenanceFile ?? defaultBeliefProvenanceFile(env),
    playbookFile: options.playbookFile ?? resolvePlaybookFile(env),
    authoredSkillsDir: options.authoredSkillsDir ?? resolveAuthoredSkillsDir(env)
  });

  const applyDaemonToggle = (key: string, enabled: boolean): boolean => {
      switch (key) {
        case "MUSE_TELEGRAM_POLL_ENABLED":
          if (!enabled) {
            channelDaemons.stop("telegram-poll");
            return true;
          }
          ingestStarters.telegram?.();
          return channelDaemons.isRunning("telegram-poll");
        case "MUSE_MATRIX_POLL_ENABLED":
          if (!enabled) {
            channelDaemons.stop("matrix-sync");
            return true;
          }
          ingestStarters.matrix?.();
          return channelDaemons.isRunning("matrix-sync");
        case "MUSE_INBOUND_REPLY_ENABLED":
          if (!enabled) {
            channelDaemons.stop("inbound-reply");
            channelDaemons.stop("matrix-inbound-reply");
            return true;
          }
          replyStarters.telegram?.();
          replyStarters.matrix?.();
          return channelDaemons.isRunning("inbound-reply") || channelDaemons.isRunning("matrix-inbound-reply");
      default:
        // Non-channel daemons read their flag at boot only — the
        // persisted toggle applies on the next restart.
        return false;
    }
  };

  registerSettingsRoutes(server, {
    applyDaemonToggle,
    authService,
    daemonSettingsFile,
    daemonStatus: () => channelDaemons.status(),
    env
  });

  registerSwarmRoutes(server, { authService });

  registerDoctorRoutes(server, {
    applyDaemonToggle,
    authService,
    daemonSettingsFile,
    daemonStatus: () => channelDaemons.status(),
    ...(options.messaging ? { messaging: options.messaging } : {}),
    ...(options.telegramInboxFile ? { telegramInboxFile: options.telegramInboxFile } : {})
  });

  // Optional Phase B daemon: every MUSE_REMINDER_TICK_MS (default
  // 60s) call runDueReminders. Activates only when the user has
  // wired both default routing env vars + a matching messaging
  // provider. Off by default so this code path is opt-in and tests
  // / fresh installs don't accidentally fire empty intervals.
  // Phase D shared activity tracker. Either the reminder daemon or
  // the proactive daemon (or both) can opt into agent-synthesized
  // text via their respective MUSE_*_AGENT_TURN flag; when either is
  // active AND an agent runtime is wired, one tracker records
  // /api/chat* presence and feeds both downstream consumers.
  const phaseDReminderOn = parseBoolean(env.MUSE_REMINDER_AGENT_TURN, false)
    && Boolean(options.agentRuntime)
    && Boolean(options.defaultModel);
  const phaseDProactiveOn = parseBoolean(env.MUSE_PROACTIVE_AGENT_TURN, false)
    && Boolean(options.agentRuntime)
    && Boolean(options.defaultModel);
  const presenceFile = env.MUSE_PROACTIVE_PRESENCE_FILE?.trim();
  const sharedActivityTracker = (phaseDReminderOn || phaseDProactiveOn)
    ? (presenceFile && presenceFile.length > 0
      ? createFileBackedActivityTracker({ file: presenceFile })
      : createInMemoryActivityTracker())
    : undefined;
  if (sharedActivityTracker) {
    server.addHook("onRequest", async (request) => {
      const path = (request as { readonly url?: string }).url ?? "";
      if (path.startsWith("/api/chat") || path === "/chat" || path === "/chat/stream") {
        void sharedActivityTracker.record();
      }
    });
  }

  // Tick daemons — reminder, proactive, followup, pattern. Each
  // is off by default and activates when its env keys + required
  // options line up. The four function calls below replace ~200
  // lines of inline env-parsing scaffolding that all five blocks
  // shared the same shape of.
  const phaseDWiring = { phaseDProactiveOn, phaseDReminderOn, sharedActivityTracker };
  startReminderDaemonIfConfigured(env, server, options, phaseDWiring);
  startProactiveDaemonIfConfigured(env, server, options, phaseDWiring);
  startFollowupDaemonIfConfigured(env, server, options);
  startPatternDaemonIfConfigured(env, server, options);
  startConsolidateDaemonIfConfigured(env, server, options, phaseDWiring);
  startSituationalBriefingDaemonIfConfigured(env, server, options, integrationEnv.localOnly);
  startObjectivesDaemonIfConfigured(env, server, options);
  startAmbientDaemonIfConfigured(env, server, options);
  startWebWatchDaemonIfConfigured(env, server, options);
  startHomeWatchDaemonIfConfigured(env, server, options, integrationEnv.localOnly);
  startDigestDaemonIfConfigured(env, server, options);
  warmUpModelIfConfigured(env, options);

  // Optional daemon: ingest Telegram messages into telegramInboxFile.
  // Long-polls by default (MUSE_TELEGRAM_LONG_POLL_SECONDS, default 25,
  // 0 = legacy MUSE_TELEGRAM_POLL_INTERVAL_MS snapshot cadence) so a
  // message lands the moment it is sent. Off unless the user sets
  // MUSE_TELEGRAM_POLL_ENABLED=1 — keeps fresh installs quiet.
  // Holder so the poll daemon can trigger the reply daemon (created
  // below) the instant something is ingested.
  const inboundReplyTick: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const bootDaemonSettings = readDaemonSettingsSync(daemonSettingsFile);
  const pollEnabled = bootDaemonSettings.MUSE_TELEGRAM_POLL_ENABLED
    ?? isMuseDaemonEnabled(env.MUSE_TELEGRAM_POLL_ENABLED);
  // Registered at most once per boot, regardless of how many times the
  // ingest starter itself re-runs (reconnect, daemon toggle) — Telegram's
  // setMyCommands is idempotent, but repeating it on every toggle would
  // still be a needless network round-trip.
  let telegramCommandsRegistered = false;
  if (options.telegramInboxFile && options.messaging) {
    const telegramInboxFile = options.telegramInboxFile;
    const messaging = options.messaging;
    // Callable at boot AND from the setup route's onConnected, so a UI
    // connect starts ingesting without a server restart. Re-invoking
    // replaces the previous handle via the supervisor (reconnect-safe).
    ingestStarters.telegram = () => {
      if (!messaging.has("telegram")) {
        return;
      }
      // The daemon walks Bot API directly, so it needs the concrete
      // TelegramProvider (with offset persistence) rather than the
      // registry's generic fetchInbound — that one reads from the
      // inbox file once that wiring is in place.
      const telegram = messaging.require("telegram");
      if (!(telegram instanceof TelegramProvider)) {
        return;
      }
      if (!telegramCommandsRegistered) {
        telegramCommandsRegistered = true;
        // Fail-soft: a slash-command list is a UI nicety, never a reason
        // to abort the channel starting up. No retry — the next boot (or
        // daemon toggle) tries again.
        void telegram.registerCommands().catch((error: unknown) => {
          server.log.warn(`telegram setMyCommands failed: ${errorMessage(error, "telegram setMyCommands failed")}`);
        });
      }
      const pollMsRaw = env.MUSE_TELEGRAM_POLL_INTERVAL_MS
        ? Number(env.MUSE_TELEGRAM_POLL_INTERVAL_MS)
        : undefined;
      const longPollRaw = env.MUSE_TELEGRAM_LONG_POLL_SECONDS
        ? Number(env.MUSE_TELEGRAM_LONG_POLL_SECONDS)
        : undefined;
      // Default 👀 "seen" reaction (Bot API has no read receipts);
      // MUSE_TELEGRAM_ACK_REACTION overrides the emoji, empty disables.
      const ackReaction = env.MUSE_TELEGRAM_ACK_REACTION ?? "👀";
      channelDaemons.adopt("telegram-poll", startTelegramPollTick({
        ...(ackReaction.trim().length > 0 ? { ackReaction: ackReaction.trim() } : {}),
        errorLogger: (message) => {
          channelDaemons.noteError("telegram-poll", message);
          server.log.warn(message);
        },
        inboxFile: telegramInboxFile,
        ...(pollMsRaw !== undefined ? { intervalMs: pollMsRaw } : {}),
        longPollSeconds: longPollRaw !== undefined && Number.isFinite(longPollRaw) ? longPollRaw : 25,
        logger: (message) => server.log.info(message),
        onIngested: (count) => {
          channelDaemons.noteIngest("telegram-poll", count);
          void inboundReplyTick.current?.();
        },
        provider: telegram
      }));
    };
    if (pollEnabled) {
      ingestStarters.telegram();
    }
  }

  // Optional conversational reply daemon: answer
  // not-yet-handled inbox messages by running the full agent and
  // replying on the originating channel — "the chat IS a Muse
  // session". Reuses the telegram inbox the poll daemon fills.
  // Off unless MUSE_INBOUND_REPLY_ENABLED=1.
  const inboundReplyEnabled = bootDaemonSettings.MUSE_INBOUND_REPLY_ENABLED
    ?? isMuseDaemonEnabled(env.MUSE_INBOUND_REPLY_ENABLED);
  if (options.telegramInboxFile && options.messaging && options.agentRuntime) {
    const telegramInboxFile = options.telegramInboxFile;
    const messaging = options.messaging;
    const agentRuntime = options.agentRuntime;
    // One-time legacy thread-file migration into the shared conversation
    // store — fire-and-forget so server boot never blocks on it; idempotent
    // (a no-op once the file's renamed aside), and any failure leaves the
    // legacy file intact so the NEXT boot retries the whole thing.
    void migrateLegacyThreadFile(`${telegramInboxFile}.threads.json`, conversationStore, { origin: "telegram" })
      .catch((error) => server.log.warn(`telegram thread migration failed: ${String(error)}`));
    replyStarters.telegram = () => {
      const ackModel = options.defaultModel ?? "default";
      const runner: InboundAgentRunner = createThreadedInboundRunner({
        run: createInboundAgentRun({
          agentRuntime,
          ...(options.modelProvider
            ? {
                composeAck: createComposeAck({ model: ackModel, modelProvider: options.modelProvider }),
                composeChatReply: createComposeChatReply({ model: ackModel, modelProvider: options.modelProvider })
              }
            : {}),
          conversationStore,
          env,
          model: ackModel,
          registry: messaging,
          userMemoryStore: options.userMemoryStore
        }),
        store: conversationStoreThreadedTurnStore(conversationStore, { origin: "telegram" })
      });
      const replyMsRaw = env.MUSE_INBOUND_REPLY_INTERVAL_MS
        ? Number(env.MUSE_INBOUND_REPLY_INTERVAL_MS)
        : undefined;
      const replyHandle = startInboundReplyTick({
        cursorFile: `${telegramInboxFile}.reply-cursor.json`,
        errorLogger: (message) => server.log.warn(message),
        inboxFile: telegramInboxFile,
        ...(replyMsRaw !== undefined ? { intervalMs: replyMsRaw } : {}),
        logger: (message) => server.log.info(message),
        registry: messaging,
        runner
      });
      inboundReplyTick.current = () => replyHandle.tickOnce();
      channelDaemons.adopt("inbound-reply", replyHandle);
    };
    if (inboundReplyEnabled) {
      replyStarters.telegram();
    }
  }

  // Optional daemon: ingest Matrix room messages into matrixInboxFile
  // via a continuous `/sync` long-poll (MUSE_MATRIX_LONG_POLL_SECONDS,
  // default 25). Off unless MUSE_MATRIX_POLL_ENABLED=1 — same opt-in
  // posture as the Telegram daemon.
  const matrixReplyTick: { current: (() => Promise<void>) | undefined } = { current: undefined };
  const matrixPollEnabled = bootDaemonSettings.MUSE_MATRIX_POLL_ENABLED
    ?? isMuseDaemonEnabled(env.MUSE_MATRIX_POLL_ENABLED);
  if (options.matrixInboxFile && options.messaging) {
    const matrixInboxFile = options.matrixInboxFile;
    const messaging = options.messaging;
    // Same boot-or-hot-start shape as the Telegram starter above.
    ingestStarters.matrix = () => {
      if (!messaging.has("matrix")) {
        return;
      }
      // The daemon walks the Client-Server API directly, so it needs
      // the concrete MatrixProvider (with since-token persistence)
      // rather than the registry's generic fetchInbound.
      const matrix = messaging.require("matrix");
      if (!(matrix instanceof MatrixProvider)) {
        return;
      }
      const pollMsRaw = env.MUSE_MATRIX_POLL_INTERVAL_MS
        ? Number(env.MUSE_MATRIX_POLL_INTERVAL_MS)
        : undefined;
      const longPollRaw = env.MUSE_MATRIX_LONG_POLL_SECONDS
        ? Number(env.MUSE_MATRIX_LONG_POLL_SECONDS)
        : undefined;
      channelDaemons.adopt("matrix-sync", startMatrixSyncTick({
        errorLogger: (message) => {
          channelDaemons.noteError("matrix-sync", message);
          server.log.warn(message);
        },
        inboxFile: matrixInboxFile,
        ...(pollMsRaw !== undefined ? { intervalMs: pollMsRaw } : {}),
        ...(longPollRaw !== undefined && Number.isFinite(longPollRaw) ? { longPollSeconds: longPollRaw } : {}),
        logger: (message) => server.log.info(message),
        onIngested: (count) => {
          channelDaemons.noteIngest("matrix-sync", count);
          void matrixReplyTick.current?.();
        },
        provider: matrix
      }));
    };
    if (matrixPollEnabled) {
      ingestStarters.matrix();
    }
  }

  // Second inbound reply daemon over the Matrix inbox — same
  // MUSE_INBOUND_REPLY_ENABLED flag and the same createInboundAgentRun
  // runner factory as the Telegram one; only the inbox/cursor/thread
  // files differ, so a Matrix room message IS a Muse session too.
  if (options.matrixInboxFile && options.messaging && options.agentRuntime) {
    const matrixInboxFile = options.matrixInboxFile;
    const messaging = options.messaging;
    const agentRuntime = options.agentRuntime;
    // Same one-time, fire-and-forget legacy migration as the Telegram block above.
    void migrateLegacyThreadFile(`${matrixInboxFile}.threads.json`, conversationStore, { origin: "matrix" })
      .catch((error) => server.log.warn(`matrix thread migration failed: ${String(error)}`));
    replyStarters.matrix = () => {
      const ackModel = options.defaultModel ?? "default";
      const matrixRunner: InboundAgentRunner = createThreadedInboundRunner({
        run: createInboundAgentRun({
          agentRuntime,
          ...(options.modelProvider
            ? {
                composeAck: createComposeAck({ model: ackModel, modelProvider: options.modelProvider }),
                composeChatReply: createComposeChatReply({ model: ackModel, modelProvider: options.modelProvider })
              }
            : {}),
          conversationStore,
          env,
          model: ackModel,
          registry: messaging,
          userMemoryStore: options.userMemoryStore
        }),
        store: conversationStoreThreadedTurnStore(conversationStore, { origin: "matrix" })
      });
      const matrixReplyMsRaw = env.MUSE_INBOUND_REPLY_INTERVAL_MS
        ? Number(env.MUSE_INBOUND_REPLY_INTERVAL_MS)
        : undefined;
      const matrixReplyHandle = startInboundReplyTick({
        cursorFile: `${matrixInboxFile}.reply-cursor.json`,
        errorLogger: (message) => server.log.warn(message),
        inboxFile: matrixInboxFile,
        ...(matrixReplyMsRaw !== undefined ? { intervalMs: matrixReplyMsRaw } : {}),
        logger: (message) => server.log.info(message),
        registry: messaging,
        runner: matrixRunner
      });
      matrixReplyTick.current = () => matrixReplyHandle.tickOnce();
      channelDaemons.adopt("matrix-inbound-reply", matrixReplyHandle);
    };
    if (inboundReplyEnabled) {
      replyStarters.matrix();
    }
  }

  // Optional daemon: poll a user-configured list of
  // Slack channels (MUSE_SLACK_POLL_CHANNELS=C0123,C0456) every
  // MUSE_SLACK_POLL_INTERVAL_MS (default 30s) and persist each new
  // message into slackInboxFile. Off unless MUSE_SLACK_POLL_ENABLED=1.
  const slackPollEnabled = isMuseDaemonEnabled(env.MUSE_SLACK_POLL_ENABLED);
  const slackChannels = parseSlackPollChannels(env.MUSE_SLACK_POLL_CHANNELS);
  if (
    slackPollEnabled
    && slackChannels
    && options.slackInboxFile
    && options.messaging
    && options.messaging.has("slack")
  ) {
    const slack = options.messaging.require("slack");
    if (slack instanceof SlackProvider) {
      const pollMsRaw = env.MUSE_SLACK_POLL_INTERVAL_MS
        ? Number(env.MUSE_SLACK_POLL_INTERVAL_MS)
        : undefined;
      const pollHandle = startSlackPollTick({
        channels: slackChannels,
        errorLogger: (message) => server.log.warn(message),
        inboxFile: options.slackInboxFile,
        ...(pollMsRaw !== undefined ? { intervalMs: pollMsRaw } : {}),
        logger: (message) => server.log.info(message),
        provider: slack
      });
      server.addHook("onClose", async () => {
        pollHandle.stop();
      });
    }
  }

  // Optional daemon: poll a user-configured list of
  // Discord channels (MUSE_DISCORD_POLL_CHANNELS=ch1,ch2) every
  // MUSE_DISCORD_POLL_INTERVAL_MS (default 30s) and persist each
  // new message into discordInboxFile. Off unless the user sets
  // MUSE_DISCORD_POLL_ENABLED=1.
  const discordPollEnabled = isMuseDaemonEnabled(env.MUSE_DISCORD_POLL_ENABLED);
  const discordChannels = parseDiscordPollChannels(env.MUSE_DISCORD_POLL_CHANNELS);
  if (
    discordPollEnabled
    && discordChannels
    && options.discordInboxFile
    && options.messaging
    && options.messaging.has("discord")
  ) {
    const discord = options.messaging.require("discord");
    if (discord instanceof DiscordProvider) {
      const pollMsRaw = env.MUSE_DISCORD_POLL_INTERVAL_MS
        ? Number(env.MUSE_DISCORD_POLL_INTERVAL_MS)
        : undefined;
      const pollHandle = startDiscordPollTick({
        channels: discordChannels,
        errorLogger: (message) => server.log.warn(message),
        inboxFile: options.discordInboxFile,
        ...(pollMsRaw !== undefined ? { intervalMs: pollMsRaw } : {}),
        logger: (message) => server.log.info(message),
        provider: discord
      });
      server.addHook("onClose", async () => {
        pollHandle.stop();
      });
    }
  }

  // Serve the built web UI from this origin when MUSE_WEB_DIR is set (the
  // self-contained desktop app); a no-op for a plain API dev server.
  registerStaticWeb(server, env.MUSE_WEB_DIR);

  return server;
}

export function isMuseDaemonEnabled(envValue: string | undefined): boolean {
  return parseBoolean(envValue, false);
}
