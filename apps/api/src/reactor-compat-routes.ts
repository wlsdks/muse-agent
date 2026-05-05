import type { AgentSpecInput, AgentSpecRegistry } from "@muse/agent-specs";
import { AuthRateLimiter, AuthService, extractBearerToken, type LoginResult } from "@muse/auth";
import type { ModelProvider } from "@muse/model";
import type { RuntimeSettingsService, RuntimeSettingType } from "@muse/runtime-settings";
import type { AgentRunHistoryStore, PendingApprovalStore } from "@muse/runtime-state";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminRouteState } from "./admin-routes.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface ReactorCompatibilityRouteOptions {
  readonly admin?: AdminRouteState;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authRateLimiter: AuthRateLimiter;
  readonly authService?: AuthService;
  readonly authorizeAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly defaultModel?: string;
  readonly historyStore?: AgentRunHistoryStore;
  readonly modelProvider?: ModelProvider;
  readonly pendingApprovalStore?: PendingApprovalStore;
  readonly runtimeSettings: RuntimeSettingsService;
  readonly scheduler?: SchedulerRouteScheduler;
}

type CompatRecord = JsonObject & {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type CompatBody = Record<string, unknown>;
type CompatCollection = Map<string, CompatRecord>;

interface CompatState {
  readonly documents: CompatCollection;
  readonly feedback: CompatCollection;
  readonly inputGuardRules: CompatCollection;
  readonly intents: CompatCollection;
  readonly outputGuardRules: CompatCollection;
  readonly personas: CompatCollection;
  readonly promptExperiments: CompatCollection;
  readonly promptTemplates: CompatCollection;
  readonly ragCandidates: CompatCollection;
  readonly slackBots: CompatCollection;
  readonly slackFaq: CompatCollection;
  readonly swaggerSources: CompatCollection;
  readonly userMemory: Map<string, { facts: JsonObject; preferences: JsonObject; updatedAt: string }>;
  retentionPolicy: JsonObject;
  toolPolicy: JsonObject;
}

let state: CompatState = createCompatState();

export function registerReactorCompatibilityRoutes(
  server: FastifyInstance,
  options: ReactorCompatibilityRouteOptions
): void {
  state = createCompatState();
  registerAuthCompatibilityRoutes(server, options);
  registerSessionCompatibilityRoutes(server, options);
  registerAgentCompatibilityRoutes(server, options);
  registerApprovalCompatibilityRoutes(server, options);
  registerPolicyCompatibilityRoutes(server, options);
  registerGuardCompatibilityRoutes(server, options);
  registerMemoryAndFeedbackRoutes(server, options);
  registerPromptAndRagRoutes(server, options);
  registerMcpCompatibilityRoutes(server, options);
  registerSlackCompatibilityRoutes(server, options);
  registerAdminCompatibilityRoutes(server, options);
}

function createCompatState(): CompatState {
  return {
    documents: new Map(),
    feedback: new Map(),
    inputGuardRules: new Map(),
    intents: new Map(),
    outputGuardRules: new Map(),
    personas: new Map(),
    promptExperiments: new Map(),
    promptTemplates: new Map(),
    ragCandidates: new Map(),
    slackBots: new Map(),
    slackFaq: new Map(),
    swaggerSources: new Map(),
    userMemory: new Map(),
    retentionPolicy: {
      auditRetentionDays: 90,
      feedbackRetentionDays: 365,
      runRetentionDays: 30
    },
    toolPolicy: {
      approvalRequiredRisks: ["write", "execute"],
      enabled: true,
      maxToolsPerRequest: 60
    }
  };
}

function registerAuthCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.post("/api/auth/register", async (request, reply) => {
    const authService = requireAuthService(options, reply);

    if (!authService) {
      return reply;
    }

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

  server.post("/api/auth/login", async (request, reply) => {
    const authService = requireAuthService(options, reply);

    if (!authService) {
      return reply;
    }

    const key = authRateLimitKey(request.headers["x-forwarded-for"], request.ip, "/api/auth/login");

    if (options.authRateLimiter.isBlocked(key)) {
      return reply.status(429).send({
        code: "AUTH_RATE_LIMITED",
        message: "Too many authentication attempts"
      });
    }

    const parsed = parseAuthCredentials(request.body, "login");

    if (!parsed.ok) {
      options.authRateLimiter.recordFailure(key);
      return reply.status(400).send(parsed.error);
    }

    const login = authService.login(parsed.value.email, parsed.value.password);

    if (!login) {
      options.authRateLimiter.recordFailure(key);
      return reply.status(401).send({
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials"
      });
    }

    options.authRateLimiter.recordSuccess(key);
    return toLoginResponse(login);
  });

  server.post("/api/auth/demo-login", async (_request, reply) => {
    const authService = requireAuthService(options, reply);

    if (!authService) {
      return reply;
    }

    const credentials = {
      email: "demo_user",
      name: "Demo User",
      password: "demo-password"
    };

    try {
      return toLoginResponse(authService.register(credentials));
    } catch {
      const login = authService.login(credentials.email, credentials.password);
      return login ? toLoginResponse(login) : reply.status(401).send({
        code: "DEMO_LOGIN_UNAVAILABLE",
        message: "Demo user exists but could not be authenticated"
      });
    }
  });

  server.post("/api/auth/exchange", async (request, reply) => {
    const authService = requireAuthService(options, reply);

    if (!authService) {
      return reply;
    }

    const identity = authService.authenticateBearer(extractBearerToken(request.headers.authorization));

    if (!identity) {
      return reply.status(401).send({
        code: "TOKEN_EXCHANGE_FAILED",
        message: "A valid bearer token is required"
      });
    }

    return { identity };
  });

  server.get("/api/auth/me", async (request, reply) => {
    const authService = requireAuthService(options, reply);

    if (!authService) {
      return reply;
    }

    const identity = authService.authenticateBearer(extractBearerToken(request.headers.authorization));

    if (!identity) {
      return reply.status(401).send({
        code: "UNAUTHENTICATED",
        message: "A valid bearer token is required"
      });
    }

    return { identity };
  });

  server.post("/api/auth/logout", async (request) => ({
    revoked: options.authService?.logout(extractBearerToken(request.headers.authorization)) ?? false
  }));

  server.post("/api/auth/change-password", async (_request, reply) => reply.status(501).send({
    code: "CHANGE_PASSWORD_UNAVAILABLE",
    message: "Password change requires a writable user store adapter"
  }));
}

function registerSessionCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/sessions", async (request, reply) => {
    const userId = readQueryString(request, "userId") ?? readAuthUserId(request);

    if (!userId || !options.historyStore) {
      return [];
    }

    return options.historyStore.listRunsByUser(userId);
  });

  server.get("/api/sessions/:sessionId", async (request, reply) => sessionDetail(request, reply, options));
  server.get("/api/sessions/:sessionId/export", async (request, reply) => sessionDetail(request, reply, options));
  server.delete("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { readonly sessionId: string };
    return {
      deleted: false,
      reason: "Run history deletion is not enabled for the compatibility store",
      sessionId
    };
  });

  server.get("/api/models", async () => listModelSummaries(options));
}

function registerAgentCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/.well-known/agent-card.json", async () => ({
    capabilities: {
      modelAgnostic: true,
      streaming: true,
      tools: true
    },
    defaultModel: options.defaultModel ?? null,
    name: "Muse",
    protocolVersion: "0.1.0",
    service: "muse-api"
  }));

  server.get("/api/admin/agent-specs", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.agentSpecRegistry.list();
  });

  server.get("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const spec = await findAgentSpec(options.agentSpecRegistry, id);

    if (!spec) {
      return reply.status(404).send({
        code: "AGENT_SPEC_NOT_FOUND",
        message: `Agent spec not found: ${id}`
      });
    }

    return spec;
  });

  server.get("/api/admin/agent-specs/:id/system-prompt", async (request, reply) => {
    const spec = await findAgentSpecOrReply(request, reply, options);
    return spec ?? reply;
  });

  server.post("/api/admin/agent-specs", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const parsed = parseAgentSpecInput(request.body);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return reply.status(201).send(await options.agentSpecRegistry.save(parsed.value));
  });

  server.put("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const parsed = parseAgentSpecInput(request.body, id);

    if (!parsed.ok) {
      return reply.status(400).send(parsed.error);
    }

    return options.agentSpecRegistry.save(parsed.value);
  });

  server.delete("/api/admin/agent-specs/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    await options.agentSpecRegistry.deleteById(id);
    await options.agentSpecRegistry.deleteByName(id);
    return { deleted: true, id };
  });

  server.get("/api/admin/models", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return listModelSummaries(options);
  });
}

function registerApprovalCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/approvals", async (request, reply) => {
    const store = requirePendingApprovalStore(options, reply);

    if (!store) {
      return reply;
    }

    const offset = readQueryInteger(request, "offset", 0);
    const limit = readQueryInteger(request, "limit", 50);
    const userId = readQueryString(request, "userId") ?? readAuthUserId(request);
    const items = isAdminLikeRequest(request) || !userId
      ? await store.listPending()
      : await store.listPendingByUser(userId);
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const paged = items.slice(safeOffset, safeOffset + safeLimit);

    return {
      items: paged,
      limit: safeLimit,
      offset: safeOffset,
      total: items.length
    };
  });

  server.post("/api/approvals/:id/approve", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const store = requirePendingApprovalStore(options, reply);

    if (!store) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const modifiedArguments = toBody(request.body).modifiedArguments;
    const success = await store.approve(id, isRecord(modifiedArguments) ? toJsonObject(modifiedArguments) : undefined);
    return {
      message: success ? "Approved" : "Approval not found or already resolved",
      success
    };
  });

  server.post("/api/approvals/:id/reject", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const store = requirePendingApprovalStore(options, reply);

    if (!store) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const success = await store.reject(id, readBodyNullableString(request.body, "reason") ?? undefined);
    return {
      message: success ? "Rejected" : "Approval not found or already resolved",
      success
    };
  });
}

function registerPolicyCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/tool-policy", async () => state.toolPolicy);
  server.put("/api/tool-policy", async (request) => {
    state.toolPolicy = { ...state.toolPolicy, ...toJsonObject(request.body), updatedAt: nowIso() };
    return state.toolPolicy;
  });
  server.delete("/api/tool-policy", async () => {
    state.toolPolicy = { enabled: false, updatedAt: nowIso() };
    return { deleted: true };
  });

  server.get("/api/admin/rbac/roles", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [
      { role: "user", scopes: [] },
      { role: "admin", scopes: ["full"] },
      { role: "admin_manager", scopes: ["manager"] },
      { role: "admin_developer", scopes: ["developer"] }
    ];
  });

  server.put("/api/admin/rbac/users/:userId/role", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { userId } = request.params as { readonly userId: string };
    return { updated: true, userId, ...toJsonObject(request.body) };
  });

  server.get("/api/admin/retention", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return state.retentionPolicy;
  });

  server.put("/api/admin/retention", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    state.retentionPolicy = { ...state.retentionPolicy, ...toJsonObject(request.body), updatedAt: nowIso() };
    return state.retentionPolicy;
  });
}

function registerGuardCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerCollectionRoutes(server, "/api/admin/input-guard/rules", state.inputGuardRules, {
    authorize: options.authorizeAdmin
  });
  registerCollectionRoutes(server, "/api/output-guard/rules", state.outputGuardRules);

  server.get("/api/admin/input-guard/pipeline", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return {
      enabled: true,
      stages: [
        { name: "length", order: 0 },
        { name: "prompt_injection", order: 1 },
        { name: "pii", order: 2 }
      ]
    };
  });

  server.put("/api/admin/input-guard/settings", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { updated: true, ...toJsonObject(request.body) };
  });

  server.put("/api/admin/input-guard/pipeline/reorder", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { reordered: true, ...toJsonObject(request.body) };
  });

  server.get("/api/admin/input-guard/stages/:stageName/config", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { stageName } = request.params as { readonly stageName: string };
    return { enabled: true, stageName };
  });

  server.put("/api/admin/input-guard/stages/:stageName/config", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { stageName } = request.params as { readonly stageName: string };
    return { stageName, updated: true, ...toJsonObject(request.body) };
  });

  server.get("/api/admin/input-guard/audits", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [];
  });

  server.get("/api/output-guard/rules/audits", async () => []);
  server.post("/api/admin/input-guard/simulate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return simulateGuard(request.body);
  });
  server.post("/api/output-guard/rules/simulate", async (request) => simulateGuard(request.body));
}

function registerMemoryAndFeedbackRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/user-memory/:userId", async (request) => {
    const { userId } = request.params as { readonly userId: string };
    return getUserMemory(userId);
  });
  server.put("/api/user-memory/:userId/facts", async (request) => updateUserMemory(request, "facts"));
  server.put("/api/user-memory/:userId/preferences", async (request) => updateUserMemory(request, "preferences"));
  server.delete("/api/user-memory/:userId", async (request) => {
    const { userId } = request.params as { readonly userId: string };
    return { deleted: state.userMemory.delete(userId), userId };
  });

  registerCollectionRoutes(server, "/api/feedback", state.feedback, {
    idParamName: "feedbackId",
    onCreate: (record) => ({ ...record, reviewed: false })
  });
  server.get("/api/feedback/stats", async () => feedbackStats());
  server.get("/api/feedback/unreviewed-count", async () => ({
    count: [...state.feedback.values()].filter((item) => item.reviewed !== true).length
  }));
  server.get("/api/feedback/export", async () => [...state.feedback.values()]);
  server.post("/api/feedback/bulk-update", async (request) => {
    const body = toBody(request.body);
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];

    for (const id of ids) {
      const existing = state.feedback.get(id);

      if (existing) {
        state.feedback.set(id, { ...existing, ...toJsonObject(body.patch), updatedAt: nowIso() });
      }
    }

    return { updated: ids.length };
  });

  server.post("/api/error-report", async (request) => ({
    accepted: true,
    id: createRunId("error_report"),
    receivedAt: nowIso(),
    report: toJsonObject(request.body)
  }));
}

function registerPromptAndRagRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerCollectionRoutes(server, "/api/personas", state.personas, { idParamName: "personaId" });
  registerCollectionRoutes(server, "/api/prompt-templates", state.promptTemplates, { idParamName: "templateId" });
  registerCollectionRoutes(server, "/api/documents", state.documents, {
    authorize: options.authorizeAdmin,
    onCreate: (record) => ({ ...record, indexed: true })
  });
  registerCollectionRoutes(server, "/api/intents", state.intents, {
    idParamName: "intentName",
    inputIdKey: "name"
  });

  server.post("/api/prompt-templates/:templateId/versions", async (request) => {
    const { templateId } = request.params as { readonly templateId: string };
    return appendNestedVersion(state.promptTemplates, templateId, request.body);
  });
  server.put("/api/prompt-templates/:templateId/versions/:versionId/activate", async (request) =>
    setNestedVersionState(state.promptTemplates, request, "active")
  );
  server.put("/api/prompt-templates/:templateId/versions/:versionId/archive", async (request) =>
    setNestedVersionState(state.promptTemplates, request, "archived")
  );

  server.post("/api/documents/batch", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const documents = toBody(request.body).documents;
    const items: readonly unknown[] = Array.isArray(documents) ? documents : [];
    const saved = items.map((item) => createRecord(state.documents, toJsonObject(item), "document"));
    return { count: saved.length, documents: saved };
  });
  server.post("/api/documents/search", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const query = readBodyString(request.body, "query")?.toLowerCase() ?? "";
    return [...state.documents.values()].filter((document) => JSON.stringify(document).toLowerCase().includes(query));
  });
  server.delete("/api/documents", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const rawIds = toBody(request.body).ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === "string")
      : [];
    const before = state.documents.size;

    if (ids.length === 0) {
      state.documents.clear();
      return reply.status(204).send();
    }

    for (const id of ids) {
      state.documents.delete(id);
    }

    return { deleted: before - state.documents.size, ids };
  });

  server.get("/api/rag-ingestion/policy", async () => ({ enabled: true, requireApproval: true }));
  server.put("/api/rag-ingestion/policy", async (request) => ({ updated: true, ...toJsonObject(request.body) }));
  server.delete("/api/rag-ingestion/policy", async () => ({ deleted: true }));
  server.get("/api/rag-ingestion/candidates", async () => [...state.ragCandidates.values()]);
  server.post("/api/rag-ingestion/candidates/:id/approve", async (request) =>
    updateCandidate(request, "approved")
  );
  server.post("/api/rag-ingestion/candidates/:id/reject", async (request) =>
    updateCandidate(request, "rejected")
  );

  server.post("/api/prompt-lab/experiments", async (request) =>
    createRecord(state.promptExperiments, toJsonObject(request.body), "prompt_experiment")
  );
  server.get("/api/prompt-lab/experiments", async () => [...state.promptExperiments.values()]);
  server.get("/api/prompt-lab/experiments/:id", async (request, reply) =>
    findRecordByParam(state.promptExperiments, request, reply, "id")
  );
  server.delete("/api/prompt-lab/experiments/:id", async (request) => deleteByParam(state.promptExperiments, request));
  server.post("/api/prompt-lab/experiments/:id/run", async (request, reply) =>
    promptExperimentAction(request, reply, "completed")
  );
  server.post("/api/prompt-lab/experiments/:id/cancel", async (request, reply) =>
    promptExperimentAction(request, reply, "cancelled")
  );
  server.post("/api/prompt-lab/experiments/:id/activate", async (request, reply) =>
    promptExperimentAction(request, reply, "active")
  );
  server.get("/api/prompt-lab/experiments/:id/status", async (request, reply) => {
    const record = findCompatRecord(state.promptExperiments, (request.params as { id: string }).id);
    return record ? { id: record.id, status: record.status ?? "draft" } : notFound(reply, "PROMPT_EXPERIMENT_NOT_FOUND");
  });
  server.get("/api/prompt-lab/experiments/:id/trials", async () => []);
  server.get("/api/prompt-lab/experiments/:id/report", async (request) => ({
    experimentId: (request.params as { id: string }).id,
    ranking: [],
    results: []
  }));
  server.post("/api/prompt-lab/auto-optimize", async (request) => ({
    recommendations: [],
    request: toJsonObject(request.body)
  }));
  server.post("/api/prompt-lab/analyze", async (request) => ({
    findings: [],
    request: toJsonObject(request.body)
  }));
}

function registerMcpCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/mcp/servers/:name/preflight", async (request) => ({
    checks: [{ name: "registered", status: "ok" }],
    name: (request.params as { readonly name: string }).name,
    status: "ok"
  }));
  server.get("/api/mcp/servers/:name/access-policy", async (request) => ({
    denyAll: false,
    name: (request.params as { readonly name: string }).name
  }));
  server.put("/api/mcp/servers/:name/access-policy", async (request) => ({
    name: (request.params as { readonly name: string }).name,
    policy: toJsonObject(request.body),
    updated: true
  }));
  server.delete("/api/mcp/servers/:name/access-policy", async (request) => ({
    deleted: true,
    name: (request.params as { readonly name: string }).name
  }));
  server.post("/api/mcp/servers/:name/access-policy/emergency-deny-all", async (request) => ({
    denyAll: true,
    name: (request.params as { readonly name: string }).name
  }));
  server.get("/api/mcp/servers/:name/swagger/sources", async () => [...state.swaggerSources.values()]);
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName", async (request, reply) =>
    findRecordByParam(state.swaggerSources, request, reply, "sourceName")
  );
  server.post("/api/mcp/servers/:name/swagger/sources", async (request) =>
    createRecord(state.swaggerSources, toJsonObject(request.body), "swagger_source")
  );
  server.put("/api/mcp/servers/:name/swagger/sources/:sourceName", async (request) =>
    upsertByParam(state.swaggerSources, request, "sourceName", "swagger_source")
  );
  server.post("/api/mcp/servers/:name/swagger/sources/:sourceName/sync", async (request) =>
    sourceAction(request, "synced")
  );
  server.post("/api/mcp/servers/:name/swagger/sources/:sourceName/publish", async (request) =>
    sourceAction(request, "published")
  );
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName/revisions", async () => []);
  server.get("/api/mcp/servers/:name/swagger/sources/:sourceName/diff", async () => ({ changes: [] }));
}

function registerSlackCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  registerCollectionRoutes(server, "/api/admin/slack-bots", state.slackBots, { authorize: options.authorizeAdmin });
  server.get("/api/proactive-channels", async () => []);
  server.post("/api/proactive-channels", async (request) => ({ created: true, ...toJsonObject(request.body) }));
  server.delete("/api/proactive-channels/:channelId", async (request) => ({
    channelId: (request.params as { readonly channelId: string }).channelId,
    deleted: true
  }));

  server.post("/api/admin/slack/channels/faq", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return createRecord(state.slackFaq, toJsonObject(request.body), "slack_faq");
  });
  server.get("/api/admin/slack/channels/faq", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [...state.slackFaq.values()];
  });
  server.get("/api/admin/slack/channels/faq/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { channels: state.slackFaq.size, entries: state.slackFaq.size };
  });
  server.get("/api/admin/slack/channels/faq/scheduler/health", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { enabled: Boolean(options.scheduler?.service), status: "ok" };
  });
  server.get("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return findRecordByParam(state.slackFaq, request, reply, "channelId");
  });
  server.patch("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return upsertByParam(state.slackFaq, request, "channelId", "slack_faq");
  });
  server.delete("/api/admin/slack/channels/faq/:channelId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return deleteByParam(state.slackFaq, request, "channelId");
  });
  server.post("/api/admin/slack/channels/faq/:channelId/ingest", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqAction(request, "ingested");
  });
  server.post("/api/admin/slack/channels/faq/:channelId/probe", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqAction(request, "probed");
  });
  server.post("/api/admin/slack/channels/faq/:channelId/dry-run", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return slackFaqAction(request, "dry_run");
  });
  server.get("/api/admin/slack/channels/faq/:channelId/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { events: 0, feedback: 0 };
  });
  server.get("/api/admin/slack/channels/faq/:channelId/events", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [];
  });
  server.get("/api/admin/slack/channels/faq/:channelId/feedback", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [];
  });
  server.post("/api/admin/slack/prompts/reload", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { reloaded: true };
  });
}

function registerAdminCompatibilityRoutes(server: FastifyInstance, options: ReactorCompatibilityRouteOptions): void {
  server.get("/api/admin/settings", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.runtimeSettings.list();
  });
  server.get("/api/admin/settings/:key", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { key } = request.params as { readonly key: string };
    const setting = await options.runtimeSettings.find(key);
    return setting ?? notFound(reply, "RUNTIME_SETTING_NOT_FOUND");
  });
  server.put("/api/admin/settings/:key", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { key } = request.params as { readonly key: string };
    const body = toBody(request.body);
    return options.runtimeSettings.set({
      category: readBodyString(body, "category"),
      description: readBodyNullableString(body, "description"),
      key,
      type: parseRuntimeSettingType(body.type),
      updatedBy: readBodyNullableString(body, "updatedBy"),
      value: readBodyString(body, "value") ?? JSON.stringify(toJsonObject(body))
    });
  });
  server.delete("/api/admin/settings/:key", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { key } = request.params as { readonly key: string };
    await options.runtimeSettings.delete(key);
    return { deleted: true, key };
  });
  server.post("/api/admin/settings/refresh", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { refreshed: true };
  });

  server.get("/api/ops/dashboard", async () => dashboardSummary(options));
  server.get("/api/ops/metrics/names", async () => ["agent_run", "tool_call", "cache", "scheduler"]);
  server.get("/api/admin/capabilities", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return {
      admin: true,
      analytics: true,
      compatibility: true,
      scheduler: Boolean(options.scheduler?.service)
    };
  });

  server.get("/api/admin/platform/health", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { status: "ok", summary: await dashboardSummary(options) };
  });
  server.get("/api/admin/doctor", async (request, reply) => adminDiagnostic(request, reply, options));
  server.get("/api/admin/doctor/summary", async (request, reply) => adminDiagnostic(request, reply, options));
  server.get("/api/admin/platform/cache/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.cache?.metrics?.snapshot() ?? {};
  });
  server.post("/api/admin/platform/cache/invalidate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    options.admin?.cache?.responseCache?.invalidateAll();
    return { invalidated: true };
  });
  server.post("/api/admin/platform/cache/invalidate-key", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const key = readBodyString(request.body, "key") ?? "";
    return { invalidated: options.admin?.cache?.responseCache?.invalidate?.(key) ?? false, key };
  });
  server.post("/api/admin/platform/cache/invalidate-by-pattern", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const pattern = readBodyString(request.body, "pattern") ?? "";
    return { invalidated: options.admin?.cache?.responseCache?.invalidateByPattern?.(pattern) ?? 0, pattern };
  });

  server.get("/api/admin/platform/tenants", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.operations?.listTenants() ?? [];
  });
  server.post("/api/admin/platform/tenants", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const name = readBodyString(request.body, "name");

    if (!name) {
      return reply.status(400).send({ code: "INVALID_TENANT", message: "Body must include name" });
    }

    return options.admin?.operations?.upsertTenant({
      id: readBodyString(request.body, "id"),
      monthlyBudgetUsd: readBodyString(request.body, "monthlyBudgetUsd"),
      name
    }) ?? reply.status(404).send({ code: "ADMIN_OPERATIONS_UNAVAILABLE", message: "Admin store missing" });
  });
  server.get("/api/admin/platform/tenants/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const tenants = await (options.admin?.operations?.listTenants() ?? []);
    const tenant = tenants.find((item) => item.id === (request.params as { readonly id: string }).id);
    return tenant ?? notFound(reply, "TENANT_NOT_FOUND");
  });
  server.post("/api/admin/platform/tenants/:id/activate", async (request, reply) =>
    updateTenantStatus(request, reply, options, "active")
  );
  server.post("/api/admin/platform/tenants/:id/suspend", async (request, reply) =>
    updateTenantStatus(request, reply, options, "suspended")
  );

  server.get("/api/admin/platform/alerts", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.operations?.listAlerts() ?? [];
  });
  server.post("/api/admin/platform/alerts/evaluate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { evaluated: true, alerts: await (options.admin?.operations?.listAlerts() ?? []) };
  });
  server.post("/api/admin/platform/alerts/:id/resolve", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    return options.admin?.operations?.acknowledgeAlert(id) ?? notFound(reply, "ADMIN_ALERT_NOT_FOUND");
  });

  server.get("/api/admin/tenant/overview", async (request, reply) => tenantSummary(request, reply, options));
  server.get("/api/admin/tenant/usage", async (request, reply) => tenantSummary(request, reply, options));
  server.get("/api/admin/tenant/cost", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.operations?.costSummary() ?? { byModel: {}, byTenant: {}, totalCostUsd: "0.00000000" };
  });
  server.get("/api/admin/tenant/alerts", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.operations?.listAlerts() ?? [];
  });
  server.get("/api/admin/tenant/slo", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.operations?.listSlos() ?? [];
  });

  server.all("/api/admin/*", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return {
      compatibility: true,
      data: [],
      method: request.method,
      route: request.url.split("?")[0] ?? request.url
    };
  });
}

