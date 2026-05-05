import type { AgentSpecInput, AgentSpecRegistry } from "@muse/agent-specs";
import { AuthRateLimiter, AuthService, extractBearerToken, type LoginResult } from "@muse/auth";
import type { ModelProvider } from "@muse/model";
import type { RuntimeSettingsService, RuntimeSettingType } from "@muse/runtime-settings";
import type { AgentRunHistoryStore, AgentRunRecord, PendingApprovalStore, ToolCallRecord } from "@muse/runtime-state";
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
  readonly agentEvalCases: CompatCollection;
  readonly agentEvalResults: CompatCollection;
  readonly agentEvalRunLogs: CompatCollection;
  readonly documents: CompatCollection;
  readonly feedback: CompatCollection;
  readonly inputGuardRules: CompatCollection;
  readonly intents: CompatCollection;
  readonly outputGuardRules: CompatCollection;
  readonly personas: CompatCollection;
  readonly platformAlertRules: CompatCollection;
  readonly platformPricing: CompatCollection;
  readonly metricEvents: CompatCollection;
  readonly promptExperiments: CompatCollection;
  readonly promptTemplates: CompatCollection;
  readonly ragCandidates: CompatCollection;
  readonly sessionTags: Map<string, CompatRecord[]>;
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
    agentEvalCases: new Map(),
    agentEvalResults: new Map(),
    agentEvalRunLogs: new Map(),
    documents: new Map(),
    feedback: new Map(),
    inputGuardRules: new Map(),
    intents: new Map(),
    outputGuardRules: new Map(),
    personas: new Map(),
    platformAlertRules: new Map(),
    platformPricing: new Map(),
    metricEvents: new Map(),
    promptExperiments: new Map(),
    promptTemplates: new Map(),
    ragCandidates: new Map(),
    sessionTags: new Map(),
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

  server.post("/api/auth/change-password", async (request, reply) => {
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

    const currentPassword = readBodyString(request.body, "currentPassword");
    const newPassword = readBodyString(request.body, "newPassword");

    if (!currentPassword || !newPassword) {
      return reply.status(400).send({
        code: "INVALID_PASSWORD_CHANGE_REQUEST",
        message: "Body must include currentPassword and newPassword"
      });
    }

    const result = authService.changePassword({
      currentPassword,
      newPassword,
      userId: identity.userId
    });

    if (result === "changed") {
      return { message: "Password changed successfully" };
    }

    if (result === "user_not_found") {
      return reply.status(404).send({ code: "USER_NOT_FOUND", message: "User not found" });
    }

    return reply.status(400).send({
      code: result === "unsupported" ? "PASSWORD_CHANGE_UNSUPPORTED" : "CURRENT_PASSWORD_INCORRECT",
      message: result === "unsupported"
        ? "Password change is not supported by the configured auth provider"
        : "Current password is incorrect"
    });
  });
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
  server.get("/api/sessions/:sessionId/export", async (request, reply) => exportSession(request, reply, options));
  server.delete("/api/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { readonly sessionId: string };

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const deleted = await options.historyStore.deleteRun(sessionId);
    return deleted
      ? reply.status(204).send()
      : reply.status(404).send({ code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` });
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
  server.post("/api/admin/rag/seed-policy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toBody(request.body);
    const entries = Array.isArray(body.entries) ? body.entries.filter(isRecord).slice(0, 50) : [];
    const startedAt = Date.now();
    const keys: string[] = [];
    let chunkCount = 0;

    for (const entry of entries) {
      const key = readBodyString(entry, "key");
      const title = readBodyString(entry, "title");
      const content = readBodyString(entry, "content");

      if (!key || !title || !content) {
        continue;
      }

      keys.push(key);
      const chunks = chunkText(content);
      chunkCount += chunks.length;

      for (const [index, chunk] of chunks.entries()) {
        createRecord(state.documents, {
          category: readBodyNullableString(entry, "category") ?? null,
          content: chunk,
          id: `policy-seed:${key}:${index}`,
          key,
          source: "policy-seed",
          spaceKey: readBodyNullableString(entry, "spaceKey") ?? null,
          title,
          url: readBodyNullableString(entry, "url") ?? null
        }, "document");
      }
    }

    return {
      chunkCount,
      documentCount: keys.length,
      durationMs: Date.now() - startedAt,
      keys
    };
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
  server.get("/api/admin/platform/pricing", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [...state.platformPricing.values()].sort((left, right) =>
      String(right.effectiveFrom ?? right.createdAt).localeCompare(String(left.effectiveFrom ?? left.createdAt))
    );
  });
  server.post("/api/admin/platform/pricing", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const provider = readBodyString(body, "provider");
    const model = readBodyString(body, "model");

    if (!provider || !model) {
      return reply.status(400).send({
        code: "INVALID_MODEL_PRICING",
        message: "Body must include provider and model"
      });
    }

    const id = readBodyString(body, "id") ?? `${provider}:${model}`;
    const saved = createRecord(state.platformPricing, {
      batchCompletionPricePer1k: numberOrString(body.batchCompletionPricePer1k, 0),
      batchPromptPricePer1k: numberOrString(body.batchPromptPricePer1k, 0),
      cachedInputPricePer1k: numberOrString(body.cachedInputPricePer1k, 0),
      completionPricePer1k: numberOrString(body.completionPricePer1k, 0),
      effectiveFrom: readBodyString(body, "effectiveFrom") ?? nowIso(),
      effectiveTo: readBodyNullableString(body, "effectiveTo") ?? null,
      id,
      model,
      promptPricePer1k: numberOrString(body.promptPricePer1k, 0),
      provider,
      reasoningPricePer1k: numberOrString(body.reasoningPricePer1k, 0)
    }, "model_pricing");
    return saved;
  });
  server.get("/api/admin/platform/vectorstore/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return {
      available: state.documents.size > 0,
      documentCount: state.documents.size,
      indexedDocuments: [...state.documents.values()].filter((document) => document.deleted !== true).length
    };
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
  server.get("/api/admin/platform/alerts/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return [...state.platformAlertRules.values()];
  });
  server.post("/api/admin/platform/alerts/rules", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const name = readBodyString(body, "name");
    const metric = readBodyString(body, "metric");

    if (!name || !metric) {
      return reply.status(400).send({
        code: "INVALID_ALERT_RULE",
        message: "Body must include name and metric"
      });
    }

    return createRecord(state.platformAlertRules, {
      createdAt: readBodyString(body, "createdAt") ?? nowIso(),
      description: readBodyString(body, "description") ?? "",
      enabled: readBoolean(body.enabled, true),
      id: readBodyString(body, "id") ?? createRunId("alert_rule"),
      metric,
      name,
      platformOnly: readBoolean(body.platformOnly, false),
      severity: readBodyString(body, "severity") ?? "WARNING",
      tenantId: readBodyNullableString(body, "tenantId") ?? null,
      threshold: readNumber(body.threshold, 0),
      type: readBodyString(body, "type") ?? "STATIC_THRESHOLD",
      windowMinutes: readNumber(body.windowMinutes, 15)
    }, "alert_rule");
  });
  server.delete("/api/admin/platform/alerts/rules/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    return state.platformAlertRules.delete(id) ? reply.status(204).send() : notFound(reply, "ALERT_RULE_NOT_FOUND");
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

  server.get("/api/admin/sessions/overview", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const runs = await listAllRuns(options);
    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter((run) => run.status === "failed").length;
    return {
      completed,
      failed,
      running: runs.filter((run) => run.status === "running").length,
      total: runs.length
    };
  });
  server.get("/api/admin/sessions", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const offset = readQueryInteger(request, "offset", 0);
    const limit = readQueryInteger(request, "limit", 30);
    const runs = await listAllRuns(options, { limit, offset });
    return {
      items: runs,
      limit: Math.max(0, limit),
      offset: Math.max(0, offset),
      total: (await listAllRuns(options)).length
    };
  });
  server.get("/api/admin/sessions/:sessionId/export", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return exportSession(request, reply, options);
  });
  server.post("/api/admin/sessions/:sessionId/tags", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { sessionId } = request.params as { readonly sessionId: string };
    const label = readBodyString(request.body, "label");

    if (!label) {
      return reply.status(400).send({ code: "INVALID_SESSION_TAG", message: "Body must include label" });
    }

    const tag = createRecord(new Map(), {
      comment: readBodyNullableString(request.body, "comment") ?? null,
      label,
      sessionId
    }, "session_tag");
    const tags = state.sessionTags.get(sessionId) ?? [];
    state.sessionTags.set(sessionId, [...tags, tag]);
    return tag;
  });
  server.delete("/api/admin/sessions/:sessionId/tags/:tagId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { sessionId, tagId } = request.params as { readonly sessionId: string; readonly tagId: string };
    const tags = state.sessionTags.get(sessionId) ?? [];
    const remaining = tags.filter((tag) => tag.id !== tagId);

    if (remaining.length === tags.length) {
      return notFound(reply, "SESSION_TAG_NOT_FOUND");
    }

    state.sessionTags.set(sessionId, remaining);
    return reply.status(204).send();
  });
  server.get("/api/admin/sessions/:sessionId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const detail = await sessionDetail(request, reply, options);
    const { sessionId } = request.params as { readonly sessionId: string };
    return isRecord(detail) && "run" in detail ? { ...detail, tags: state.sessionTags.get(sessionId) ?? [] } : detail;
  });
  server.delete("/api/admin/sessions/:sessionId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { sessionId } = request.params as { readonly sessionId: string };

    if (!options.historyStore) {
      return reply.status(404).send({
        code: "RUN_HISTORY_UNAVAILABLE",
        message: "Run history store is not configured"
      });
    }

    const deleted = await options.historyStore.deleteRun(sessionId);
    state.sessionTags.delete(sessionId);
    return deleted
      ? reply.status(204).send()
      : reply.status(404).send({ code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` });
  });
  server.get("/api/admin/users", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return summarizeUsers(await listAllRuns(options));
  });
  server.get("/api/admin/users/:userId/sessions", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { userId } = request.params as { readonly userId: string };
    return options.historyStore?.listRunsByUser(userId) ?? [];
  });
  server.get("/admin/doctor", async (request, reply) => adminDiagnostic(request, reply, options));
  server.get("/api/admin/traces", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return options.admin?.observability?.tracer?.recordedSpans() ?? [];
  });
  server.get("/api/admin/traces/:traceId/spans", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { traceId } = request.params as { readonly traceId: string };
    return (options.admin?.observability?.tracer?.recordedSpans() ?? [])
      .filter((span) =>
        isRecord(span) &&
        (span.id === traceId || (isRecord(span.attributes) && span.attributes.runId === traceId))
      );
  });
  server.get("/api/admin/tool-calls", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const runId = readQueryString(request, "runId");
    return runId && options.historyStore
      ? options.historyStore.listToolCalls(runId)
      : listAllToolCalls(options);
  });
  server.get("/api/admin/tool-calls/ranking", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return toolCallRanking(await listAllToolCalls(options));
  });
  server.get("/api/admin/users/usage/top", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return summarizeUsers(await listAllRuns(options));
  });
  server.get("/api/admin/users/usage/cost", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return usageByUser(await listAllRuns(options));
  });
  server.get("/api/admin/users/usage/daily", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return dailyUsage(await listAllRuns(options));
  });
  server.get("/api/admin/users/usage/by-model", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return usageByModel(await listAllRuns(options));
  });
  server.get("/api/admin/token-cost/by-session", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return (await listAllRuns(options)).map((run) => ({
      costUsd: run.costUsd,
      model: run.model,
      runId: run.id,
      tokenUsage: run.tokenUsage,
      userId: run.userId ?? "anonymous"
    }));
  });
  server.get("/api/admin/token-cost/daily", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return dailyUsage(await listAllRuns(options));
  });
  server.get("/api/admin/token-cost/top-expensive", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const runs = await listAllRuns(options);
    return [...runs]
      .sort((left, right) => Number(right.costUsd) - Number(left.costUsd))
      .slice(0, 20);
  });
  server.get("/api/admin/conversation-analytics/by-channel", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return groupRunsByMetadata(await listAllRuns(options), "channel");
  });
  server.get("/api/admin/conversation-analytics/failure-patterns", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return (await listAllRuns(options))
      .filter((run) => run.status === "failed")
      .map((run) => ({ error: run.error ?? "unknown", runId: run.id }));
  });
  server.get("/api/admin/conversation-analytics/latency-distribution", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return latencyDistribution(await listAllRuns(options));
  });
  registerAdminAnalyticsCompatibilityRoutes(server, options);
  registerAgentEvalCompatibilityRoutes(server, options);
  registerMetricIngestionRoutes(server, options);

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

