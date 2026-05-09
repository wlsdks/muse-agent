import type { AgentRuntime } from "@muse/agent-core";
import {
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import { extractBearerToken, type MuseAuth } from "@muse/auth";
import { describeBuiltinLoopbackMcpServers } from "@muse/mcp";
import type { ConversationSummaryStore, TaskMemoryMaintenance, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type { MuseObservabilitySnapshot, LatencyQuery, TokenCostQuery } from "@muse/observability";
import { InMemoryRuntimeSettingsStore, RuntimeSettings } from "@muse/runtime-settings";
import type {
  AgentRunHistoryStore,
  DebugReplayCaptureStore,
  SessionTagStore
} from "@muse/runtime-state";
import type { JsonObject } from "@muse/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteState } from "./admin-routes.js";
import { registerMcpRoutes, type McpRouteMcp } from "./mcp-routes.js";
import { registerMultiAgentRoutes } from "./multi-agent-routes.js";
import { registerCompatibilityRoutes } from "./compat-routes.js";
import { registerSchedulerRoutes, type SchedulerRouteScheduler } from "./scheduler-routes.js";
import {
  applyCompatWebContractHeaders,
  applyCorsHeaders,
  attachAuthIdentity,
  authorizeAdmin,
  createOpenApiDocument,
  currentCompatApiVersion,
  getAuthIdentity,
  headerValue,
  invalid,
  isJsonValue,
  isPublicRequest,
  isRecord,
  parseAgentSpecInput,
  parseAuthCredentials,
  parseMultipartBody,
  parseResponseLocales,
  parseRuntimeSettingInput,
  routeMethods,
  runChat,
  runChatStream,
  runMultipartChat,
  supportedCompatApiVersions,
  toAdminRunSummary,
  toLoginResponse,
  toSpringPathTemplate,
  unwrapErrorMessage,
  type ApiError,
  type ParseResult
} from "./server-helpers.js";

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

  server.get("/health", async () => ({
    service: "muse-api",
    status: "ok"
  }));

  server.get("/spec", async () => ({
    agentCore: "model-agnostic",
    database: "postgresql",
    runner: "rust",
    server: "fastify"
  }));
  server.get("/v3/api-docs", async () => createOpenApiDocument(apiRouteMethods));
  server.get("/api/openapi.json", async () => createOpenApiDocument(apiRouteMethods));

  server.post("/chat", async (request, reply) => runChat(request.body, reply, options, "extended", getAuthIdentity(request)?.userId));
  server.post("/api/chat", async (request, reply) => runChat(request.body, reply, options, "compat", getAuthIdentity(request)?.userId));
  server.post("/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "extended", getAuthIdentity(request)?.userId));
  server.post("/api/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "compat", getAuthIdentity(request)?.userId));
  server.post("/api/chat/multipart", async (request, reply) => runMultipartChat(request.body, reply, options, getAuthIdentity(request)?.userId));

  server.get("/admin/summary", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    const [agentSpecs, settings, scheduledJobs, recentRuns] = await Promise.all([
      agentSpecRegistry.list(),
      runtimeSettings.list(),
      options.scheduler?.store.list() ?? [],
      options.historyStore?.listRuns({ limit: 5 }) ?? []
    ]);

    return {
      agentSpecCount: agentSpecs.length,
      authEnabled: Boolean(authService),
      recentRuns: recentRuns.map(toAdminRunSummary),
      runtimeSettingCount: settings.length,
      schedulerJobCount: scheduledJobs.length
    };
  });

  server.get("/admin/users/:userId/runs", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const { userId } = request.params as { readonly userId: string };
    return options.historyStore.listRunsByUser(userId);
  });

  const findRunDetail = async (request: unknown, reply: { status(statusCode: number): { send(payload: unknown): void } }, runId: string) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const run = await options.historyStore.findRun(runId);

    if (!run) {
      return reply.status(404).send({
        code: "RUN_NOT_FOUND",
        message: `Run not found: ${runId}`
      });
    }

    const [messages, toolCalls] = await Promise.all([
      options.historyStore.listMessages(runId),
      options.historyStore.listToolCalls(runId)
    ]);
    return { messages, run, toolCalls };
  };

  server.get("/admin/runs/:runId", async (request, reply) => {
    return findRunDetail(request, reply, (request.params as { readonly runId: string }).runId);
  });

  server.get("/api/admin/runs/:runId", async (request, reply) => {
    return findRunDetail(request, reply, (request.params as { readonly runId: string }).runId);
  });

  server.get("/api/admin/runs", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const limitRaw = (request.query as { readonly limit?: string } | undefined)?.limit;
    let limit: number | undefined;

    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
        return reply.status(400).send({
          code: "INVALID_LIMIT",
          message: "limit must be an integer between 0 and 1000"
        });
      }
      limit = parsed;
    }

    const runs = await options.historyStore.listRuns(limit !== undefined ? { limit } : {});
    return {
      entries: runs.map(toAdminRunSummary),
      total: runs.length
    };
  });

  registerSchedulerRoutes(server, {
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
    scheduler: options.scheduler
  });
  registerMcpRoutes(server, {
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
    mcp: options.mcp
  });
  registerAdminRoutes(server, {
    admin: options.admin,
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService))
  });
  registerMultiAgentRoutes(server, {
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    defaultModel: options.defaultModel
  });
  registerCompatibilityRoutes(server, {
    admin: options.admin,
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    authService,
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
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
    server.post("/auth/register", async (request, reply) => {
      const parsed = parseAuthCredentials(request.body, "register");

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      try {
        return reply.status(201).send(toLoginResponse(await authService.register(parsed.value)));
      } catch (error) {
        return reply.status(400).send({
          code: error instanceof Error && "code" in error ? String(error.code) : "REGISTRATION_FAILED",
          message: error instanceof Error ? error.message : "Registration failed"
        });
      }
    });

    server.post("/auth/login", async (request, reply) => {
      const parsed = parseAuthCredentials(request.body, "login");

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      const login = await authService.login(parsed.value.email, parsed.value.password);

      if (!login) {
        return reply.status(401).send({
          code: "INVALID_CREDENTIALS",
          message: "Invalid credentials"
        });
      }

      return toLoginResponse(login);
    });

    server.get("/auth/me", async (request, reply) => {
      const identity = getAuthIdentity(request);

      if (!identity) {
        return reply.status(401).send({
          code: "UNAUTHENTICATED",
          message: "A valid bearer token is required"
        });
      }

      return { identity };
    });

    server.post("/auth/logout", async (request) => ({
      revoked: await authService.logout(extractBearerToken(request.headers.authorization))
    }));
  }

  server.get("/agent-specs", async () => agentSpecRegistry.list());

  server.get("/agent-specs/:name", async (request, reply) => {
    const { name } = request.params as { readonly name: string };
    const spec = await agentSpecRegistry.getByName(name);

    if (!spec) {
      return reply.status(404).send({
        code: "AGENT_SPEC_NOT_FOUND",
        message: `Agent spec not found: ${name}`
      });
    }

    return spec;
  });

  server.post("/agent-specs", async (request, reply) => {
    const parsed = parseAgentSpecInput(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    const saved = await agentSpecRegistry.save(parsed.value);
    return reply.status(201).send(saved);
  });

  server.delete("/agent-specs/:name", async (request) => {
    const { name } = request.params as { readonly name: string };

    await agentSpecRegistry.deleteByName(name);
    return { deleted: true, name };
  });

  server.post("/agent-specs/resolve", async (request, reply) => {
    const body = request.body;

    if (!isRecord(body) || typeof body.text !== "string") {
      return reply.status(400).send({
        code: "INVALID_AGENT_SPEC_RESOLUTION_REQUEST",
        message: "Body must include a text string"
      });
    }

    const resolution = await agentSpecResolver.resolve(body.text);

    if (!resolution) {
      return { resolution: null };
    }

    return {
      resolution: {
        confidence: resolution.confidence,
        matchedKeywords: resolution.matchedKeywords,
        name: resolution.spec.name,
        toolNames: resolution.spec.toolNames
      }
    };
  });

  server.get("/api/tools", async (request, reply) => {
    if (!options.toolCatalogProvider) {
      return reply.status(404).send({
        code: "TOOL_CATALOG_UNAVAILABLE",
        message: "Tool catalog provider is not configured"
      });
    }

    const filterRiskRaw = (request.query as { readonly risk?: string } | undefined)?.risk;
    const filterRisk =
      filterRiskRaw === "read" || filterRiskRaw === "write" || filterRiskRaw === "execute"
        ? filterRiskRaw
        : undefined;

    if (filterRiskRaw !== undefined && filterRisk === undefined) {
      return reply.status(400).send({
        code: "INVALID_RISK_FILTER",
        message: "risk must be one of read | write | execute"
      });
    }

    const tools = await options.toolCatalogProvider();
    const filtered = filterRisk ? tools.filter((tool) => tool.risk === filterRisk) : tools;

    return {
      tools: filtered.map((tool) => ({
        description: tool.description,
        name: tool.name,
        risk: tool.risk,
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.keywords && tool.keywords.length > 0 ? { keywords: [...tool.keywords] } : {}),
        ...(tool.scopes && tool.scopes.length > 0 ? { scopes: [...tool.scopes] } : {}),
        ...(tool.dependsOn && tool.dependsOn.length > 0 ? { dependsOn: [...tool.dependsOn] } : {})
      })),
      total: filtered.length
    };
  });

  server.get("/api/muse/loopback", async () => {
    const catalog = describeBuiltinLoopbackMcpServers();
    return {
      servers: catalog.map((entry) => ({
        description: entry.description,
        name: entry.name,
        optIn: entry.optIn,
        ...(entry.requires ? { requires: [...entry.requires] } : {}),
        tools: entry.tools.map((tool) => ({
          description: tool.description,
          name: tool.name,
          risk: tool.risk
        })),
        toolCount: entry.tools.length
      })),
      total: catalog.length
    };
  });

  server.get("/api/muse/runtime", async () => {
    const tools = options.toolCatalogProvider ? await options.toolCatalogProvider() : [];
    const toolsByRisk = tools.reduce<Record<"read" | "write" | "execute", number>>(
      (acc, tool) => {
        acc[tool.risk] = (acc[tool.risk] ?? 0) + 1;
        return acc;
      },
      { execute: 0, read: 0, write: 0 }
    );
    const [agentSpecs, settings] = await Promise.all([
      agentSpecRegistry.list(),
      runtimeSettings.list()
    ]);

    return {
      agentCore: { modelAgnostic: true, runner: "rust" },
      agentSpecs: { total: agentSpecs.length },
      capabilities: {
        authEnabled: Boolean(authService),
        historyEnabled: Boolean(options.historyStore),
        mcpEnabled: Boolean(options.mcp),
        modelProviderConfigured: Boolean(options.modelProvider),
        schedulerEnabled: Boolean(options.scheduler)
      },
      defaultModel: options.defaultModel ?? null,
      locales: { response: parseResponseLocales(process.env.MUSE_RESPONSE_LOCALES) },
      service: "muse-api",
      settings: { total: settings.length },
      tools: { byRisk: toolsByRisk, total: tools.length }
    };
  });

  server.get("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const summary = await options.conversationSummaryStore.get(sessionId);
    if (!summary) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_NOT_FOUND",
        message: `No conversation summary stored for session ${sessionId}`
      });
    }
    return summary;
  });

  server.put("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const body = request.body as { readonly narrative?: unknown; readonly summarizedUpToIndex?: unknown } | null | undefined;
    const narrative = typeof body?.narrative === "string" ? body.narrative.trim() : "";
    if (narrative.length === 0) {
      return reply.status(400).send({
        code: "INVALID_CONVERSATION_SUMMARY",
        message: "narrative must be a non-empty string"
      });
    }
    const summarizedUpToIndex = Number.isInteger(body?.summarizedUpToIndex)
      ? (body!.summarizedUpToIndex as number)
      : 0;
    if (summarizedUpToIndex < 0) {
      return reply.status(400).send({
        code: "INVALID_CONVERSATION_SUMMARY",
        message: "summarizedUpToIndex must be a non-negative integer"
      });
    }
    return options.conversationSummaryStore.save({
      narrative,
      sessionId,
      summarizedUpToIndex
    });
  });

  server.delete("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }
    if (!options.conversationSummaryStore) {
      return reply.status(404).send({
        code: "CONVERSATION_SUMMARY_STORE_UNAVAILABLE",
        message: "Conversation summary store is not configured"
      });
    }
    const { sessionId } = request.params as { readonly sessionId: string };
    const deleted = await options.conversationSummaryStore.delete(sessionId);
    return reply.status(deleted ? 204 : 404).send();
  });

  server.get("/settings", async () => runtimeSettings.list());

  server.get("/settings/:key", async (request, reply) => {
    const { key } = request.params as { readonly key: string };
    const setting = await runtimeSettings.find(key);

    if (!setting) {
      return reply.status(404).send({
        code: "RUNTIME_SETTING_NOT_FOUND",
        message: `Runtime setting not found: ${key}`
      });
    }

    return setting;
  });

  server.put("/settings/:key", async (request, reply) => {
    const { key } = request.params as { readonly key: string };
    const parsed = parseRuntimeSettingInput(key, request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return runtimeSettings.set(parsed.value);
  });

  server.delete("/settings/:key", async (request) => {
    const { key } = request.params as { readonly key: string };

    await runtimeSettings.delete(key);
    return { deleted: true, key };
  });

  return server;
}
