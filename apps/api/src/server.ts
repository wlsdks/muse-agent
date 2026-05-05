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
import {
  InMemoryRuntimeSettingsStore,
  RuntimeSettingsService,
  type RuntimeSettingType
} from "@muse/runtime-settings";
import type { AgentRunHistoryStore } from "@muse/runtime-state";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMcpRoutes, type McpRouteMcp } from "./mcp-routes.js";
import { registerSchedulerRoutes, type SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface ServerOptions {
  readonly logger?: boolean;
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry?: AgentSpecRegistry;
  readonly authService?: AuthService;
  readonly authRateLimiter?: AuthRateLimiter;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly defaultModel?: string;
  readonly requireAuth?: boolean;
  readonly runtimeSettings?: RuntimeSettingsService;
  readonly scheduler?: SchedulerRouteScheduler;
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
  },
  options: ServerOptions
) {
  const response = await runChat(body, reply, options);

  if (!isRecord(response) || typeof response.response !== "string") {
    return response;
  }

  reply.header("content-type", "text/event-stream; charset=utf-8");
  return [
    `event: message\ndata: ${sseData(response.response)}\n`,
    `event: done\ndata: ${sseData(JSON.stringify({ runId: response.runId }))}\n`
  ].join("\n");
}

function parseAgentRunInput(value: unknown, defaultModel: string): ParseResult<AgentRunInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_CHAT_REQUEST", "Body must be an object");
  }

  const messages = parseMessages(value.messages, value.message);

  if (!messages) {
    return invalid("INVALID_CHAT_REQUEST", "Body must include message or messages");
  }

  return {
    ok: true,
    value: {
      messages,
      metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
      model: typeof value.model === "string" && value.model.trim().length > 0 ? value.model : defaultModel,
      runId: typeof value.runId === "string" && value.runId.trim().length > 0 ? value.runId : undefined
    }
  };
}

function parseMessages(messages: unknown, message: unknown): AgentRunInput["messages"] | undefined {
  if (Array.isArray(messages)) {
    const parsed = messages.flatMap((item) => {
      if (!isRecord(item) || typeof item.content !== "string" || !isModelRole(item.role)) {
        return [];
      }

      return [{
        content: item.content,
        name: optionalString(item.name),
        role: item.role,
        toolCallId: optionalString(item.toolCallId)
      }];
    });

    return parsed.length === messages.length && parsed.length > 0 ? parsed : undefined;
  }

  return typeof message === "string" && message.trim().length > 0
    ? [{ content: message, role: "user" }]
    : undefined;
}

function isModelRole(value: unknown): value is AgentRunInput["messages"][number]["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function toChatResponse(result: AgentRunResult) {
  return {
    agentSpec: result.agentSpec,
    contextWindow: result.contextWindow,
    fromCache: result.fromCache ?? false,
    model: result.response.model,
    response: result.response.output,
    runId: result.runId,
    toolsUsed: result.toolsUsed ?? [],
    usage: result.response.usage
  };
}

function sendAgentError(
  reply: { status(statusCode: number): { send(payload: ApiError): void } },
  error: unknown
) {
  if (error instanceof GuardBlockedError) {
    return reply.status(403).send({
      code: error.code ?? "GUARD_BLOCKED",
      message: error.message
    });
  }

  if (error instanceof OutputGuardBlockedError) {
    return reply.status(422).send({
      code: error.code ?? "OUTPUT_GUARD_BLOCKED",
      message: error.message
    });
  }

  return reply.status(500).send({
    code: "AGENT_RUN_FAILED",
    message: error instanceof Error ? error.message : "Agent run failed"
  });
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

function sseData(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.length > 0 ? line : " ").join("\ndata: ");
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
    (method === "POST" && (path === "/auth/login" || path === "/auth/register"))
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