function registerAdminAnalyticsCompatibilityRoutes(
  server: FastifyInstance,
  options: ReactorCompatibilityRouteOptions
): void {
  server.get("/api/admin/audits", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = Math.max(1, readQueryInteger(request, "limit", 1000));
    const offset = Math.max(0, readQueryInteger(request, "offset", 0));
    const items = [...state.metricEvents.values()].slice(offset, offset + limit);
    return {
      items,
      limit,
      offset,
      total: state.metricEvents.size
    };
  });

  server.get("/api/admin/audits/export", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const rows = [...state.metricEvents.values()];
    reply.header("content-type", "text/csv; charset=utf-8");
    return csvRows(
      ["id", "timestamp", "category", "action", "actor", "resource_type", "resource_id", "detail"],
      rows.map((row) => [
        row.id,
        row.createdAt,
        "compat_metric",
        String(row.kind ?? "ingest"),
        "admin",
        "metric_event",
        row.id,
        JSON.stringify(row.payload ?? {})
      ])
    );
  });

  server.get("/api/admin/debug/replay", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = Math.max(1, readQueryInteger(request, "limit", 50));
    return (await listAllRuns(options))
      .filter((run) => run.status === "failed")
      .slice(0, limit)
      .map(debugReplayResponse);
  });

  server.get("/api/admin/debug/replay/:id", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const run = await options.historyStore?.findRun(id);
    return run && run.status === "failed" ? debugReplayResponse(run) : notFound(reply, "DEBUG_REPLAY_NOT_FOUND");
  });

  server.get("/api/admin/evals/runs", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = Math.max(1, readQueryInteger(request, "limit", 100));
    return [...state.agentEvalResults.values()].slice(0, limit);
  });

  server.get("/api/admin/evals/pass-rate", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return passRateByDay([...state.agentEvalResults.values()]);
  });

  server.get("/api/admin/followup-suggestions/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const hours = Math.min(168, Math.max(1, readQueryInteger(request, "hours", 24)));
    return {
      byCategory: {},
      ctr: 0,
      totalClicks: 0,
      totalImpressions: 0,
      windowHours: hours
    };
  });

  server.get("/api/admin/input-guard/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const hours = Math.max(1, readQueryInteger(request, "hours", 24));
    return {
      blockRate: 0,
      byReason: {},
      byStage: [...state.inputGuardRules.values()].map((rule) => ({
        allowed: 0,
        rejected: 0,
        stageName: String(rule.name ?? rule.id),
        triggered: 0
      })),
      hours,
      total: 0
    };
  });

  server.get("/api/admin/metrics/latency/summary", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return latencySummary(await listAllRuns(options), readQueryInteger(request, "days", 7));
  });

  server.get("/api/admin/metrics/latency/timeseries", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return latencyTimeseries(await listAllRuns(options), readQueryInteger(request, "days", 7));
  });

  server.get("/api/admin/rag-analytics/status", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return ragStatusSummary();
  });

  server.get("/api/admin/rag-analytics/by-channel", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return groupRecordsByField([...state.ragCandidates.values(), ...state.documents.values()], "channelId", "api");
  });

  server.get("/api/admin/slack-activity/channels", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return groupRunsByMetadata(await listAllRuns(options), "channel");
  });

  server.get("/api/admin/slack-activity/daily", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return dailyUsage(await listAllRuns(options));
  });

  server.get("/api/admin/tenant/quality", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const runs = await listAllRuns(options);
    return {
      errors: runs.filter((run) => run.status === "failed").length,
      latencyDistribution: latencyDistribution(runs),
      total: runs.length
    };
  });

  server.get("/api/admin/tenant/tools", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const toolCalls = await listAllToolCalls(options);
    return {
      ranking: toolCallRanking(toolCalls),
      total: toolCalls.length
    };
  });

  server.get("/api/admin/tenant/quota", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const runs = await listAllRuns(options);
    return {
      quota: { maxRequestsPerMonth: 0, maxTokensPerMonth: 0 },
      requestUsagePercent: 0,
      tokenUsagePercent: 0,
      usage: {
        requests: runs.length,
        tokens: runs.reduce((total, run) => total + numberField(run.tokenUsage, "inputTokens") +
          numberField(run.tokenUsage, "outputTokens"), 0)
      }
    };
  });

  server.get("/api/admin/tenant/export/executions", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    reply.header("content-type", "text/csv; charset=utf-8");
    return runsCsv(await listAllRuns(options));
  });

  server.get("/api/admin/tenant/export/tools", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    reply.header("content-type", "text/csv; charset=utf-8");
    return toolCallsCsv(await listAllToolCalls(options));
  });

  server.get("/api/admin/platform/tenants/analytics", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const [tenants, cost] = await Promise.all([
      options.admin?.operations?.listTenants() ?? [],
      options.admin?.operations?.costSummary() ?? { byModel: {}, byTenant: {}, totalCostUsd: "0.00000000" }
    ]);
    return tenants.map((tenant) => ({
      cost: toJsonObject(cost.byTenant)[tenant.id] ?? "0.00000000",
      plan: "default",
      quotaUsagePercent: 0,
      requests: 0,
      tenantId: tenant.id,
      tenantName: tenant.name
    }));
  });

  server.get("/api/admin/platform/users/by-email", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const email = readQueryString(request, "email");
    const auth = (request as { auth?: { email?: string; role?: string; userId?: string } }).auth;

    if (!email) {
      return reply.status(400).send({ code: "INVALID_EMAIL", message: "email is required" });
    }

    return auth?.email === email
      ? { email, id: auth.userId ?? "current-user", role: auth.role ?? "admin" }
      : notFound(reply, "USER_NOT_FOUND");
  });

  server.post("/api/admin/platform/users/:id/role", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const role = readBodyString(request.body, "role");

    if (!role) {
      return reply.status(400).send({ code: "INVALID_ROLE", message: "Body must include role" });
    }

    return { id, role, updated: true };
  });

  server.post("/api/admin/task-memory/maintenance/purge-expired", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return { actor: readAuthUserId(request) ?? "admin", deleted: 0 };
  });

  server.post("/api/admin/task-memory/maintenance/purge-terminal", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const olderThanDays = readQueryInteger(request, "olderThanDays", 30);

    if (olderThanDays < 1) {
      return reply.status(400).send({ code: "INVALID_RETENTION_WINDOW", message: "olderThanDays must be >= 1" });
    }

    return { cutoff: new Date(Date.now() - olderThanDays * 86_400_000).toISOString(), deleted: 0 };
  });
}

