import type { AgentRuntime } from "@muse/agent-core";
import {
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import { extractBearerToken, type MuseAuth } from "@muse/auth";
import type { CalendarCredentialStore, CalendarProviderRegistry } from "@muse/calendar";
import type { NotesProviderRegistry, TasksProviderRegistry } from "@muse/mcp";
import type { MessagingProviderRegistry } from "@muse/messaging";
import type { ConversationSummaryStore, TaskMemoryMaintenance, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type { MuseObservabilitySnapshot, LatencyQuery, TokenCostQuery } from "@muse/observability";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import type {
  AgentRunHistoryStore,
  DebugReplayCaptureStore,
  SessionTagStore
} from "@muse/runtime-state";
import type { VoiceProviderRegistry } from "@muse/voice";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteState } from "./admin-routes.js";
import { registerMcpRoutes, type McpRouteMcp } from "./mcp-routes.js";
import { registerMultiAgentRoutes } from "./multi-agent-routes.js";
import { registerCompatibilityRoutes } from "./compat-routes.js";
import { registerNotesRoutes } from "./notes-routes.js";
import { registerMessagingRoutes } from "./messaging-routes.js";
import { lineWebhookPlugin } from "./messaging-webhooks-routes.js";
import { registerRemindersRoutes } from "./reminders-routes.js";
import { parseDiscordPollChannels, startDiscordPollTick } from "./discord-poll-tick.js";
import { parseQuietHours, startReminderTick } from "./reminder-tick.js";
import { startTelegramPollTick } from "./telegram-poll-tick.js";
import { DiscordProvider, TelegramProvider } from "@muse/messaging";
import { registerSchedulerRoutes, type SchedulerRouteScheduler } from "./scheduler-routes.js";
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

export interface ServerOptions {
  readonly logger?: boolean;
  readonly cors?: CorsOptions;
  readonly agentRuntime?: AgentRuntime;
  readonly admin?: AdminRouteState;
  readonly agentSpecRegistry?: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly debugReplayCaptureStore?: DebugReplayCaptureStore;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly requireAuth?: boolean;
  readonly runtimeSettings?: RuntimeSettings;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly sessionTagStore?: SessionTagStore;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
  readonly userMemoryStore?: UserMemoryStore;
  readonly conversationSummaryStore?: ConversationSummaryStore;
  readonly agentCardIdentity?: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
  };
  readonly agentCardToolProvider?: () => Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[]> | readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[];
  readonly toolCatalogProvider?: () => Promise<readonly ToolCatalogEntry[]> | readonly ToolCatalogEntry[];
  readonly museObservabilitySnapshot?: () => Promise<MuseObservabilitySnapshot>;
  readonly calendar?: CalendarProviderRegistry;
  readonly calendarCredentialStore?: CalendarCredentialStore;
  readonly tasksFile?: string;
  readonly tasksProviderRegistry?: TasksProviderRegistry;
  readonly notesDir?: string;
  readonly notesProviderRegistry?: NotesProviderRegistry;
  readonly voice?: VoiceProviderRegistry;
  readonly messaging?: MessagingProviderRegistry;
  readonly remindersFile?: string;
  /**
   * Path to the persisted LINE inbox (default ~/.muse/line-inbox.json).
   * Combined with `MUSE_LINE_CHANNEL_SECRET` from env, enables the
   * `POST /api/messaging/webhooks/line` route.
   */
  readonly lineInboxFile?: string;
  /**
   * Path to the persisted Telegram inbox (default
   * ~/.muse/telegram-inbox.json). The polling daemon writes here on
   * each tick; the per-provider read API will consult this file in
   * a follow-up slice.
   */
  readonly telegramInboxFile?: string;
  /**
   * Path to the persisted Discord inbox (default
   * ~/.muse/discord-inbox.json). The Phase 2.c.3 polling daemon
   * writes here on each tick.
   */
  readonly discordInboxFile?: string;
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute";
  readonly inputSchema?: Record<string, unknown> | null;
  readonly keywords?: readonly string[];
  readonly scopes?: readonly string[];
  readonly dependsOn?: readonly string[];
}

export interface CorsOptions {
  readonly allowCredentials?: boolean;
  readonly allowedHeaders?: readonly string[];
  readonly allowedMethods?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly maxAgeSeconds?: number;
}

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
    registerMessagingRoutes(server, { authService, registry: options.messaging });
  }
  if (options.remindersFile) {
    registerRemindersRoutes(server, { authService, remindersFile: options.remindersFile });
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
  registerTodayRoutes(server, {
    authService,
    calendar: options.calendar,
    notesDir: options.notesDir,
    tasksFile: options.tasksFile,
    ...(options.remindersFile ? { remindersFile: options.remindersFile } : {})
  });

  // Optional Phase B daemon: every MUSE_REMINDER_TICK_MS (default
  // 60s) call runDueReminders. Activates only when the user has
  // wired both default routing env vars + a matching messaging
  // provider. Off by default so this code path is opt-in and tests
  // / fresh installs don't accidentally fire empty intervals.
  const env = process.env;
  const tickProvider = env.MUSE_REMINDER_DEFAULT_PROVIDER?.trim();
  const tickDestination = env.MUSE_REMINDER_DEFAULT_DESTINATION?.trim();
  if (
    tickProvider && tickProvider.length > 0
    && tickDestination && tickDestination.length > 0
    && options.remindersFile
    && options.messaging
    && options.messaging.has(tickProvider)
  ) {
    const tickMsRaw = env.MUSE_REMINDER_TICK_MS ? Number(env.MUSE_REMINDER_TICK_MS) : undefined;
    const quietHours = parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
    const tickHandle = startReminderTick({
      destination: tickDestination,
      errorLogger: (message) => server.log.warn(message),
      ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
      logger: (message) => server.log.info(message),
      providerId: tickProvider,
      ...(quietHours ? { quietHours } : {}),
      registry: options.messaging,
      remindersFile: options.remindersFile
    });
    server.addHook("onClose", async () => {
      tickHandle.stop();
    });
  }

  // Optional Phase 2.a.3 daemon: poll Telegram every
  // MUSE_TELEGRAM_POLL_INTERVAL_MS (default 30s) and persist each
  // new InboundMessage into telegramInboxFile. Off unless the user
  // sets MUSE_TELEGRAM_POLL_ENABLED=1 — keeps fresh installs quiet.
  const pollEnabled = process.env.MUSE_TELEGRAM_POLL_ENABLED?.trim() === "1";
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

  // Optional Phase 2.c.3 daemon: poll a user-configured list of
  // Discord channels (MUSE_DISCORD_POLL_CHANNELS=ch1,ch2) every
  // MUSE_DISCORD_POLL_INTERVAL_MS (default 30s) and persist each
  // new message into discordInboxFile. Off unless the user sets
  // MUSE_DISCORD_POLL_ENABLED=1.
  const discordPollEnabled = process.env.MUSE_DISCORD_POLL_ENABLED?.trim() === "1";
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
