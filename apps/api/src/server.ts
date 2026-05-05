import { Readable } from "node:stream";
import {
  GuardBlockedError,
  OutputGuardBlockedError,
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
  AuthService,
  extractBearerToken,
  isAnyAdmin,
  type AuthIdentity,
  type LoginResult
} from "@muse/auth";
import type { TaskMemoryMaintenance } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type { FollowupSuggestionStore } from "@muse/observability";
import {
  InMemoryRuntimeSettingsStore,
  RuntimeSettingsService,
  type RuntimeSettingType
} from "@muse/runtime-settings";
import type { AgentRunHistoryStore, PendingApprovalStore } from "@muse/runtime-state";
import type { JsonObject, JsonValue } from "@muse/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAdminRoutes, type AdminRouteState } from "./admin-routes.js";
import { registerMcpRoutes, type McpRouteMcp } from "./mcp-routes.js";
import { registerQualityRoutes } from "./quality-routes.js";
import { registerReactorCompatibilityRoutes } from "./reactor-compat-routes.js";
import { registerSchedulerRoutes, type SchedulerRouteScheduler } from "./scheduler-routes.js";
import { registerSlackRoutes, type SlackRouteOptions } from "./slack-routes.js";

export interface ServerOptions {
  readonly logger?: boolean;
  readonly agentRuntime?: AgentRuntime;
  readonly admin?: AdminRouteState;
  readonly agentSpecRegistry?: AgentSpecRegistry;
  readonly authService?: AuthService;
  readonly authRateLimiter?: AuthRateLimiter;
  readonly followupSuggestionStore?: FollowupSuggestionStore;
  readonly historyStore?: AgentRunHistoryStore;
  readonly pendingApprovalStore?: PendingApprovalStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly defaultModel?: string;
  readonly requireAuth?: boolean;
  readonly runtimeSettings?: RuntimeSettingsService;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly slack?: SlackRouteOptions;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const agentSpecRegistry = options.agentSpecRegistry ?? new InMemoryAgentSpecRegistry();
  const agentSpecResolver = new RuleBasedAgentSpecResolver(agentSpecRegistry);
  const runtimeSettings =
    options.runtimeSettings ?? new RuntimeSettingsService(new InMemoryRuntimeSettingsStore());
  const authService = options.authService;
  const authRateLimiter = options.authRateLimiter ?? new AuthRateLimiter();
  const server = Fastify({
    logger: options.logger ?? true
  });
  const apiPaths = new Set<string>();
  server.addHook("onRoute", (routeOptions) => {
    const path = routeOptions.url;

    if (typeof path === "string" && path.startsWith("/api/")) {
      apiPaths.add(toSpringPathTemplate(path));
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
        attachAuthIdentity(request, authService.authenticateBearer(extractBearerToken(request.headers.authorization)));
        return;
      }

      const identity = authService.authenticateBearer(extractBearerToken(request.headers.authorization));

      if (!identity) {
        return reply.status(401).send({
          code: "UNAUTHENTICATED",
          message: "A valid bearer token is required"
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

  server.post("/chat", async (request, reply) => runChat(request.body, reply, options));
  server.post("/api/chat", async (request, reply) => runChat(request.body, reply, options));
  server.post("/chat/stream", async (request, reply) => runChatStream(request.body, reply, options));
  server.post("/api/chat/stream", async (request, reply) => runChatStream(request.body, reply, options));
  server.post("/api/chat/multipart", async (request, reply) => runMultipartChat(request.body, reply, options));

  server.get("/admin/summary", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    const [agentSpecs, settings, scheduledJobs] = await Promise.all([
      agentSpecRegistry.list(),
      runtimeSettings.list(),
      options.scheduler?.store.list() ?? []
    ]);

    return {
      agentSpecCount: agentSpecs.length,
      authEnabled: Boolean(authService),
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

  server.get("/admin/runs/:runId", async (request, reply) => {
    if (!authorizeAdmin(request, reply, Boolean(authService))) {
      return reply;
    }

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const { runId } = request.params as { readonly runId: string };
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
  registerReactorCompatibilityRoutes(server, {
    admin: options.admin,
    agentRuntime: options.agentRuntime,
    agentSpecRegistry,
    authRateLimiter,
    authService,
    authorizeAdmin: (request, reply) => authorizeAdmin(request, reply, Boolean(authService)),
    apiPathRegistry: () => [...apiPaths].sort(),
    defaultModel: options.defaultModel,
    followupSuggestionStore: options.followupSuggestionStore,
    historyStore: options.historyStore,
    mcp: options.mcp,
    modelProvider: options.modelProvider,
    pendingApprovalStore: options.pendingApprovalStore,
    runtimeSettings,
    scheduler: options.scheduler,
    taskMemoryMaintenance: options.taskMemoryMaintenance
  });

  if (authService) {
    server.post("/auth/register", async (request, reply) => {
      const parsed = parseAuthCredentials(request.body, "register");

      if (!parsed.ok) {
        return reply.status(400).send(parsed.error);
      }

      try {
        return reply.status(201).send(toLoginResponse(authService.register(parsed.value)));
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

      const login = authService.login(parsed.value.email, parsed.value.password);

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
      revoked: authService.logout(extractBearerToken(request.headers.authorization))
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

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

interface ApiError {
  readonly code: string;
  readonly message: string;
}

async function runChat(
  body: unknown,
  reply: { status(statusCode: number): { send(payload: unknown): void } },
  options: ServerOptions
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
    return toChatResponse(await options.agentRuntime.run(parsed.value));
  } catch (error) {
    return sendAgentError(reply, error);
  }
}

async function runChatStream(
  body: unknown,
  reply: {
    header(name: string, value: string): unknown;
    status(statusCode: number): { send(payload: unknown): void };
    send(payload: unknown): unknown;
  },
  options: ServerOptions
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
  return reply.send(Readable.from(toSseStream(options.agentRuntime.stream(parsed.value))));
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

  return runChat(parsed.value, reply, options);
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

function toChatResponse(result: AgentRunResult) {
  const tokenUsage = reactorTokenUsage(result.response.usage);
  const metadata = reactorResponseMetadata(result);

  return {
    agentSpec: result.agentSpec,
    blockReason: typeof metadata.blockReason === "string" ? metadata.blockReason : null,
    content: result.response.output,
    contextWindow: result.contextWindow,
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    fromCache: result.fromCache ?? false,
    grounded: typeof metadata.grounded === "boolean" ? metadata.grounded : null,
    metadata,
    model: result.response.model,
    response: result.response.output,
    runId: result.runId,
    success: true,
    tokenUsage,
    toolsUsed: result.toolsUsed ?? [],
    usage: result.response.usage,
    verifiedSourceCount: typeof metadata.verifiedSourceCount === "number" ? metadata.verifiedSourceCount : null
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
  error: unknown
) {
  if (error instanceof GuardBlockedError) {
    return reply.status(403).send({
      blockReason: error.message,
      code: error.code ?? "GUARD_BLOCKED",
      content: null,
      errorCode: error.code ?? "GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message,
      success: false
    } as ApiError);
  }

  if (error instanceof OutputGuardBlockedError) {
    return reply.status(422).send({
      blockReason: error.message,
      code: error.code ?? "OUTPUT_GUARD_BLOCKED",
      content: null,
      errorCode: error.code ?? "OUTPUT_GUARD_BLOCKED",
      errorMessage: error.message,
      message: error.message,
      success: false
    } as ApiError);
  }

  return reply.status(500).send({
    code: "AGENT_RUN_FAILED",
    content: null,
    errorCode: "AGENT_RUN_FAILED",
    errorMessage: error instanceof Error ? error.message : "Agent run failed",
    message: error instanceof Error ? error.message : "Agent run failed",
    success: false
  } as ApiError);
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

async function* toSseStream(events: ReturnType<AgentRuntime["stream"]>): AsyncIterable<string> {
  for await (const event of events) {
    if (event.type === "text-delta") {
      yield `event: message\ndata: ${sseData(event.text)}\n\n`;
      continue;
    }

    if (event.type === "tool-call") {
      yield `event: tool_call\ndata: ${sseData(JSON.stringify(event.toolCall))}\n\n`;
      continue;
    }

    if (event.type === "error") {
      yield `event: error\ndata: ${sseData(event.error.message)}\n\n`;
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

function isPublicRequest(method: string, url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path === "/spec" ||
    path === "/.well-known/agent-card.json" ||
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
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  authEnabled: boolean
): boolean {
  if (!authEnabled) {
    return true;
  }

  const identity = getAuthIdentity(request);

  if (isAnyAdmin(identity?.role)) {
    return true;
  }

  reply.status(403).send({
    code: "FORBIDDEN",
    message: "Admin access is required"
  });
  return false;
}
