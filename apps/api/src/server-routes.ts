/**
 * Per-domain Fastify route registrars extracted from server.ts buildServer().
 *
 * Each register function takes (server, options + closure deps) and wires
 * a single domain's routes. buildServer becomes a thin composition that
 * stages registrars in sequence — guards, openapi tracking, and CORS hooks
 * stay in buildServer because they touch closure state at the request
 * level.
 */

import type { AgentSpecResolver } from "@muse/agent-core";
import { parseBoolean } from "@muse/autoconfigure";
import { extractBearerToken } from "@muse/auth";
import type { AgentSpecRegistry } from "@muse/agent-specs";
import { describeBuiltinLoopbackMcpServers } from "@muse/domain-tools";
import type { RuntimeSettings } from "@muse/runtime-settings";
import type { FastifyInstance } from "fastify";

import { ChatRateLimiter, clientKeyFromRequest } from "./chat-rate-limiter.js";
import {
  requireAuthenticated,
  createOpenApiDocument,
  getAuthIdentity,
  isRecord,
  parseAgentSpecInput,
  parseAuthCredentials,
  parseResponseLocales,
  parseRuntimeSettingInput,
  runChat,
  runChatStream,
  runMultipartChat,
  toAdminRunSummary,
  toLoginResponse
} from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface AdminGate {
  readonly authService: ServerOptions["authService"];
}

export function registerCoreRoutes(
  server: FastifyInstance,
  apiRouteMethods: ReadonlyMap<string, ReadonlySet<string>>
): void {
  const healthPayload = { service: "muse-api", status: "ok" };
  server.get("/health", async () => healthPayload);
  server.get("/api/health", async () => healthPayload);

  server.get("/spec", async () => ({
    agentCore: "model-agnostic",
    database: "postgresql",
    runner: "rust",
    server: "fastify"
  }));
  server.get("/v3/api-docs", async () => createOpenApiDocument(apiRouteMethods));
  server.get("/api/openapi.json", async () => createOpenApiDocument(apiRouteMethods));
}

export function registerChatRoutes(server: FastifyInstance, options: ServerOptions): void {
  const rateLimiter = options.chatRateLimiter ?? buildDefaultChatRateLimiter();
  const enforce = (request: { ip?: string }, reply: { status(code: number): { send(body: unknown): unknown }; header(name: string, value: string): unknown }): boolean => {
    if (rateLimiter === undefined) return true;
    const verdict = rateLimiter.consume(clientKeyFromRequest(request));
    if (verdict.allowed) return true;
    reply.header("Retry-After", String(verdict.retryAfterSeconds ?? 60));
    reply.status(429).send({
      error: "rate limit exceeded — too many chat requests from this IP. Try again shortly.",
      retryAfterSeconds: verdict.retryAfterSeconds ?? 60
    });
    return false;
  };

  server.post("/chat", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChat(request.body, reply, options, "extended", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChat(request.body, reply, options, "compat", getAuthIdentity(request)?.userId);
  });
  server.post("/chat/stream", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChatStream(request.body, reply, options, "extended", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat/stream", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runChatStream(request.body, reply, options, "compat", getAuthIdentity(request)?.userId);
  });
  server.post("/api/chat/multipart", async (request, reply) => {
    if (!enforce(request, reply)) return reply;
    return runMultipartChat(request.body, reply, options, getAuthIdentity(request)?.userId);
  });
}

// Strict parse, not Number.parseInt: a typo'd `60x` / unit-slip
// `30s` env value must NOT silently become the numeric prefix and
// install the wrong rate-limit capacity. Whole-token decimal int
// only; everything else → fallback 60.
export function parseChatRateLimitCapacity(raw: string | undefined, fallback = 60): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `MUSE_RATE_LIMIT_CHAT_DISABLED` accepts every standard truthy
 * spelling (true / 1 / yes / on, case-insensitive, trimmed). The
 * pre-fix `=== "true"` check only honored the exact literal — an
 * operator setting `=1` or `=on` saw rate limiting silently stay
 * active. Defaults to "not disabled" on undefined / unrecognised
 * so a typo'd kill switch keeps the limiter enabled (fail-safe
 * direction for a security-adjacent flag).
 */
export function isChatRateLimitDisabled(raw: string | undefined): boolean {
  return parseBoolean(raw, false);
}

