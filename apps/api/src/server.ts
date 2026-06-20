import {
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver
} from "@muse/agent-specs";
import { extractBearerToken } from "@muse/auth";
import {
  parseBoolean,
  resolveActionLogFile,
  resolveContactsFile,
  resolveObjectivesFile,
  resolvePendingApprovalsFile,
  resolveVetoesFile,
  resolveWeaknessesFile
} from "@muse/autoconfigure";
import { queryContacts, runActuatorByName } from "@muse/mcp";
import type { JsonObject } from "@muse/shared";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerMultiAgentRoutes } from "./multi-agent-routes.js";
import { registerCompatibilityRoutes } from "./compat-routes.js";
import { registerNotesRoutes } from "./notes-routes.js";
import { registerMessagingRoutes } from "./messaging-routes.js";
import { lineWebhookPlugin } from "./messaging-webhooks-routes.js";
import { registerHistoryRoutes } from "./history-routes.js";
import { registerProactiveRoutes } from "./proactive-routes.js";
import { registerRemindersRoutes } from "./reminders-routes.js";
import { parseDiscordPollChannels, startDiscordPollTick } from "./discord-poll-tick.js";
import { createFileBackedActivityTracker, createInMemoryActivityTracker } from "./proactive-tick.js";
import {
  startAmbientDaemonIfConfigured,
  startConsolidateDaemonIfConfigured,
  startFollowupDaemonIfConfigured,
  startPatternDaemonIfConfigured,
  startObjectivesDaemonIfConfigured,
  startProactiveDaemonIfConfigured,
  startHomeWatchDaemonIfConfigured,
  startReminderDaemonIfConfigured,
  startSituationalBriefingDaemonIfConfigured,
  startWebWatchDaemonIfConfigured
} from "./tick-daemons.js";
import { parseSlackPollChannels, startSlackPollTick } from "./slack-poll-tick.js";
import { startTelegramPollTick } from "./telegram-poll-tick.js";
import { startInboundReplyTick } from "./inbound-reply-tick.js";
import { createChannelApprovalGate, createThreadedInboundRunner, type InboundAgentRunner } from "@muse/messaging";

import { createChannelPendingRecorder } from "./channel-pending-recorder.js";
import { createChannelRefusalRecorder } from "./channel-refusal-recorder.js";
import { handleInboundApprovalReply } from "./inbound-approval-handler.js";
import { DiscordProvider, SlackProvider, TelegramProvider } from "@muse/messaging";
import { registerSchedulerRoutes } from "./scheduler-routes.js";
import { registerAccountabilityRoutes } from "./accountability-routes.js";
import { registerSelfImprovementRoutes } from "./self-improvement-routes.js";
import { registerActiveContextRoutes } from "./active-context-routes.js";
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