function registerCollectionRoutes(
  server: FastifyInstance,
  prefix: string,
  collection: CompatCollection,
  options: {
    readonly authorize?: ReactorCompatibilityRouteOptions["authorizeAdmin"];
    readonly idParamName?: string;
    readonly inputIdKey?: string;
    readonly onCreate?: (record: CompatRecord) => CompatRecord;
  } = {}
): void {
  const idParamName = options.idParamName ?? "id";

  server.get(prefix, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    return [...collection.values()];
  });
  server.post(prefix, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const idFromBody = options.inputIdKey ? body[options.inputIdKey] : body.id;
    const record = createRecord(collection, {
      ...body,
      ...(typeof idFromBody === "string" ? { id: idFromBody } : {})
    }, collectionPrefix(prefix));
    const saved = options.onCreate ? options.onCreate(record) : record;
    collection.set(saved.id, saved);
    return reply.status(201).send(saved);
  });
  server.get(`${prefix}/:${idParamName}`, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    return findRecordByParam(collection, request, reply, idParamName);
  });
  server.put(`${prefix}/:${idParamName}`, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    return upsertByParam(collection, request, idParamName, collectionPrefix(prefix));
  });
  server.patch(`${prefix}/:${idParamName}`, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    return upsertByParam(collection, request, idParamName, collectionPrefix(prefix));
  });
  server.delete(`${prefix}/:${idParamName}`, async (request, reply) => {
    if (options.authorize && !options.authorize(request, reply)) {
      return reply;
    }

    return deleteByParam(collection, request, idParamName);
  });
}

async function sessionDetail(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { sessionId } = request.params as { readonly sessionId: string };

  if (!options.historyStore) {
    return reply.status(404).send({
      code: "RUN_HISTORY_UNAVAILABLE",
      message: "Run history store is not configured"
    });
  }

  const run = await options.historyStore.findRun(sessionId);

  if (!run) {
    return reply.status(404).send({
      code: "SESSION_NOT_FOUND",
      message: `Session not found: ${sessionId}`
    });
  }

  const [messages, toolCalls] = await Promise.all([
    options.historyStore.listMessages(sessionId),
    options.historyStore.listToolCalls(sessionId)
  ]);
  return { messages, run, session: run, toolCalls };
}

function requireAuthService(options: ReactorCompatibilityRouteOptions, reply: FastifyReply): AuthService | undefined {
  if (!options.authService) {
    reply.status(404).send({
      code: "AUTH_UNAVAILABLE",
      message: "Auth service is not configured"
    });
    return undefined;
  }

  return options.authService;
}