function registerAgentEvalCompatibilityRoutes(
  server: FastifyInstance,
  options: ReactorCompatibilityRouteOptions
): void {
  server.get("/api/admin/agent-eval/cases", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const enabledOnly = readQueryBoolean(request, "enabledOnly", true);
    const tags = readQueryStringSet(request, "tags");
    const limit = Math.max(0, readQueryInteger(request, "limit", 100));
    return [...state.agentEvalCases.values()]
      .filter((item) => !enabledOnly || item.enabled !== false)
      .filter((item) => tags.size === 0 || readStringSet(item.tags).some((tag) => tags.has(tag)))
      .slice(0, limit)
      .map(toEvalCaseResponse);
  });

  server.get("/api/admin/agent-eval/run-logs", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const limit = Math.max(0, readQueryInteger(request, "limit", 50));
    const runs = await listAllRuns(options, { limit });
    const logsByRunId = new Map<string, JsonObject>();

    for (const log of state.agentEvalRunLogs.values()) {
      const response = toEvalRunLogResponse(log);
      logsByRunId.set(String(response.runId), response);
    }

    for (const run of runs) {
      logsByRunId.set(run.id, await runLogResponse(run, options));
    }

    return [...logsByRunId.values()].slice(0, limit);
  });

  server.post("/api/admin/agent-eval/cases/promote", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const body = toJsonObject(request.body);
    const runId = readBodyString(body, "runId") ?? readBodyString(body, "sourceRunId");

    if (!runId) {
      return reply.status(400).send({
        code: "INVALID_AGENT_EVAL_PROMOTION",
        message: "Body must include runId"
      });
    }

    const behaviorAssertionCount = countBehaviorAssertions(body);

    if (behaviorAssertionCount === 0) {
      return reply.status(400).send({
        code: "INVALID_AGENT_EVAL_PROMOTION",
        message: "Promotion requires at least one deterministic assertion"
      });
    }

    const run = await options.historyStore?.findRun(runId);

    if (!run) {
      return notFound(reply, "AGENT_RUN_LOG_NOT_FOUND");
    }

    const toolCalls = await (options.historyStore?.listToolCalls(runId) ?? []);
    const toolNames = [...new Set(toolCalls.map((toolCall) => toolCall.name))];
    const id = readBodyString(body, "id") ?? createRunId("eval_case");
    const record = createRecord(state.agentEvalCases, {
      agentType: run.mode,
      assertionCount: countEvalAssertions({ ...body, agentType: run.mode, model: run.model }),
      enabled: readBoolean(body.enabled, true),
      expectedAnswerContains: readStringSet(body.expectedAnswerContains),
      expectedExposedToolNames: readStringSet(body.expectedExposedToolNames),
      expectedToolNames: readStringSet(body.expectedToolNames),
      forbiddenAnswerContains: readStringSet(body.forbiddenAnswerContains),
      forbiddenExposedToolNames: readStringSet(body.forbiddenExposedToolNames),
      forbiddenToolNames: readStringSet(body.forbiddenToolNames),
      id,
      maxToolExposureCount: readNullableNumber(body.maxToolExposureCount) ?? null,
      minScore: readNumber(body.minScore, 1),
      model: run.model,
      name: readBodyString(body, "name") ?? `Promoted run ${run.id}`,
      sourceRunId: run.id,
      tags: readStringSet(body.tags),
      toolExposureNames: toolNames,
      userInput: run.input
    }, "eval_case");
    state.agentEvalRunLogs.set(run.id, await runLogRecord(run, options));
    return toEvalCaseResponse(record);
  });

  server.post("/api/admin/agent-eval/cases/:id/replay", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { id } = request.params as { readonly id: string };
    const existing = findCompatRecord(state.agentEvalCases, id);

    if (!existing) {
      return notFound(reply, "AGENT_EVAL_CASE_NOT_FOUND");
    }

    const sourceRunId = typeof existing.sourceRunId === "string" ? existing.sourceRunId : undefined;
    const run = sourceRunId ? await options.historyStore?.findRun(sourceRunId) : undefined;

    if (!run) {
      return notFound(reply, "AGENT_RUN_LOG_NOT_FOUND");
    }

    const result = await evaluateRunAgainstCase(existing, run, options);
    const stored = storeEvalResult(result, readQueryBoolean(request, "llmJudge", false));
    return {
      caseId: id,
      deterministic: result,
      storedResults: stored
    };
  });

  server.post("/api/admin/agent-eval/cases/:caseId/evaluate-run/:runId", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const { caseId, runId } = request.params as { readonly caseId: string; readonly runId: string };
    const existing = findCompatRecord(state.agentEvalCases, caseId);

    if (!existing) {
      return notFound(reply, "AGENT_EVAL_CASE_NOT_FOUND");
    }

    const run = await options.historyStore?.findRun(runId);

    if (!run) {
      return notFound(reply, "AGENT_RUN_LOG_NOT_FOUND");
    }

    const result = await evaluateRunAgainstCase(existing, run, options);
    const stored = storeEvalResult(result, readQueryBoolean(request, "llmJudge", false));
    return {
      caseId,
      deterministic: result,
      storedResults: stored
    };
  });

  server.get("/api/admin/agent-eval/results", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const caseId = readQueryString(request, "caseId");
    const tier = readQueryString(request, "tier");
    const limit = Math.max(0, readQueryInteger(request, "limit", 100));
    return [...state.agentEvalResults.values()]
      .filter((result) => !caseId || result.caseId === caseId)
      .filter((result) => !tier || result.tier === tier)
      .slice(0, limit);
  });

  server.get("/api/admin/tools/stats", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    return toolOutcomeStats(await listAllToolCalls(options), readQueryString(request, "server"));
  });

  server.get("/api/admin/tools/accuracy", async (request, reply) => {
    if (!options.authorizeAdmin(request, reply)) {
      return reply;
    }

    const stats = toolOutcomeStats(await listAllToolCalls(options));
    const total = Number(stats.total);
    return {
      accuracy: stats.accuracy,
      invalidCallRate: 0,
      ok: Number(toJsonObject(stats.byOutcome).ok ?? 0),
      notFoundRate: 0,
      timeoutRate: 0,
      total
    };
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

async function exportSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const detail = await sessionDetail(request, reply, options);

  if (!isRecord(detail) || !("messages" in detail)) {
    return detail;
  }

  if (readQueryString(request, "format") === "markdown") {
    const sessionId = (request.params as { readonly sessionId: string }).sessionId;
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    return [
      `# Session: ${sessionId}`,
      "",
      `Exported at: ${nowIso()}`,
      "",
      ...messages.flatMap((message) => {
        if (!isRecord(message)) {
          return [];
        }

        return [`## ${String(message.role ?? "message")}`, "", String(message.content ?? ""), ""];
      })
    ].join("\n");
  }

  return {
    exportedAt: nowIso(),
    ...detail
  };
}

async function listAllRuns(
  options: ReactorCompatibilityRouteOptions,
  listOptions: { readonly limit?: number; readonly offset?: number } = {}
): Promise<readonly AgentRunRecord[]> {
  return options.historyStore?.listRuns({
    limit: listOptions.limit === undefined ? undefined : Math.max(0, listOptions.limit),
    offset: listOptions.offset === undefined ? undefined : Math.max(0, listOptions.offset)
  }) ?? [];
}

function summarizeUsers(runs: readonly AgentRunRecord[]) {
  const byUser = new Map<string, { lastActiveAt: string; runCount: number; userId: string }>();

  for (const run of runs) {
    const userId = run.userId ?? "anonymous";
    const existing = byUser.get(userId);
    const updatedAt = run.updatedAt.toISOString();

    byUser.set(userId, {
      lastActiveAt: existing && existing.lastActiveAt > updatedAt ? existing.lastActiveAt : updatedAt,
      runCount: (existing?.runCount ?? 0) + 1,
      userId
    });
  }

  return [...byUser.values()].sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
}

async function listAllToolCalls(options: ReactorCompatibilityRouteOptions): Promise<readonly ToolCallRecord[]> {
  const runs = await listAllRuns(options);
  const toolCalls: ToolCallRecord[] = [];

  for (const run of runs) {
    const calls = await (options.historyStore?.listToolCalls(run.id) ?? []);
    toolCalls.push(...calls.map((call) => ({ ...call, runId: run.id })));
  }

  return toolCalls;
}

async function runLogRecord(
  run: AgentRunRecord,
  options: ReactorCompatibilityRouteOptions
): Promise<CompatRecord> {
  const toolCalls = await (options.historyStore?.listToolCalls(run.id) ?? []);
  const toolExposureNames = [...new Set(toolCalls.map((toolCall) => toolCall.name))];
  return createRecord(state.agentEvalRunLogs, {
    agentType: run.mode,
    costUsd: run.costUsd,
    endedAt: run.completedAt?.toISOString() ?? run.updatedAt.toISOString(),
    errorCount: run.error ? 1 : 0,
    errors: run.error ? [{ message: run.error }] : [],
    evalCaseId: null,
    finalAnswer: run.output ?? "",
    model: run.model,
    retrievedChunkCount: 0,
    retrievedChunks: [],
    id: run.id,
    runId: run.id,
    startedAt: run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
    tokenUsage: run.tokenUsage,
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.map(toEvalToolCall),
    toolExposure: {
      count: toolExposureNames.length,
      names: toolExposureNames
    },
    userInput: run.input
  }, "agent_eval_run_log");
}

async function runLogResponse(run: AgentRunRecord, options: ReactorCompatibilityRouteOptions): Promise<JsonObject> {
  return toEvalRunLogResponse(await runLogRecord(run, options));
}

function toEvalRunLogResponse(log: JsonObject): JsonObject {
  const toolExposure = isRecord(log.toolExposure) ? log.toolExposure : {};
  const toolCalls = Array.isArray(log.toolCalls) ? log.toolCalls : [];
  const retrievedChunks = Array.isArray(log.retrievedChunks) ? log.retrievedChunks : [];
  const errors = Array.isArray(log.errors) ? log.errors : [];
  const finalAnswer = typeof log.finalAnswer === "string" ? log.finalAnswer : "";
  return {
    agentType: typeof log.agentType === "string" ? log.agentType : "standard",
    errorCount: typeof log.errorCount === "number" ? log.errorCount : errors.length,
    evalCaseId: typeof log.evalCaseId === "string" ? log.evalCaseId : null,
    finalAnswerPreview: finalAnswer.slice(0, 240),
    model: typeof log.model === "string" ? log.model : "unknown",
    retrievedChunkCount: typeof log.retrievedChunkCount === "number" ? log.retrievedChunkCount : retrievedChunks.length,
    runId: typeof log.runId === "string" ? log.runId : String(log.id ?? ""),
    toolCallCount: typeof log.toolCallCount === "number" ? log.toolCallCount : toolCalls.length,
    toolExposureCount: typeof toolExposure.count === "number" ? toolExposure.count : 0,
    toolExposureNames: readStringSet(toolExposure.names)
  };
}

function toEvalToolCall(toolCall: ToolCallRecord): JsonObject {
  return {
    arguments: toolCall.arguments,
    errorCode: toolCall.error ?? null,
    latencyMs: toolCall.startedAt && toolCall.completedAt
      ? Math.max(0, toolCall.completedAt.getTime() - toolCall.startedAt.getTime())
      : 0,
    step: 0,
    success: toolCall.status === "completed",
    toolName: toolCall.name
  };
}

function toEvalCaseResponse(record: JsonObject): JsonObject {
  return {
    agentType: typeof record.agentType === "string" ? record.agentType : null,
    assertionCount: readNumber(record.assertionCount, countEvalAssertions(record)),
    enabled: record.enabled !== false,
    id: typeof record.id === "string" ? record.id : "",
    minScore: readNumber(record.minScore, 1),
    model: typeof record.model === "string" ? record.model : null,
    name: typeof record.name === "string" ? record.name : "",
    sourceRunId: typeof record.sourceRunId === "string" ? record.sourceRunId : null,
    tags: readStringSet(record.tags)
  };
}

async function evaluateRunAgainstCase(
  evalCase: JsonObject,
  run: AgentRunRecord,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  const toolCalls = await (options.historyStore?.listToolCalls(run.id) ?? []);
  const toolNames = toolCalls.map((toolCall) => toolCall.name);
  const successfulToolNames = toolCalls
    .filter((toolCall) => toolCall.status === "completed")
    .map((toolCall) => toolCall.name);
  const exposedToolNames = readStringSet(evalCase.toolExposureNames).length > 0
    ? readStringSet(evalCase.toolExposureNames)
    : [...new Set(toolNames)];
  const finalAnswer = run.output ?? "";
  const expectedAnswerContains = readStringSet(evalCase.expectedAnswerContains);
  const forbiddenAnswerContains = readStringSet(evalCase.forbiddenAnswerContains);
  const expectedToolNames = readStringSet(evalCase.expectedToolNames);
  const forbiddenToolNames = readStringSet(evalCase.forbiddenToolNames);
  const expectedExposedToolNames = readStringSet(evalCase.expectedExposedToolNames);
  const forbiddenExposedToolNames = readStringSet(evalCase.forbiddenExposedToolNames);
  const maxToolExposureCount = readNullableNumber(evalCase.maxToolExposureCount);
  const missingExpectedAnswerContains = expectedAnswerContains.filter((needle) =>
    !containsIgnoreCase(finalAnswer, needle)
  );
  const matchedForbiddenAnswerContains = forbiddenAnswerContains.filter((needle) =>
    containsIgnoreCase(finalAnswer, needle)
  );
  const missingExpectedTools = expectedToolNames.filter((name) => !toolNames.includes(name));
  const failedExpectedTools = expectedToolNames.filter((name) =>
    toolNames.includes(name) && !successfulToolNames.includes(name)
  );
  const expectedToolsUsed = expectedToolNames.filter((name) =>
    !missingExpectedTools.includes(name) && !failedExpectedTools.includes(name)
  );
  const forbiddenToolsUsed = forbiddenToolNames.filter((name) => toolNames.includes(name));
  const missingExpectedExposedTools = expectedExposedToolNames.filter((name) => !exposedToolNames.includes(name));
  const expectedToolsExposed = expectedExposedToolNames.filter((name) => !missingExpectedExposedTools.includes(name));
  const forbiddenToolsExposed = forbiddenExposedToolNames.filter((name) => exposedToolNames.includes(name));
  const toolExposureCountExceeded = maxToolExposureCount === undefined ? false : exposedToolNames.length > maxToolExposureCount;
  const reasons = [
    ...missingExpectedAnswerContains.map((item) => `missing expected answer fragment: ${item}`),
    ...matchedForbiddenAnswerContains.map((item) => `forbidden answer fragment present: ${item}`),
    ...missingExpectedTools.map((item) => `expected tool not used: ${item}`),
    ...failedExpectedTools.map((item) => `expected tool failed: ${item}`),
    ...forbiddenToolsUsed.map((item) => `forbidden tool used: ${item}`),
    ...missingExpectedExposedTools.map((item) => `expected exposed tool missing: ${item}`),
    ...forbiddenToolsExposed.map((item) => `forbidden exposed tool present: ${item}`),
    ...(toolExposureCountExceeded ? [
      `tool exposure count exceeded: max=${maxToolExposureCount}, actual=${exposedToolNames.length}`
    ] : []),
    ...(typeof evalCase.agentType === "string" && evalCase.agentType !== run.mode
      ? [`agentType mismatch: expected=${evalCase.agentType}, actual=${run.mode}`]
      : []),
    ...(typeof evalCase.model === "string" && evalCase.model !== run.model
      ? [`model mismatch: expected=${evalCase.model}, actual=${run.model}`]
      : [])
  ];
  const assertionCount = Math.max(1, readNumber(evalCase.assertionCount, countEvalAssertions(evalCase)));
  const score = ((assertionCount - reasons.length) / assertionCount).toFixed(6);
  const numericScore = Math.max(0, Math.min(1, Number(score)));
  return {
    caseId: typeof evalCase.id === "string" ? evalCase.id : "",
    forbiddenToolsExposed,
    forbiddenToolsUsed,
    missingExpectedAnswerContains,
    missingExpectedExposedTools,
    missingExpectedTools,
    passed: numericScore >= readNumber(evalCase.minScore, 1),
    reasons: reasons.length === 0 ? ["all assertions passed"] : reasons,
    runId: run.id,
    score: numericScore,
    toolExposureCountExceeded
  };
}

function storeEvalResult(result: JsonObject, includeLlmJudge: boolean): readonly JsonObject[] {
  const deterministic = createRecord(state.agentEvalResults, {
    caseId: typeof result.caseId === "string" ? result.caseId : "",
    evaluatedAt: nowIso(),
    passed: result.passed === true,
    reasons: readStringSet(result.reasons),
    runId: typeof result.runId === "string" ? result.runId : null,
    score: readNumber(result.score, 0),
    tier: "deterministic"
  }, "agent_eval_result");

  if (!includeLlmJudge) {
    return [deterministic];
  }

  const llmJudge = createRecord(state.agentEvalResults, {
    caseId: typeof deterministic.caseId === "string" ? deterministic.caseId : "",
    evaluatedAt: nowIso(),
    passed: false,
    reasons: ["LLM judge unavailable"],
    runId: typeof deterministic.runId === "string" ? deterministic.runId : null,
    score: 0,
    tier: "llm_judge"
  }, "agent_eval_result");
  return [deterministic, llmJudge];
}

function countEvalAssertions(value: JsonObject): number {
  return countBehaviorAssertions(value) +
    (typeof value.agentType === "string" && value.agentType.length > 0 ? 1 : 0) +
    (typeof value.model === "string" && value.model.length > 0 ? 1 : 0);
}

function countBehaviorAssertions(value: JsonObject): number {
  return readStringSet(value.expectedAnswerContains).length +
    readStringSet(value.forbiddenAnswerContains).length +
    readStringSet(value.expectedToolNames).length +
    readStringSet(value.forbiddenToolNames).length +
    readStringSet(value.expectedExposedToolNames).length +
    readStringSet(value.forbiddenExposedToolNames).length +
    (readNullableNumber(value.maxToolExposureCount) === undefined ? 0 : 1);
}

function toolCallRanking(toolCalls: readonly ToolCallRecord[]) {
  const byName = new Map<string, { failures: number; name: string; total: number }>();

  for (const call of toolCalls) {
    const existing = byName.get(call.name) ?? { failures: 0, name: call.name, total: 0 };
    byName.set(call.name, {
      failures: existing.failures + (call.status === "failed" ? 1 : 0),
      name: call.name,
      total: existing.total + 1
    });
  }

  return [...byName.values()].sort((left, right) => right.total - left.total);
}

function toolOutcomeStats(toolCalls: readonly ToolCallRecord[], server?: string): JsonObject {
  const rows = toolCalls
    .filter((call) => !server || call.name.startsWith(`${server}:`) || call.name.startsWith(`${server}.`))
    .map((call) => ({
      outcome: toolOutcome(call),
      server: call.name.includes(":") ? call.name.split(":")[0] ?? "local" : "local",
      tool: call.name
    }));
  const byOutcome: Record<string, number> = {};
  const byServer: Record<string, number> = {};
  const byTool = new Map<string, { count: number; outcome: string; server: string; tool: string }>();

  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    byServer[row.server] = (byServer[row.server] ?? 0) + 1;
    const key = `${row.server}:${row.tool}:${row.outcome}`;
    const existing = byTool.get(key) ?? { count: 0, outcome: row.outcome, server: row.server, tool: row.tool };
    byTool.set(key, { ...existing, count: existing.count + 1 });
  }

  const total = rows.length;
  const ok = byOutcome.ok ?? 0;
  return {
    accuracy: total > 0 ? ok / total : 0,
    byOutcome,
    byServer,
    byTool: [...byTool.values()].sort((left, right) => right.count - left.count).slice(0, 50),
    total
  };
}