function buildDefaultChatRateLimiter(): ChatRateLimiter | undefined {
  if (isChatRateLimitDisabled(process.env.MUSE_RATE_LIMIT_CHAT_DISABLED)) {
    return undefined;
  }
  const capacity = parseChatRateLimitCapacity(process.env.MUSE_RATE_LIMIT_CHAT_PER_MINUTE);
  return new ChatRateLimiter({ capacity, windowMs: 60_000 });
}

export function registerAdminRunRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  agentSpecRegistry: AgentSpecRegistry,
  runtimeSettings: RuntimeSettings,
  gate: AdminGate
): void {
  server.get("/admin/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
      authEnabled: Boolean(gate.authService),
      recentRuns: recentRuns.map(toAdminRunSummary),
      runtimeSettingCount: settings.length,
      schedulerJobCount: scheduledJobs.length
    };
  });

  server.get("/admin/users/:userId/runs", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
      const trimmed = limitRaw.trim();
      const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
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

  // DELETE a single run by id, or bulk by ?before=<iso>.
  server.delete("/api/admin/runs/:runId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }
    const { runId } = request.params as { readonly runId: string };
    const deleted = await options.historyStore.deleteRun(runId);
    if (!deleted) {
      return reply.status(404).send({
        code: "RUN_NOT_FOUND",
        message: `Run not found: ${runId}`
      });
    }
    return { deleted: true, runId };
  });

  server.delete("/api/admin/runs", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }
    const before = (request.query as { readonly before?: string } | undefined)?.before;
    if (!before) {
      return reply.status(400).send({
        code: "MISSING_BEFORE",
        message: "?before=<iso> is required for bulk delete"
      });
    }
    const parsed = Date.parse(before);
    if (!Number.isFinite(parsed)) {
      return reply.status(400).send({
        code: "INVALID_BEFORE",
        message: `before must be a parseable ISO timestamp (got '${before}')`
      });
    }
    // Read up to a generous cap, filter by cutoff, then delete one
    // by one. The InMemory store enforces a max-entries cap and the
    // Kysely store paginates; both honor the request limit so this
    // approach stays bounded even when no `--before` is set.
    const runs = await options.historyStore.listRuns({ limit: 1_000 });
    const cutoff = new Date(parsed).getTime();
    const targets = runs.filter((r) => {
      // Runs without a `startedAt` predate the column being recorded;
      // bulk-deleting those when an operator asks for `--before <X>`
      // is the conservative call (they're at least as old as X).
      if (!r.startedAt) return true;
      return r.startedAt.getTime() <= cutoff;
    });
    let deleted = 0;
    for (const target of targets) {
      if (await options.historyStore.deleteRun(target.id)) {
        deleted += 1;
      }
    }
    return { before, deleted, scanned: runs.length };
  });

  // 404 (not 200 + zero) when no counter is wired so callers can
  // tell "no detections yet" apart from "telemetry off".
  server.get("/api/admin/security/injection-counts", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    if (!options.injectionDetectionCounter) {
      return reply.status(404).send({
        code: "INJECTION_COUNTER_DISABLED",
        message: "Injection detection counter is not wired into this server"
      });
    }
    return options.injectionDetectionCounter.snapshot();
  });
}

export function registerAuthRoutes(server: FastifyInstance, authService: NonNullable<ServerOptions["authService"]>): void {
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

export function registerAgentSpecRoutes(
  server: FastifyInstance,
  agentSpecRegistry: AgentSpecRegistry,
  agentSpecResolver: AgentSpecResolver
): void {
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
}

export function registerToolsRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  agentSpecRegistry: AgentSpecRegistry,
  runtimeSettings: RuntimeSettings,
  authService: ServerOptions["authService"]
): void {
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
}

export function registerSessionSummaryRoutes(
  server: FastifyInstance,
  options: ServerOptions,
  gate: AdminGate
): void {
  server.get("/api/admin/sessions/:sessionId/summary", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
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
}

export function registerRuntimeSettingsRoutes(
  server: FastifyInstance,
  runtimeSettings: RuntimeSettings
): void {
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
}

// `/api/calendar/*` routes live in `./calendar-routes.ts` (lifted out
// to keep the calendar surface focused). Re-exported here so server.ts
// and any future consumers keep working through `./server-routes.js`.
export { registerCalendarRoutes } from "./calendar-routes.js";


// `/api/tasks/*` routes live in `./tasks-routes.ts` (lifted out so
// the on-disk tasks store helpers stay close to the route surface).
// Re-exported here so server.ts keeps working through
// `./server-routes.js`.
export { registerTasksRoutes } from "./tasks-routes.js";