function requirePendingApprovalStore(
  options: ReactorCompatibilityRouteOptions,
  reply: FastifyReply
): PendingApprovalStore | undefined {
  if (!options.pendingApprovalStore) {
    reply.status(404).send({
      code: "APPROVAL_STORE_UNAVAILABLE",
      message: "Pending approval store is not configured"
    });
    return undefined;
  }

  return options.pendingApprovalStore;
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

function parseAgentSpecInput(value: unknown, id?: string): ParseResult<AgentSpecInput> {
  if (!isRecord(value)) {
    return invalid("INVALID_AGENT_SPEC", "Body must be an object");
  }

  const name = readBodyString(value, "name") ?? id;

  if (!name) {
    return invalid("INVALID_AGENT_SPEC", "Body must include a non-empty name");
  }

  return {
    ok: true,
    value: {
      description: readBodyString(value, "description"),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      id,
      independentExecution: typeof value.independentExecution === "boolean" ? value.independentExecution : undefined,
      keywords: readStringArray(value.keywords),
      mode: parseAgentMode(value.mode),
      name,
      systemPrompt: readBodyNullableString(value, "systemPrompt"),
      toolNames: readStringArray(value.toolNames)
    }
  };
}

async function findAgentSpec(registry: AgentSpecRegistry, id: string) {
  return (await registry.getById(id)) ?? (await registry.getByName(id));
}

async function findAgentSpecOrReply(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  if (!options.authorizeAdmin(request, reply)) {
    return undefined;
  }

  const { id } = request.params as { readonly id: string };
  const spec = await findAgentSpec(options.agentSpecRegistry, id);

  if (!spec) {
    reply.status(404).send({
      code: "AGENT_SPEC_NOT_FOUND",
      message: `Agent spec not found: ${id}`
    });
    return undefined;
  }

  return {
    id: spec.id,
    name: spec.name,
    systemPrompt: spec.systemPrompt ?? null
  };
}

function createRecord(collection: CompatCollection, input: JsonObject, prefix: string): CompatRecord {
  const id = typeof input.id === "string" && input.id.length > 0 ? input.id : createRunId(prefix);
  const existing = collection.get(id);
  const record: CompatRecord = {
    ...input,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : nowIso(),
    id,
    updatedAt: nowIso()
  };

  collection.set(id, record);
  return record;
}

function findCompatRecord(collection: CompatCollection, id: string): CompatRecord | undefined {
  return collection.get(id) ?? [...collection.values()].find((record) => record.name === id || record.channelId === id);
}

function findRecordByParam(
  collection: CompatCollection,
  request: FastifyRequest,
  reply: FastifyReply,
  paramName: string
) {
  const id = (request.params as Record<string, string>)[paramName];
  const record = id ? findCompatRecord(collection, id) : undefined;
  return record ?? notFound(reply, "COMPAT_RECORD_NOT_FOUND");
}

function upsertByParam(
  collection: CompatCollection,
  request: FastifyRequest,
  paramName: string,
  prefix: string
): CompatRecord {
  const id = (request.params as Record<string, string>)[paramName] ?? createRunId(prefix);
  const existing = findCompatRecord(collection, id);
  return createRecord(collection, {
    ...existing,
    ...toJsonObject(request.body),
    id
  }, prefix);
}

function deleteByParam(collection: CompatCollection, request: FastifyRequest, paramName = "id") {
  const id = (request.params as Record<string, string>)[paramName];
  return { deleted: id ? collection.delete(id) : false, id };
}

function appendNestedVersion(collection: CompatCollection, id: string, body: unknown): CompatRecord | { error: string } {
  const existing = findCompatRecord(collection, id);

  if (!existing) {
    return { error: "not_found" };
  }

  const versions = Array.isArray(existing.versions) ? existing.versions : [];
  const version = createRecord(new Map(), toJsonObject(body), "prompt_version");
  const updated = createRecord(collection, {
    ...existing,
    versions: [...versions, version]
  }, "prompt_template");
  return updated;
}

function setNestedVersionState(collection: CompatCollection, request: FastifyRequest, status: string) {
  const { templateId, versionId } = request.params as { readonly templateId: string; readonly versionId: string };
  const existing = findCompatRecord(collection, templateId);

  if (!existing) {
    return { error: "not_found", templateId, versionId };
  }

  return { status, templateId, versionId };
}

function updateCandidate(request: FastifyRequest, status: string) {
  const { id } = request.params as { readonly id: string };
  return createRecord(state.ragCandidates, { id, status }, "rag_candidate");
}

function promptExperimentAction(request: FastifyRequest, reply: FastifyReply, status: string) {
  const { id } = request.params as { readonly id: string };
  const existing = findCompatRecord(state.promptExperiments, id);

  if (!existing) {
    return notFound(reply, "PROMPT_EXPERIMENT_NOT_FOUND");
  }

  return createRecord(state.promptExperiments, {
    ...existing,
    lastRunAt: nowIso(),
    results: [],
    status
  }, "prompt_experiment");
}

function sourceAction(request: FastifyRequest, status: string) {
  const { sourceName } = request.params as { readonly sourceName: string };
  return createRecord(state.swaggerSources, { id: sourceName, status }, "swagger_source");
}

function slackFaqAction(request: FastifyRequest, status: string) {
  const { channelId } = request.params as { readonly channelId: string };
  return createRecord(state.slackFaq, { channelId, id: channelId, status }, "slack_faq");
}

async function updateTenantStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  status: "active" | "suspended"
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  const { id } = request.params as { readonly id: string };
  const tenants = await (options.admin?.operations?.listTenants() ?? []);
  const tenant = tenants.find((item) => item.id === id);

  if (!tenant) {
    return notFound(reply, "TENANT_NOT_FOUND");
  }

  return options.admin?.operations?.upsertTenant({
    id,
    monthlyBudgetUsd: tenant.monthlyBudgetUsd,
    name: tenant.name,
    status
  });
}