function toolOutcome(toolCall: ToolCallRecord): string {
  if (toolCall.status === "completed") {
    return "ok";
  }

  if (toolCall.status === "blocked") {
    return "invalid_arg";
  }

  return toolCall.error?.toLowerCase().includes("timeout") ? "timeout" : "error";
}

function usageByUser(runs: readonly AgentRunRecord[]) {
  const byUser = new Map<string, { costUsd: number; inputTokens: number; outputTokens: number; userId: string }>();

  for (const run of runs) {
    const userId = run.userId ?? "anonymous";
    const existing = byUser.get(userId) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, userId };
    byUser.set(userId, {
      costUsd: existing.costUsd + Number(run.costUsd),
      inputTokens: existing.inputTokens + numberField(run.tokenUsage, "inputTokens"),
      outputTokens: existing.outputTokens + numberField(run.tokenUsage, "outputTokens"),
      userId
    });
  }

  return [...byUser.values()].sort((left, right) => right.costUsd - left.costUsd);
}

function usageByModel(runs: readonly AgentRunRecord[]) {
  const byModel = new Map<string, { costUsd: number; inputTokens: number; model: string; outputTokens: number }>();

  for (const run of runs) {
    const existing = byModel.get(run.model) ?? { costUsd: 0, inputTokens: 0, model: run.model, outputTokens: 0 };
    byModel.set(run.model, {
      costUsd: existing.costUsd + Number(run.costUsd),
      inputTokens: existing.inputTokens + numberField(run.tokenUsage, "inputTokens"),
      model: run.model,
      outputTokens: existing.outputTokens + numberField(run.tokenUsage, "outputTokens")
    });
  }

  return [...byModel.values()].sort((left, right) => right.costUsd - left.costUsd);
}

