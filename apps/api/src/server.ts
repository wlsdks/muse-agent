import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  GuardBlockedError,
  OutputGuardBlockedError,
  PlanExecutionError,
  PlanValidationFailedError,
  type AgentRunInput,
  type AgentRuntime,
  type AgentRunResult
} from "@muse/agent-core";
import {
  InMemoryAgentSpecRegistry,
  RuleBasedAgentSpecResolver,
  type AgentSpecInput,
  type AgentSpecRegistry
} from "@muse/agent-specs";
import {
  AuthRateLimiter,
  extractBearerToken,
  type IamTokenExchange,
  isAnyAdmin,
  isDeveloperAdmin,
  type AuthIdentity,
  type LoginResult,
  type MuseAuth
} from "@muse/auth";
import type {
  ChannelFaqRegistrationStore,
  SlackBotInstanceStore,
  SlackFeedbackEventStore,
  SlackResponseTrackerStore
} from "@muse/integrations";
import type { AgentEvalStore } from "@muse/eval";
import type { TaskMemoryMaintenance, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type { FollowupSuggestionStore, JarvisObservabilitySnapshot, LatencyQuery, TokenCostQuery } from "@muse/observability";
import type { GuardRuleStore, ToolPolicyStore } from "@muse/policy";
import type { FeedbackStore, PromptLabCatalogStore, PromptLabExperimentStore } from "@muse/promptlab";
import type { RagDocumentStore, RagIngestionCandidateStore, RagIngestionPolicyStore } from "@muse/rag";
import {
  InMemoryRuntimeSettingsStore,
  RuntimeSettings,
  type RuntimeSettingType
} from "@muse/runtime-settings";
import type { AgentRunHistoryStore, AgentRunRecord, PendingApprovalStore, SessionTagStore } from "@muse/runtime-state";
import type { JsonObject, JsonValue } from "@muse/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteState } from "./admin-routes.js";
import { registerMcpRoutes, type McpRouteMcp } from "./mcp-routes.js";
import { registerMultiAgentRoutes } from "./multi-agent-routes.js";
import { registerQualityRoutes } from "./quality-routes.js";
import { registerReactorCompatibilityRoutes } from "./reactor-compat-routes.js";
import { registerSchedulerRoutes, type SchedulerRouteScheduler } from "./scheduler-routes.js";
import { registerSlackRoutes, type SlackRouteOptions } from "./slack-routes.js";

export interface ServerOptions {
  readonly logger?: boolean;
  readonly cors?: CorsOptions;
  readonly agentRuntime?: AgentRuntime;
  readonly agentEvalStore?: AgentEvalStore;
  readonly admin?: AdminRouteState;
  readonly agentSpecRegistry?: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly iamTokenExchangeService?: IamTokenExchange;
  readonly authRateLimiter?: AuthRateLimiter;
  readonly followupSuggestionStore?: FollowupSuggestionStore;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly feedbackStore?: FeedbackStore;
  readonly promptLabCatalogStore?: PromptLabCatalogStore;
  readonly promptLabExperimentStore?: PromptLabExperimentStore;
  readonly historyStore?: AgentRunHistoryStore;
  readonly pendingApprovalStore?: PendingApprovalStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly requireAuth?: boolean;
  readonly ragIngestion?: {
    readonly candidateStore: RagIngestionCandidateStore;
    readonly documentStore?: RagDocumentStore;
    readonly policyStore: RagIngestionPolicyStore;
  };
  readonly runtimeSettings?: RuntimeSettings;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly slackPersistence?: {
    readonly botStore: SlackBotInstanceStore;
    readonly faqStore: ChannelFaqRegistrationStore;
    readonly feedbackStore?: SlackFeedbackEventStore;
    readonly responseTrackerStore?: SlackResponseTrackerStore;
  };
  readonly sessionTagStore?: SessionTagStore;
  readonly slack?: SlackRouteOptions;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
  readonly guardRuleStore?: GuardRuleStore;
  readonly toolPolicyStore?: ToolPolicyStore;
  readonly userMemoryStore?: UserMemoryStore;
  readonly agentCardIdentity?: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
  };
  readonly agentCardToolProvider?: () => Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[]> | readonly { readonly name: string; readonly description: string; readonly inputSchema?: Record<string, unknown> | null }[];
  readonly toolCatalogProvider?: () => Promise<readonly ToolCatalogEntry[]> | readonly ToolCatalogEntry[];
  readonly jarvisObservabilitySnapshot?: () => Promise<JarvisObservabilitySnapshot>;
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
  const authRateLimiter = options.authRateLimiter ?? new AuthRateLimiter();
  const server = Fastify({
    logger: options.logger ?? true
  });
  server.addHook("onRequest", async (request, reply) => {
    applyReactorWebContractHeaders(request.url, request.headers["x-request-id"], reply);
    applyCorsHeaders(options.cors, request.headers.origin, reply);

    if (request.method === "OPTIONS") {
      return reply.status(204).send();
    }

    const requestedVersion = headerValue(request.headers["x-reactor-api-version"])?.trim();
    if (requestedVersion && !supportedReactorApiVersions().includes(requestedVersion)) {
      return reply.status(400).send({
        error: `Unsupported API version '${requestedVersion}'. Supported versions: ${supportedReactorApiVersions().join(", ")}`,
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

  server.post("/chat", async (request, reply) => runChat(request.body, reply, options, "extended"));
  server.post("/api/chat", async (request, reply) => runChat(request.body, reply, options, "reactor"));
  server.post("/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "extended"));
  server.post("/api/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "reactor"));
  server.post("/api/chat/multipart", async (request, reply) => runMultipartChat(request.body, reply, options));

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
  registerQualityRoutes(server, {
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
    defaultModel: options.defaultModel,
    modelProvider: options.modelProvider
  });
  registerAdminRoutes(server, {
    admin: options.admin,
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService))
  });
  registerSlackRoutes(server, {
    agentRuntime: options.agentRuntime,
    defaultModel: options.defaultModel,
    slack: options.slack
  });
  registerMultiAgentRoutes(server, {
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    defaultModel: options.defaultModel
  });
  registerReactorCompatibilityRoutes(server, {
    admin: options.admin,
    agentEvalStore: options.agentEvalStore,
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    authRateLimiter,
    authService,
    iamTokenExchangeService: options.iamTokenExchangeService,
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
    authorizeAnyAdmin: (request, reply) => authorizeAnyAdmin(request, reply, Boolean(authService)),
    apiPathRegistry: () => [...apiPaths].sort(),
    defaultModel: options.defaultModel,
    feedbackStore: options.feedbackStore,
    promptLabCatalogStore: options.promptLabCatalogStore,
    promptLabExperimentStore: options.promptLabExperimentStore,
    followupSuggestionStore: options.followupSuggestionStore,
    latencyQuery: options.latencyQuery,
    tokenCostQuery: options.tokenCostQuery,
    agentCardIdentity: options.agentCardIdentity,
    agentCardToolProvider: options.agentCardToolProvider,
    jarvisObservabilitySnapshot: options.jarvisObservabilitySnapshot,
    historyStore: options.historyStore,
    mcp: options.mcp,
    modelProvider: options.modelProvider,
    pendingApprovalStore: options.pendingApprovalStore,
    ragIngestion: options.ragIngestion,
    runtimeSettings,
    scheduler: options.scheduler,
    slackPersistence: options.slackPersistence,
    sessionTagStore: options.sessionTagStore,
    taskMemoryMaintenance: options.taskMemoryMaintenance,
    guardRuleStore: options.guardRuleStore,
    toolPolicyStore: options.toolPolicyStore,
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
      const key = authRateLimitKey(request.headers["x-forwarded-for"], request.ip, "/auth/login");

      if (authRateLimiter.isBlocked(key)) {
        return reply.status(429).send({
          code: "AUTH_RATE_LIMITED",
          message: "Too many authentication attempts"
        });
      }

      const parsed = parseAuthCredentials(request.body, "login");

      if (!parsed.ok) {
        authRateLimiter.recordFailure(key);
        return reply.status(400).send(parsed.error);
      }

      const login = await authService.login(parsed.value.email, parsed.value.password);

      if (!login) {
        authRateLimiter.recordFailure(key);
        return reply.status(401).send({
          code: "INVALID_CREDENTIALS",
          message: "Invalid credentials"
        });
      }

      authRateLimiter.recordSuccess(key);
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

  server.get("/api/jarvis/runtime", async () => {
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
        ragEnabled: Boolean(options.ragIngestion),
        schedulerEnabled: Boolean(options.scheduler),
        slackEnabled: Boolean(options.slack)
      },
      defaultModel: options.defaultModel ?? null,
      locales: { response: parseResponseLocales(process.env.MUSE_RESPONSE_LOCALES) },
      service: "muse-api",
      settings: { total: settings.length },
      tools: { byRisk: toolsByRisk, total: tools.length }
    };
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

function toSpringPathTemplate(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

function applyReactorWebContractHeaders(
  path: string,
  requestIdHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  reply.header("X-Request-ID", headerValue(requestIdHeader)?.trim() || randomUUID());
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Content-Security-Policy", isSwaggerPath(path)
    ? "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    : "default-src 'self'");
  reply.header("X-XSS-Protection", "0");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  reply.header("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  reply.header("X-Reactor-Api-Version", currentReactorApiVersion());
  reply.header("X-Reactor-Api-Supported-Versions", supportedReactorApiVersions().join(","));

  if (isSensitivePath(path)) {
    reply.header("Cache-Control", "no-store");
  }
}

function applyCorsHeaders(
  options: CorsOptions | undefined,
  originHeader: string | string[] | undefined,
  reply: {
    header(name: string, value: string): unknown;
  }
): void {
  if (!options) {
    return;
  }

  const origin = headerValue(originHeader)?.trim();
  const allowedOrigin = allowedCorsOrigin(origin, options.allowedOrigins ?? defaultCorsOrigins());

  if (!allowedOrigin) {
    return;
  }

  reply.header("Access-Control-Allow-Origin", allowedOrigin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Methods", (options.allowedMethods ?? defaultCorsMethods()).join(","));
  reply.header("Access-Control-Allow-Headers", (options.allowedHeaders ?? defaultCorsHeaders()).join(","));

  if (options.allowCredentials) {
    reply.header("Access-Control-Allow-Credentials", "true");
  }

  if (options.maxAgeSeconds !== undefined) {
    reply.header("Access-Control-Max-Age", String(Math.max(0, Math.trunc(options.maxAgeSeconds))));
  }
}

function allowedCorsOrigin(origin: string | undefined, allowedOrigins: readonly string[]): string | undefined {
  if (!origin) {
    return undefined;
  }

  return allowedOrigins.includes("*") || allowedOrigins.includes(origin) ? origin : undefined;
}

function defaultCorsOrigins(): readonly string[] {
  return ["http://127.0.0.1:5173", "http://localhost:5173"];
}

function defaultCorsMethods(): readonly string[] {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
}

function defaultCorsHeaders(): readonly string[] {
  return ["authorization", "content-type", "x-request-id", "x-reactor-api-version"];
}

function currentReactorApiVersion(): string {
  return "1";
}

function supportedReactorApiVersions(): readonly string[] {
  return [currentReactorApiVersion()];
}

function isSensitivePath(path: string): boolean {
  return path === "/api/chat"
    || path.startsWith("/api/chat/")
    || path === "/api/auth"
    || path.startsWith("/api/auth/");
}

function isSwaggerPath(path: string): boolean {
  return path.startsWith("/swagger-ui") || path.startsWith("/v3/api-docs") || path.startsWith("/webjars");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function routeMethods(method: string | readonly string[]): readonly string[] {
  return typeof method === "string" ? [method] : method;
}

function createOpenApiDocument(apiRouteMethods: ReadonlyMap<string, ReadonlySet<string>>): JsonObject {
  return {
    info: {
      title: "Muse API",
      version: "0.0.0"
    },
    openapi: "3.1.0",
    paths: Object.fromEntries(
      [...apiRouteMethods.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, methods]) => [
          path,
          Object.fromEntries(
            [...methods]
              .filter((method) => method !== "head" && method !== "options")
              .sort()
              .map((method) => [
                method,
                {
                  responses: {
                    "200": {
                      description: "OK"
                    }
                  },
                  summary: `${method.toUpperCase()} ${path}`
                }
              ])
          )
        ])
    )
  };
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

interface ApiError {
  readonly code: string;
  readonly message: string;
}

async function runChat(
  body: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  options: ServerOptions,
  responseMode: "extended" | "reactor"
) {
  if (!options.agentRuntime) {
    return reply.status(503).send({
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "Agent runtime is not configured"
    });
  }

  const parsed = parseAgentRunInput(body, options.defaultModel ?? "default");

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  try {
    const result = await options.agentRuntime.run(parsed.value);
    return responseMode === "reactor" ? toReactorChatResponse(result) : toExtendedChatResponse(result);
  } catch (error) {
    return sendAgentError(reply, error, responseMode);
  }
}

async function runChatStream(
  body: unknown,
  reply: {
    header(name: string, value: string): unknown;
    status(statusCode: number): { send(payload: unknown): void };
    send(payload: unknown): unknown;
  },
  options: ServerOptions,
  responseMode: "extended" | "reactor"
) {
  if (!options.agentRuntime) {
    return reply.status(503).send({
      code: "AGENT_RUNTIME_UNAVAILABLE",
      message: "Agent runtime is not configured"
    });
  }

  const parsed = parseAgentRunInput(body, options.defaultModel ?? "default");

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  reply.header("content-type", "text/event-stream; charset=utf-8");
  reply.header("cache-control", "no-cache");
  return reply.send(Readable.from(toSseStream(options.agentRuntime.stream(parsed.value), responseMode)));
}

async function runMultipartChat(
  body: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  options: ServerOptions
) {
  const parsed = parseMultipartChatBody(body);

  if (!parsed.ok) {
    return reply.status(400).send(parsed.error);
  }

  return runChat(parsed.value, reply, options, "reactor");
}

function parseMultipartChatBody(value: unknown): ParseResult<JsonObject> {
  if (!isRecord(value) || !isRecord(value.fields) || !Array.isArray(value.files)) {
    return invalid("INVALID_MULTIPART_CHAT_REQUEST", "Body must be multipart form-data");
  }

  const message = optionalString(value.fields.message);

  if (!message) {
    return invalid("INVALID_MULTIPART_CHAT_REQUEST", "Multipart request must include message");
  }

  return {
    ok: true,
    value: {
      message,
      metadata: {
        channel: "web",
        media: value.files.filter(isJsonObject),
        ...(optionalString(value.fields.personaId) ? { personaId: optionalString(value.fields.personaId) } : {}),
        ...(optionalString(value.fields.sessionId) ? { sessionId: optionalString(value.fields.sessionId) } : {}),
        ...(optionalString(value.fields.userId) ? { userId: optionalString(value.fields.userId) } : {})
      },
      ...(optionalString(value.fields.model) ? { model: optionalString(value.fields.model) } : {}),
      ...(optionalString(value.fields.sessionId) ? { runId: optionalString(value.fields.sessionId) } : {}),
      ...(optionalString(value.fields.systemPrompt)
        ? { messages: [{ content: optionalString(value.fields.systemPrompt) ?? "", role: "system" }, { content: message, role: "user" }] }
        : {})
    }
  };
}

function parseAgentRunInput(value: unknown, defaultModel: string): ParseResult<AgentRunInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_CHAT_REQUEST", "Body must be an object");
  }

  const messages = parseMessages(value.messages, value.message, value.systemPrompt);

  if (!messages) {
    return invalid("INVALID_CHAT_REQUEST", "Body must include message or messages");
  }

  const metadata = reactorChatMetadata(value);

  return {
    ok: true,
    value: {
      messages,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model : defaultModel,
      runId: typeof value.runId === "string" && value.runId.trim().length > 0 ? value.runId : undefined
    }
  };
}

function parseMessages(
  messages: unknown,
  message: unknown,
  systemPrompt: unknown
): AgentRunInput["messages"] | undefined {
  if (Array.isArray(messages)) {
    const parsed = messages.flatMap((item) => {
      if (!isRecord(item) || typeof item.content !== "string" || !isModelRole(item.role)) {
        return [];
      }

      const toolCalls = parseToolCalls(item.toolCalls);

      if (item.toolCalls !== undefined && !toolCalls) {
        return [];
      }

      return [{
        content: item.content,
        name: optionalString(item.name),
        role: item.role,
        toolCallId: optionalString(item.toolCallId),
        toolCalls
      }];
    });

    if (parsed.length !== messages.length || parsed.length === 0) {
      return undefined;
    }

    return prependSystemPrompt(parsed, systemPrompt);
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return undefined;
  }

  return prependSystemPrompt([{ content: message, role: "user" }], systemPrompt);
}

function prependSystemPrompt(
  messages: AgentRunInput["messages"],
  systemPrompt: unknown
): AgentRunInput["messages"] {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    return messages;
  }

  return messages[0]?.role === "system"
    ? messages
    : [{ content: systemPrompt, role: "system" }, ...messages];
}

function reactorChatMetadata(value: Record<string, unknown>): JsonObject {
  const entries: Record<string, JsonValue> = isJsonObject(value.metadata) ? { ...value.metadata } : {};
  const userId = optionalString(value.userId);
  const personaId = optionalString(value.personaId);
  const promptTemplateId = optionalString(value.promptTemplateId);
  const responseFormat = optionalString(value.responseFormat);
  const responseSchema = optionalString(value.responseSchema);

  if (userId) {
    entries.userId = userId;
  }

  if (personaId) {
    entries.personaId = personaId;
  }

  if (promptTemplateId) {
    entries.promptTemplateId = promptTemplateId;
  }

  if (responseFormat) {
    entries.responseFormat = responseFormat;
  }

  if (responseSchema) {
    entries.responseSchema = responseSchema;
  }

  if (Array.isArray(value.mediaUrls)) {
    const mediaUrls = value.mediaUrls.filter(isJsonObject);

    if (mediaUrls.length === value.mediaUrls.length) {
      entries.mediaUrls = mediaUrls;
    }
  }

  return entries;
}

function isModelRole(value: unknown): value is AgentRunInput["messages"][number]["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function parseToolCalls(value: unknown): AgentRunInput["messages"][number]["toolCalls"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const parsed = value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !isJsonObject(item.arguments)
    ) {
      return [];
    }

    return [{
      arguments: item.arguments,
      id: item.id,
      name: item.name
    }];
  });

  return parsed.length === value.length ? parsed : undefined;
}

function toReactorChatResponse(result: AgentRunResult) {
  const tokenUsage = reactorTokenUsage(result.response.usage);
  const metadata = reactorResponseMetadata(result);

  return {
    blockReason: typeof metadata.blockReason === "string" ? metadata.blockReason : null,
    content: result.response.output,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    grounded: typeof metadata.grounded === "boolean" ? metadata.grounded : null,
    metadata,
    model: result.response.model,
    success: true,
    tokenUsage,
    toolsUsed: result.toolsUsed ?? [],
    verifiedSourceCount: typeof metadata.verifiedSourceCount === "number" ? metadata.verifiedSourceCount : null
  };
}

function toAdminRunSummary(run: AgentRunRecord) {
  return {
    id: run.id,
    inputPreview: previewText(run.input, 120),
    model: run.model,
    provider: run.provider,
    status: run.status
  };
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function toExtendedChatResponse(result: AgentRunResult) {
  return {
    ...toReactorChatResponse(result),
    agentSpec: result.agentSpec,
    contextWindow: result.contextWindow,
    fromCache: result.fromCache ?? false,
    response: result.response.output,
    runId: result.runId,
    usage: result.response.usage
  };
}

function reactorTokenUsage(usage: AgentRunResult["response"]["usage"]) {
  if (!usage) {
    return null;
  }

  const promptTokens = usage.inputTokens ?? 0;
  const completionTokens = usage.outputTokens ?? 0;
  return {
    cachedContentTokens: usage.cachedInputTokens ?? null,
    completionTokens,
    promptTokens,
    thoughtsTokens: usage.reasoningTokens ?? null,
    toolUsePromptTokens: null,
    totalTokens: promptTokens + completionTokens,
    trafficType: null
  };
}

function reactorResponseMetadata(result: AgentRunResult): JsonObject {
  return {
    ...(result.agentSpec
      ? {
        agentSpec: {
          confidence: result.agentSpec.confidence,
          matchedKeywords: [...result.agentSpec.matchedKeywords],
          name: result.agentSpec.name,
          toolNames: [...result.agentSpec.toolNames]
        }
      }
      : {}),
    ...(result.contextWindow
      ? {
        contextWindow: {
          budgetTokens: result.contextWindow.budgetTokens,
          estimatedTokens: result.contextWindow.estimatedTokens,
          removedCount: result.contextWindow.removedCount,
          summaryInserted: result.contextWindow.summaryInserted
        }
      }
      : {}),
    fromCache: result.fromCache ?? false,
    runId: result.runId
  };
}

function sendAgentError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown,
  responseMode: "extended" | "reactor"
) {
  if (error instanceof GuardBlockedError) {
    return reply.status(403).send(chatErrorResponse({
      blockReason: error.message,
      code: error.code ?? "GUARD_BLOCKED",
      errorCode: error.code ?? "GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof OutputGuardBlockedError) {
    return reply.status(422).send(chatErrorResponse({
      blockReason: error.message,
      code: error.code ?? "OUTPUT_GUARD_BLOCKED",
      errorCode: error.code ?? "OUTPUT_GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof PlanExecutionError) {
    return reply.status(422).send(chatErrorResponse({
      code: error.code,
      errorCode: error.code,
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  if (error instanceof PlanValidationFailedError) {
    return reply.status(422).send(chatErrorResponse({
      code: "PLAN_VALIDATION_FAILED",
      errorCode: "PLAN_VALIDATION_FAILED",
      errorMessage: error.message,
      message: error.message
    }, responseMode) as ApiError);
  }

  const message = unwrapErrorMessage(error);
  return reply.status(500).send(chatErrorResponse({
    code: "AGENT_RUN_FAILED",
    errorCode: "AGENT_RUN_FAILED",
    errorMessage: message,
    message
  }, responseMode) as ApiError);
}

/**
 * Unwrap nested error causes (RetryExhaustedError → ModelProviderError →
 * underlying fetch error) so an operator sees the actual upstream error
 * message instead of the generic retry-exhausted wrapper.
 */
export function unwrapErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Agent run failed";
  }

  const seen = new Set<unknown>();
  const segments: string[] = [];
  let current: unknown = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    segments.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }

  return segments.join(" — ");
}

function chatErrorResponse(
  error: {
    readonly blockReason?: string;
    readonly code: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly message: string;
  },
  responseMode: "extended" | "reactor"
) {
  const response = {
    blockReason: error.blockReason ?? null,
    content: null,
    durationMs: null,
    errorCode: error.errorCode,
    errorMessage: error.errorMessage,
    grounded: null,
    metadata: {},
    model: null,
    success: false,
    tokenUsage: null,
    toolsUsed: [],
    verifiedSourceCount: null
  };

  return responseMode === "reactor"
    ? response
    : {
      ...response,
      code: error.code,
      message: error.message
    };
}

function parseAgentSpecInput(value: unknown): ParseResult<AgentSpecInput> {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) {
    return invalid("INVALID_AGENT_SPEC", "Body must include a non-empty name");
  }

  return {
    ok: true,
    value: {
      description: optionalString(value.description),
      enabled: optionalBoolean(value.enabled),
      independentExecution: optionalBoolean(value.independentExecution),
      keywords: optionalStringArray(value.keywords),
      mode:
        value.mode === "standard" || value.mode === "plan_execute" || value.mode === "react"
          ? value.mode
          : undefined,
      name: value.name,
      systemPrompt: optionalNullableString(value.systemPrompt),
      toolNames: optionalStringArray(value.toolNames)
    }
  };
}

function parseRuntimeSettingInput(
  key: string,
  value: unknown
): ParseResult<{
  readonly category?: string;
  readonly description?: string | null;
  readonly key: string;
  readonly type?: RuntimeSettingType;
  readonly updatedBy?: string | null;
  readonly value: string;
}> {
  if (!isRecord(value) || typeof value.value !== "string") {
    return invalid("INVALID_RUNTIME_SETTING", "Body must include a string value");
  }

  return {
    ok: true,
    value: {
      category: optionalString(value.category),
      description: optionalNullableString(value.description),
      key,
      type: parseRuntimeSettingType(value.type),
      updatedBy: optionalNullableString(value.updatedBy),
      value: value.value
    }
  };
}

function parseAuthCredentials(
  value: unknown,
  mode: "login" | "register"
): ParseResult<{ readonly email: string; readonly name: string; readonly password: string }> {
  if (!isRecord(value) || typeof value.email !== "string" || typeof value.password !== "string") {
    return invalid("INVALID_AUTH_REQUEST", "Body must include email and password strings");
  }

  if (value.email.trim().length === 0 || value.password.length === 0) {
    return invalid("INVALID_AUTH_REQUEST", "Email and password must not be blank");
  }

  if (mode === "register" && (typeof value.name !== "string" || value.name.trim().length === 0)) {
    return invalid("INVALID_AUTH_REQUEST", "Registration requires a non-empty name");
  }

  return {
    ok: true,
    value: {
      email: value.email,
      name: typeof value.name === "string" ? value.name : value.email,
      password: value.password
    }
  };
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is NonNullable<AgentRunInput["metadata"]> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseMultipartBody(contentType: string | string[] | undefined, body: Buffer): JsonObject {
  const header = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = header?.match(/boundary=(?:"([^"]+)"|([^;]+))/iu)?.slice(1).find(Boolean);

  if (!boundary) {
    throw new Error("Multipart boundary is required");
  }

  const fields: Record<string, string> = {};
  const files: JsonObject[] = [];
  const raw = body.toString("latin1");

  for (const part of raw.split(`--${boundary}`)) {
    if (part.trim().length === 0 || part.trim() === "--") {
      continue;
    }

    const headerEnd = part.indexOf("\r\n\r\n");

    if (headerEnd < 0) {
      continue;
    }

    const headers = part.slice(0, headerEnd).toLowerCase();
    const disposition = headers.match(/content-disposition:[^\r\n]+/iu)?.[0] ?? "";
    const name = disposition.match(/name="([^"]+)"/iu)?.[1];

    if (!name) {
      continue;
    }

    const filename = disposition.match(/filename="([^"]*)"/iu)?.[1];
    const contentTypeValue = headers.match(/content-type:\s*([^\r\n]+)/iu)?.[1]?.trim();
    const rawContent = part.slice(headerEnd + 4).replace(/\r\n--$/u, "").replace(/\r\n$/u, "");
    const content = Buffer.from(rawContent, "latin1");

    if (filename !== undefined) {
      files.push({
        contentBase64: content.toString("base64"),
        contentType: contentTypeValue ?? "application/octet-stream",
        fieldName: name,
        filename,
        size: content.byteLength
      });
      continue;
    }

    fields[name] = content.toString("utf8");
  }

  return { fields, files };
}

function sseData(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.length > 0 ? line : " ").join("\ndata: ");
}

async function* toSseStream(
  events: ReturnType<AgentRuntime["stream"]>,
  responseMode: "extended" | "reactor"
): AsyncIterable<string> {
  for await (const event of events) {
    if (event.type === "text-delta") {
      yield `event: message\ndata: ${sseData(event.text)}\n\n`;
      continue;
    }

    if (event.type === "tool-call") {
      if (responseMode === "reactor") {
        yield `event: tool_start\ndata: ${sseData(event.toolCall.name)}\n\n`;
        continue;
      }

      yield `event: tool_call\ndata: ${sseData(JSON.stringify(event.toolCall))}\n\n`;
      continue;
    }

    if (event.type === "tool-result") {
      if (responseMode === "reactor") {
        yield `event: tool_end\ndata: ${sseData(event.toolCall.name)}\n\n`;
      }

      continue;
    }

    if (event.type === "error") {
      yield `event: error\ndata: ${sseData(event.error.message)}\n\n`;
      continue;
    }

    if (event.type === "plan-generated") {
      if (responseMode !== "reactor") {
        yield `event: plan_generated\ndata: ${sseData(JSON.stringify({ plan: event.plan, runId: event.runId }))}\n\n`;
      }
      continue;
    }

    if (event.type === "plan-step-executing") {
      if (responseMode !== "reactor") {
        yield `event: plan_step_executing\ndata: ${sseData(
          JSON.stringify({ description: event.description, runId: event.runId, stepIndex: event.stepIndex, tool: event.tool })
        )}\n\n`;
      }
      continue;
    }

    if (event.type === "plan-step-result") {
      if (responseMode !== "reactor") {
        yield `event: plan_step_result\ndata: ${sseData(
          JSON.stringify({ runId: event.runId, stepIndex: event.stepIndex, success: event.success })
        )}\n\n`;
      }
      continue;
    }

    if (event.type === "synthesis-started") {
      if (responseMode !== "reactor") {
        yield `event: synthesis_started\ndata: ${sseData(JSON.stringify({ runId: event.runId }))}\n\n`;
      }
      continue;
    }

    if (responseMode === "reactor") {
      yield "event: done\ndata:\n\n";
      continue;
    }

    yield `event: done\ndata: ${sseData(JSON.stringify({
      model: event.response.model,
      response: event.response.output,
      runId: event.runId,
      usage: event.response.usage
    }))}\n\n`;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  return value === "string" || value === "number" || value === "boolean" || value === "json"
    ? value
    : undefined;
}

function parseResponseLocales(raw: string | undefined): readonly string[] {
  const fallback = ["ko", "en"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === "ko" || entry === "en");
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function isPublicRequest(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path === "/spec" ||
    path === "/v3/api-docs" ||
    path === "/api/openapi.json" ||
    path === "/.well-known/agent-card.json" ||
    path === "/api/jarvis/runtime" ||
    (method === "POST" && (
      path === "/auth/login" ||
      path === "/auth/register" ||
      path === "/api/auth/login" ||
      path === "/api/auth/register" ||
      path === "/api/auth/demo-login" ||
      path === "/api/auth/exchange" ||
      path === "/api/error-report" ||
      path === "/api/slack/commands" ||
      path === "/api/slack/events" ||
      path === "/slack/commands" ||
      path === "/slack/events"
    ))
  );
}

function attachAuthIdentity(request: unknown, identity: AuthIdentity | undefined): void {
  (request as { auth?: AuthIdentity }).auth = identity;
}

function getAuthIdentity(request: unknown): AuthIdentity | undefined {
  return (request as { auth?: AuthIdentity }).auth;
}

function authRateLimitKey(
  forwardedFor: string | string[] | undefined,
  fallbackIp: string,
  path: string
): string {
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = forwarded?.split(",")[0]?.trim() || fallbackIp || "unknown";
  return `${ip}:${path}`;
}

function toLoginResponse(login: LoginResult) {
  return {
    expiresAt: login.expiresAt.toISOString(),
    token: login.token,
    user: login.user
  };
}

function authorizeAdmin(
  request: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  authEnabled: boolean
): boolean {
  return authorizeAdminRole(request, reply, authEnabled, isDeveloperAdmin);
}

function authorizeAnyAdmin(
  request: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  authEnabled: boolean
): boolean {
  return authorizeAdminRole(request, reply, authEnabled, isAnyAdmin);
}

function authorizeAdminRole(
  request: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  authEnabled: boolean,
  isAllowed: (role: Parameters<typeof isAnyAdmin>[0]) => boolean
): boolean {
  if (!authEnabled) {
    return true;
  }

  const identity = getAuthIdentity(request);

  if (isAllowed(identity?.role)) {
    return true;
  }

  reply.status(403).send({
    error: "관리자 권한이 필요합니다",
    timestamp: new Date().toISOString()
  });
  return false;
}
