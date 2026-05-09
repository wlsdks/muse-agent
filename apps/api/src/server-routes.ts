/**
 * Per-domain Fastify route registrars extracted from server.ts buildServer().
 *
 * Each register function takes (server, options + closure deps) and wires
 * a single domain's routes. buildServer becomes a thin composition that
 * stages registrars in sequence — guards, openapi tracking, and CORS hooks
 * stay in buildServer because they touch closure state at the request
 * level.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { AgentSpecResolver } from "@muse/agent-core";
import { extractBearerToken } from "@muse/auth";
import type { AgentSpecRegistry } from "@muse/agent-specs";
import type { CalendarCredentialStore, CalendarProviderRegistry } from "@muse/calendar";
import { describeBuiltinLoopbackMcpServers } from "@muse/mcp";
import type { RuntimeSettings } from "@muse/runtime-settings";
import type { JsonObject } from "@muse/shared";
import type { FastifyInstance } from "fastify";

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
}

export function registerChatRoutes(server: FastifyInstance, options: ServerOptions): void {
  server.post("/chat", async (request, reply) => runChat(request.body, reply, options, "extended", getAuthIdentity(request)?.userId));
  server.post("/api/chat", async (request, reply) => runChat(request.body, reply, options, "compat", getAuthIdentity(request)?.userId));
  server.post("/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "extended", getAuthIdentity(request)?.userId));
  server.post("/api/chat/stream", async (request, reply) => runChatStream(request.body, reply, options, "compat", getAuthIdentity(request)?.userId));
  server.post("/api/chat/multipart", async (request, reply) => runMultipartChat(request.body, reply, options, getAuthIdentity(request)?.userId));
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

interface CalendarRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly registry: CalendarProviderRegistry;
  readonly credentialStore?: CalendarCredentialStore;
}

export function registerCalendarRoutes(server: FastifyInstance, gate: CalendarRoutesGate): void {
  server.get("/api/calendar/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    return {
      enabled: gate.registry.list().map((provider) => provider.id),
      providers: gate.registry.describe()
    };
  });

  server.get("/api/calendar/events", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const query = request.query as { readonly fromIso?: string; readonly toIso?: string; readonly providerId?: string } | undefined;
    const from = parseIsoOrDefault(query?.fromIso, new Date());
    const to = parseIsoOrDefault(query?.toIso, new Date(from.getTime() + 30 * 86_400_000));
    try {
      const events = await gate.registry.listEvents({ from, to }, query?.providerId);
      return {
        events: events.map((event) => ({
          allDay: event.allDay,
          endsAtIso: event.endsAt.toISOString(),
          id: event.id,
          location: event.location ?? null,
          notes: event.notes ?? null,
          providerId: event.providerId,
          startsAtIso: event.startsAt.toISOString(),
          tags: event.tags ?? [],
          title: event.title,
          url: event.url ?? null
        })),
        total: events.length
      };
    } catch (error) {
      return reply.status(502).send({ code: "CALENDAR_LIST_FAILED", message: error instanceof Error ? error.message : String(error) });
    }
  });

  if (!gate.credentialStore) {
    return;
  }
  const credentialStore = gate.credentialStore;

  server.get("/api/calendar/credentials", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const ids = await credentialStore.list();
    return { providers: ids };
  });

  server.put("/api/calendar/credentials/:providerId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { providerId } = request.params as { readonly providerId: string };
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply.status(400).send({
        code: "INVALID_CREDENTIAL_PAYLOAD",
        message: "Body must be a JSON object of credential key/value pairs"
      });
    }
    await credentialStore.save(providerId, body as JsonObject);
    return { providerId, saved: true };
  });

  server.delete("/api/calendar/credentials/:providerId", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { providerId } = request.params as { readonly providerId: string };
    await credentialStore.remove(providerId);
    return reply.status(204).send();
  });
}

function parseIsoOrDefault(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

interface TasksRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly tasksFile: string;
}

interface PersistedTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export function registerTasksRoutes(server: FastifyInstance, gate: TasksRoutesGate): void {
  const { tasksFile } = gate;

  server.get("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readStatusQuery((request.query as { readonly status?: string } | undefined)?.status);
    const tasks = await readTasksFile(tasksFile);
    const filtered = tasks
      .filter((task) => status === "all" || task.status === status)
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
    return { status, tasks: filtered, total: filtered.length };
  });

  server.post("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = request.body as { readonly title?: unknown; readonly notes?: unknown; readonly tags?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return reply.status(400).send({ code: "INVALID_TASK", message: "title must be a non-empty string" });
    }
    const tasks = await readTasksFile(tasksFile);
    const created: PersistedTaskRow = {
      createdAt: new Date().toISOString(),
      id: `task_${randomUUID()}`,
      status: "open",
      title,
      ...(typeof body?.notes === "string" && body.notes.trim().length > 0 ? { notes: body.notes.trim() } : {}),
      ...(Array.isArray(body?.tags)
        ? { tags: (body.tags as unknown[]).filter((entry): entry is string => typeof entry === "string") }
        : {})
    };
    await writeTasksFile(tasksFile, [...tasks, created]);
    return reply.status(201).send(created);
  });

  server.post("/api/tasks/:id/complete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const tasks = await readTasksFile(tasksFile);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    const completed: PersistedTaskRow = { ...tasks[index]!, completedAt: new Date().toISOString(), status: "done" };
    const next = [...tasks];
    next[index] = completed;
    await writeTasksFile(tasksFile, next);
    return completed;
  });

  server.delete("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const tasks = await readTasksFile(tasksFile);
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    await writeTasksFile(tasksFile, next);
    return reply.status(204).send();
  });
}

function readStatusQuery(value: string | undefined): "open" | "done" | "all" {
  return value === "done" || value === "all" ? value : "open";
}

async function readTasksFile(file: string): Promise<readonly PersistedTaskRow[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { readonly tasks?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
      return [];
    }
    return (parsed.tasks as unknown[]).flatMap((entry): readonly PersistedTaskRow[] =>
      isPersistedTaskRow(entry) ? [entry] : []
    );
  } catch {
    return [];
  }
}

async function writeTasksFile(file: string, tasks: readonly PersistedTaskRow[]): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function isPersistedTaskRow(value: unknown): value is PersistedTaskRow {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as PersistedTaskRow).id === "string"
    && typeof (value as PersistedTaskRow).title === "string"
    && typeof (value as PersistedTaskRow).createdAt === "string"
    && ((value as PersistedTaskRow).status === "open" || (value as PersistedTaskRow).status === "done");
}