function dailyUsage(runs: readonly AgentRunRecord[]) {
  const byDay = new Map<string, { costUsd: number; date: string; runs: number }>();

  for (const run of runs) {
    const date = run.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(date) ?? { costUsd: 0, date, runs: 0 };
    byDay.set(date, {
      costUsd: existing.costUsd + Number(run.costUsd),
      date,
      runs: existing.runs + 1
    });
  }

  return [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function groupRunsByMetadata(runs: readonly AgentRunRecord[], _key: string) {
  const byChannel = new Map<string, { channel: string; failed: number; total: number }>();

  for (const run of runs) {
    const channel = run.workspaceId ?? "api";
    const existing = byChannel.get(channel) ?? { channel, failed: 0, total: 0 };
    byChannel.set(channel, {
      channel,
      failed: existing.failed + (run.status === "failed" ? 1 : 0),
      total: existing.total + 1
    });
  }

  return [...byChannel.values()].sort((left, right) => right.total - left.total);
}

function latencyDistribution(runs: readonly AgentRunRecord[]) {
  const buckets = { "0-1s": 0, "1-5s": 0, "5-30s": 0, "30s+": 0, unknown: 0 };

  for (const run of runs) {
    if (!run.startedAt || !run.completedAt) {
      buckets.unknown += 1;
      continue;
    }

    const latencyMs = run.completedAt.getTime() - run.startedAt.getTime();

    if (latencyMs < 1_000) {
      buckets["0-1s"] += 1;
    } else if (latencyMs < 5_000) {
      buckets["1-5s"] += 1;
    } else if (latencyMs < 30_000) {
      buckets["5-30s"] += 1;
    } else {
      buckets["30s+"] += 1;
    }
  }

  return buckets;
}

function latencySummary(runs: readonly AgentRunRecord[], days: number): JsonObject {
  const latencies = runsInLastDays(runs, days).map(runLatencyMs).filter((value): value is number => value !== undefined);
  return {
    count: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99)
  };
}

function latencyTimeseries(runs: readonly AgentRunRecord[], days: number): readonly JsonObject[] {
  const byDay = new Map<string, { count: number; date: string; totalMs: number }>();

  for (const run of runsInLastDays(runs, days)) {
    const latencyMs = runLatencyMs(run);

    if (latencyMs === undefined) {
      continue;
    }

    const date = run.createdAt.toISOString().slice(0, 10);
    const existing = byDay.get(date) ?? { count: 0, date, totalMs: 0 };
    byDay.set(date, { count: existing.count + 1, date, totalMs: existing.totalMs + latencyMs });
  }

  return [...byDay.values()].map((row) => ({
    avgLatencyMs: row.count > 0 ? row.totalMs / row.count : 0,
    count: row.count,
    date: row.date
  }));
}

function runLatencyMs(run: AgentRunRecord): number | undefined {
  return run.startedAt && run.completedAt
    ? Math.max(0, run.completedAt.getTime() - run.startedAt.getTime())
    : undefined;
}

function runsInLastDays(runs: readonly AgentRunRecord[], days: number): readonly AgentRunRecord[] {
  const cutoff = Date.now() - Math.min(90, Math.max(1, days)) * 86_400_000;
  return runs.filter((run) => run.createdAt.getTime() >= cutoff);
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue));
  return sorted[index] ?? 0;
}