export type { CorsOptions, ServerOptions, ToolCatalogEntry } from "./server-options.js";
import type { ServerOptions } from "./server-options.js";

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const agentSpecRegistry = options.agentSpecRegistry ?? new InMemoryAgentSpecRegistry();
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
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
      done(error instanceof Error ? error : new Error("Invalid multipart body"));
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
  registerMultiAgentRoutes(server, {
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    defaultModel: options.defaultModel,
    modelProvider: options.modelProvider
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
  registerRuntimeSettingsRoutes(server, runtimeSettings);
  if (options.calendar) {
    registerCalendarRoutes(server, {
      authService,
      credentialStore: options.calendarCredentialStore,
      registry: options.calendar
    });
  }
  if (options.tasksFile) {
    registerTasksRoutes(server, {
      authService,
      tasksFile: options.tasksFile,
      ...(options.tasksProviderRegistry ? { tasksProviderRegistry: options.tasksProviderRegistry } : {})
    });
  }
  if (options.notesDir) {
    registerNotesRoutes(server, {
      authService,
      notesDir: options.notesDir,
      ...(options.notesProviderRegistry ? { notesProviderRegistry: options.notesProviderRegistry } : {})
    });
  }
  if (options.voice) {
    registerVoiceRoutes(server, { authService, registry: options.voice });
  }
  if (options.messaging) {
    registerMessagingRoutes(server, {
      authService,
      registry: options.messaging,
      ...(options.messagingPollNow ? { pollNow: options.messagingPollNow } : {}),
      ...(options.messagingPollAll ? { pollAll: options.messagingPollAll } : {})
    });
  }
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
  // LINE webhook (Phase 2.b.2): only registered when both the channel
  // secret and an inbox file path are configured. The plugin scopes a
  // buffer-mode JSON parser so signature verification sees raw bytes.
  const lineSecret = process.env.MUSE_LINE_CHANNEL_SECRET?.trim();
  if (lineSecret && lineSecret.length > 0 && options.lineInboxFile) {
    void server.register(lineWebhookPlugin, {
      channelSecret: lineSecret,
      inboxFile: options.lineInboxFile
    });
  }
  registerSetupRoutes(server, { authService });
  registerActiveContextRoutes(server, {
    authService,
    ...(options.activeContextProvider ? { activeContextProvider: options.activeContextProvider } : {})
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
    actionLogFile: options.actionLogFile ?? resolveActionLogFile(process.env),
    contactsFile: options.contactsFile ?? resolveContactsFile(process.env),
    objectivesFile: options.objectivesFile ?? resolveObjectivesFile(process.env),
    vetoesFile: options.vetoesFile ?? resolveVetoesFile(process.env)
  });

  registerSelfImprovementRoutes(server, {
    authService,
    weaknessesFile: options.weaknessesFile ?? resolveWeaknessesFile(process.env)
  });

  // Optional Phase B daemon: every MUSE_REMINDER_TICK_MS (default
  // 60s) call runDueReminders. Activates only when the user has
  // wired both default routing env vars + a matching messaging
  // provider. Off by default so this code path is opt-in and tests
  // / fresh installs don't accidentally fire empty intervals.
  const env = process.env;

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
        sharedActivityTracker.record();
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
  startSituationalBriefingDaemonIfConfigured(env, server, options);
  startObjectivesDaemonIfConfigured(env, server, options);
  startAmbientDaemonIfConfigured(env, server, options);
  startWebWatchDaemonIfConfigured(env, server, options);
  startHomeWatchDaemonIfConfigured(env, server, options);

  // Optional Phase 2.a.3 daemon: poll Telegram every
  // MUSE_TELEGRAM_POLL_INTERVAL_MS (default 30s) and persist each
  // new InboundMessage into telegramInboxFile. Off unless the user
  // sets MUSE_TELEGRAM_POLL_ENABLED=1 — keeps fresh installs quiet.
  const pollEnabled = isMuseDaemonEnabled(process.env.MUSE_TELEGRAM_POLL_ENABLED);
  if (
    pollEnabled
    && options.telegramInboxFile
    && options.messaging
    && options.messaging.has("telegram")
  ) {
    // The daemon walks Bot API directly, so it needs the concrete
    // TelegramProvider (with offset persistence) rather than the
    // registry's generic fetchInbound — that one reads from the
    // inbox file once Phase 2.a.4 wiring is in place.
    const telegram = options.messaging.require("telegram");
    if (telegram instanceof TelegramProvider) {
      const pollMsRaw = process.env.MUSE_TELEGRAM_POLL_INTERVAL_MS
        ? Number(process.env.MUSE_TELEGRAM_POLL_INTERVAL_MS)
        : undefined;
      const pollHandle = startTelegramPollTick({
        errorLogger: (message) => server.log.warn(message),
        inboxFile: options.telegramInboxFile,
        ...(pollMsRaw !== undefined ? { intervalMs: pollMsRaw } : {}),
        logger: (message) => server.log.info(message),
        provider: telegram
      });
      server.addHook("onClose", async () => {
        pollHandle.stop();
      });
    }
  }

  // Optional conversational reply daemon: answer
  // not-yet-handled inbox messages by running the full agent and
  // replying on the originating channel — "the chat IS a Muse
  // session". Reuses the telegram inbox the poll daemon fills.
  // Off unless MUSE_INBOUND_REPLY_ENABLED=1.
  const inboundReplyEnabled = isMuseDaemonEnabled(process.env.MUSE_INBOUND_REPLY_ENABLED);
  if (
    inboundReplyEnabled
    && options.telegramInboxFile
    && options.messaging
    && options.agentRuntime
  ) {
    const agentRuntime = options.agentRuntime;
    const replyModel = options.defaultModel ?? "default";
    const inboundRegistry = options.messaging;
    const runner: InboundAgentRunner = createThreadedInboundRunner({
      run: async ({ messages, providerId, source }) => {
        // A bare "yes" approving a pending channel refusal gets a
        // deterministic ack pointing at `muse approvals approve` rather
        // than a confused agent turn on the word "yes".
        const latestUserText = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
        const approvalAck = await handleInboundApprovalReply({
          pendingFile: resolvePendingApprovalsFile(env),
          providerId,
          source,
          text: latestUserText,
          // Opt-in (default off): an inbound "yes" re-runs the pending
          // tool in-chat. The reply is the explicit confirm of the draft
          // the gate already posted, so the re-run uses an auto-approve
          // gate. Off by default, so completion stays on the deliberate
          // CLI confirm unless the user turns this on.
          ...(parseBoolean(env.MUSE_INBOUND_AUTO_APPROVE, false)
            ? {
                autoRun: (entry) => runActuatorByName(entry.tool, entry.arguments as JsonObject, {
                  actionLogFile: resolveActionLogFile(env),
                  contacts: () => queryContacts(resolveContactsFile(env)),
                  emailApprovalGate: () => ({ approved: true }),
                  ...(env.MUSE_GMAIL_TOKEN?.trim() ? { gmailToken: env.MUSE_GMAIL_TOKEN.trim() } : {}),
                  ...(env.MUSE_HOMEASSISTANT_URL?.trim() ? { homeAssistantBaseUrl: env.MUSE_HOMEASSISTANT_URL.trim() } : {}),
                  ...(env.MUSE_HOMEASSISTANT_TOKEN?.trim() ? { homeAssistantToken: env.MUSE_HOMEASSISTANT_TOKEN.trim() } : {}),
                  userId: `${providerId}:${source}`,
                  webApprovalGate: () => ({ approved: true })
                })
              }
            : {})
        });
        if (approvalAck !== undefined) {
          return approvalAck;
        }
        const result = await agentRuntime.run({
          messages,
          // The channel identity is the user-memory scope for this
          // chat, so the auto-extract hook grows the knows-you model
          // from channel conversations (without a userId the hook
          // no-ops — a channel chat that never learns the user).
          metadata: { userId: `${providerId}:${source}` },
          model: replyModel,
          toolApprovalGate: createChannelApprovalGate({
            providerId,
            recordRefusal: async (refusal) => {
              // Both the audit log and the pending worklist must capture
              // the refusal; run them independently so one failing store
              // doesn't drop the other (the gate's deny holds regardless).
              const logIt = createChannelRefusalRecorder({ actionLogFile: resolveActionLogFile(env), providerId, source });
              const queueIt = createChannelPendingRecorder({ pendingFile: resolvePendingApprovalsFile(env), providerId, source });
              await Promise.allSettled([logIt(refusal), queueIt(refusal)]);
            },
            registry: inboundRegistry,
            source
          })
        } as Parameters<typeof agentRuntime.run>[0]);
        return result.response?.output ?? "";
      },
      threadFile: `${options.telegramInboxFile}.threads.json`
    });
    const replyMsRaw = process.env.MUSE_INBOUND_REPLY_INTERVAL_MS
      ? Number(process.env.MUSE_INBOUND_REPLY_INTERVAL_MS)
      : undefined;
    const replyHandle = startInboundReplyTick({
      cursorFile: `${options.telegramInboxFile}.reply-cursor.json`,
      errorLogger: (message) => server.log.warn(message),
      inboxFile: options.telegramInboxFile,
      ...(replyMsRaw !== undefined ? { intervalMs: replyMsRaw } : {}),
      logger: (message) => server.log.info(message),
      registry: options.messaging,
      runner
    });
    server.addHook("onClose", async () => {
      replyHandle.stop();
    });
  }

  // Optional Phase 2.d.3 daemon: poll a user-configured list of
  // Slack channels (MUSE_SLACK_POLL_CHANNELS=C0123,C0456) every
  // MUSE_SLACK_POLL_INTERVAL_MS (default 30s) and persist each new
  // message into slackInboxFile. Off unless MUSE_SLACK_POLL_ENABLED=1.
  const slackPollEnabled = isMuseDaemonEnabled(process.env.MUSE_SLACK_POLL_ENABLED);
  const slackChannels = parseSlackPollChannels(process.env.MUSE_SLACK_POLL_CHANNELS);
  if (
    slackPollEnabled
    && slackChannels
    && options.slackInboxFile
    && options.messaging
    && options.messaging.has("slack")
  ) {
    const slack = options.messaging.require("slack");
    if (slack instanceof SlackProvider) {
      const pollMsRaw = process.env.MUSE_SLACK_POLL_INTERVAL_MS
        ? Number(process.env.MUSE_SLACK_POLL_INTERVAL_MS)
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

  // Optional Phase 2.c.3 daemon: poll a user-configured list of
  // Discord channels (MUSE_DISCORD_POLL_CHANNELS=ch1,ch2) every
  // MUSE_DISCORD_POLL_INTERVAL_MS (default 30s) and persist each
  // new message into discordInboxFile. Off unless the user sets
  // MUSE_DISCORD_POLL_ENABLED=1.
  const discordPollEnabled = isMuseDaemonEnabled(process.env.MUSE_DISCORD_POLL_ENABLED);
  const discordChannels = parseDiscordPollChannels(process.env.MUSE_DISCORD_POLL_CHANNELS);
  if (
    discordPollEnabled
    && discordChannels
    && options.discordInboxFile
    && options.messaging
    && options.messaging.has("discord")
  ) {
    const discord = options.messaging.require("discord");
    if (discord instanceof DiscordProvider) {
      const pollMsRaw = process.env.MUSE_DISCORD_POLL_INTERVAL_MS
        ? Number(process.env.MUSE_DISCORD_POLL_INTERVAL_MS)
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

  return server;
}

export function isMuseDaemonEnabled(envValue: string | undefined): boolean {
  return parseBoolean(envValue, false);
}