async function tenantSummary(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  const [tenants, alerts, slos, cost] = await Promise.all([
    options.admin?.operations?.listTenants() ?? [],
    options.admin?.operations?.listAlerts() ?? [],
    options.admin?.operations?.listSlos() ?? [],
    options.admin?.operations?.costSummary() ?? { byModel: {}, byTenant: {}, totalCostUsd: "0.00000000" }
  ]);

  return { alerts, cost, slos, tenants };
}

async function dashboardSummary(options: ReactorCompatibilityRouteOptions) {
  const [settings, scheduledJobs] = await Promise.all([
    options.runtimeSettings.list(),
    options.scheduler?.store.list() ?? []
  ]);

  return {
    cache: options.admin?.cache?.metrics?.snapshot() ?? null,
    metrics: options.admin?.observability?.metrics?.recordedEvents() ?? [],
    runtimeSettingCount: settings.length,
    schedulerJobCount: scheduledJobs.length,
    spans: options.admin?.observability?.tracer?.recordedSpans() ?? []
  };
}

async function adminDiagnostic(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  return {
    checks: [
      { name: "runtimeSettings", status: "ok" },
      { name: "scheduler", status: options.scheduler?.service ? "ok" : "not_configured" },
      { name: "modelProvider", status: options.modelProvider ? "ok" : "not_configured" }
    ],
    status: "ok"
  };
}

function simulateGuard(value: unknown) {
  const text = readBodyString(value, "text") ?? readBodyString(value, "message") ?? "";
  const findings = [
    ...(/ignore|disregard|system prompt|developer mode/i.test(text) ? [{ name: "prompt_injection", count: 1 }] : []),
    ...(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) ? [{ name: "email", count: 1 }] : [])
  ];

  return {
    allowed: findings.length === 0,
    findings,
    text
  };
}

function feedbackStats() {
  const items = [...state.feedback.values()];
  const reviewed = items.filter((item) => item.reviewed === true).length;
  return {
    reviewed,
    total: items.length,
    unreviewed: items.length - reviewed
  };
}

function getUserMemory(userId: string) {
  const existing = state.userMemory.get(userId);

  if (existing) {
    return { userId, ...existing };
  }

  const created = { facts: {}, preferences: {}, updatedAt: nowIso() };
  state.userMemory.set(userId, created);
  return { userId, ...created };
}

function updateUserMemory(request: FastifyRequest, key: "facts" | "preferences") {
  const { userId } = request.params as { readonly userId: string };
  const existing = getUserMemory(userId);
  const updated = {
    facts: key === "facts" ? toJsonObject(request.body) : existing.facts,
    preferences: key === "preferences" ? toJsonObject(request.body) : existing.preferences,
    updatedAt: nowIso()
  };
  state.userMemory.set(userId, updated);
  return { userId, ...updated };
}

async function listModelSummaries(options: ReactorCompatibilityRouteOptions) {
  const models = await options.modelProvider?.listModels();

  if (models && models.length > 0) {
    return models.map((model) => ({ id: model, model }));
  }

  return options.defaultModel ? [{ id: options.defaultModel, model: options.defaultModel }] : [];
}

function notFound(reply: FastifyReply, code: string) {
  return reply.status(404).send({
    code,
    message: "Compatibility record was not found"
  });
}

function toLoginResponse(login: LoginResult) {
  return {
    expiresAt: login.expiresAt.toISOString(),
    token: login.token,
    user: login.user
  };
}

function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  return value === "string" || value === "number" || value === "boolean" || value === "json"
    ? value
    : undefined;
}

function parseAgentMode(value: unknown): AgentSpecInput["mode"] | undefined {
  return value === "standard" || value === "plan_execute" || value === "react" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function readQueryString(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readQueryInteger(request: FastifyRequest, key: string, fallback: number): number {
  const raw = readQueryString(request, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readAuthUserId(request: FastifyRequest): string | undefined {
  return (request as { auth?: { userId?: string } }).auth?.userId;
}

function isAdminLikeRequest(request: FastifyRequest): boolean {
  const role = (request as { auth?: { role?: string } }).auth?.role;
  return role === undefined || role === "admin" || role === "admin_manager" || role === "admin_developer";
}

function readBodyString(value: unknown, key: string): string | undefined {
  const body = toBody(value);
  const item = body[key];
  return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

function readBodyNullableString(value: unknown, key: string): string | null | undefined {
  const item = toBody(value)[key];
  return item === null || typeof item === "string" ? item : undefined;
}

function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(([, item]) => isJsonValue(item))) as JsonObject;
}

function toBody(value: unknown): CompatBody {
  return isRecord(value) ? value : {};
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
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

function collectionPrefix(prefix: string): string {
  return prefix.split("/").filter(Boolean).at(-1)?.replace(/-/g, "_") ?? "compat";
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

interface ApiError {
  readonly code: string;
  readonly message: string;
}