function passRateByDay(results: readonly JsonObject[]): readonly JsonObject[] {
  const byDay = new Map<string, { date: string; passed: number; total: number }>();

  for (const result of results) {
    const date = String(result.evaluatedAt ?? result.createdAt ?? nowIso()).slice(0, 10);
    const existing = byDay.get(date) ?? { date, passed: 0, total: 0 };
    byDay.set(date, {
      date,
      passed: existing.passed + (result.passed === true ? 1 : 0),
      total: existing.total + 1
    });
  }

  return [...byDay.values()].map((row) => ({
    date: row.date,
    passRate: row.total > 0 ? row.passed / row.total : 0,
    passed: row.passed,
    total: row.total
  }));
}

function ragStatusSummary(): JsonObject {
  const records = [...state.ragCandidates.values(), ...state.documents.values()];
  const byStatus: Record<string, number> = {};

  for (const record of records) {
    const status = typeof record.status === "string" ? record.status : "indexed";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  return {
    byStatus,
    total: records.length
  };
}

function chunkText(content: string): readonly string[] {
  const maxChunkChars = 2_000;
  const chunks: string[] = [];

  for (let index = 0; index < content.length; index += maxChunkChars) {
    chunks.push(content.slice(index, index + maxChunkChars));
  }

  return chunks.length > 0 ? chunks : [content];
}

function groupRecordsByField(records: readonly JsonObject[], field: string, fallback: string): readonly JsonObject[] {
  const groups = new Map<string, { count: number; key: string }>();

  for (const record of records) {
    const key = typeof record[field] === "string" ? record[field] : fallback;
    const existing = groups.get(key) ?? { count: 0, key };
    groups.set(key, { count: existing.count + 1, key });
  }

  return [...groups.values()].sort((left, right) => right.count - left.count);
}

function debugReplayResponse(run: AgentRunRecord): JsonObject {
  return {
    capturedAt: run.createdAt.toISOString(),
    errorCode: run.status === "failed" ? "RUN_FAILED" : null,
    errorMessage: run.error ?? null,
    expiresAt: new Date(run.createdAt.getTime() + 30 * 86_400_000).toISOString(),
    id: run.id,
    modelId: run.model,
    tenantId: run.workspaceId ?? "default",
    toolsAttempted: [],
    userHash: run.userId ?? "anonymous",
    userPrompt: run.input
  };
}

function runsCsv(runs: readonly AgentRunRecord[]): string {
  return csvRows(
    ["id", "created_at", "user_id", "model", "status", "cost_usd", "input", "output"],
    runs.map((run) => [
      run.id,
      run.createdAt.toISOString(),
      run.userId ?? "anonymous",
      run.model,
      run.status,
      run.costUsd,
      run.input,
      run.output ?? ""
    ])
  );
}

function toolCallsCsv(toolCalls: readonly ToolCallRecord[]): string {
  return csvRows(
    ["id", "run_id", "created_at", "name", "risk", "status", "result", "error"],
    toolCalls.map((call) => [
      call.id,
      call.runId,
      call.createdAt.toISOString(),
      call.name,
      call.risk,
      call.status,
      call.result ?? "",
      call.error ?? ""
    ])
  );
}

function csvRows(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => row.map((item) => csvEscape(String(item ?? ""))).join(","))
  ].join("\n");
}

function csvEscape(value: string): string {
  return value.includes(",") || value.includes("\"") || value.includes("\n")
    ? `"${value.replace(/"/g, "\"\"")}"`
    : value;
}

function numberField(value: JsonObject, key: string): number {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function readNullableNumber(value: unknown): number | undefined {
  const parsed = readNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numberOrString(value: unknown, fallback: number): number | string {
  return typeof value === "string" && value.trim().length > 0 ? value : readNumber(value, fallback);
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value === "true" || value === "1";
  }

  return fallback;
}

function containsIgnoreCase(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function registerMetricIngestionRoutes(
  server: FastifyInstance,
  options: ReactorCompatibilityRouteOptions
): void {
  for (const route of ["mcp-health", "tool-call", "eval-result", "eval-results", "batch"]) {
    server.post(`/api/admin/metrics/ingest/${route}`, async (request, reply) => {
      if (!options.authorizeAdmin(request, reply)) {
        return reply;
      }

      const event = createRecord(state.metricEvents, {
        kind: route,
        payload: toJsonObject(request.body)
      }, "metric_event");
      return reply.status(route === "eval-results" || route === "batch" ? 200 : 202).send({
        accepted: true,
        id: event.id,
        kind: route
      });
    });
  }
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

function readStringSet(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  }

  return typeof value === "string"
    ? [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))]
    : [];
}

function readQueryString(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readQueryStringSet(request: FastifyRequest, key: string): Set<string> {
  const query = request.query as Record<string, unknown>;
  return new Set(readStringSet(query[key]));
}

function readQueryInteger(request: FastifyRequest, key: string, fallback: number): number {
  const raw = readQueryString(request, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readQueryBoolean(request: FastifyRequest, key: string, fallback: boolean): boolean {
  const raw = readQueryString(request, key);

  if (raw === undefined) {
    return fallback;
  }

  return raw === "true" || raw === "1";
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
