import type { AgentCardToolInput, AgentSpec, AgentSpecInput, AgentSpecRegistry } from "@muse/agent-specs";
import { buildAgentCard } from "@muse/agent-specs";
import type { AgentRunResult, AgentRuntime } from "@muse/agent-core";
import {
  extractBearerToken,
  type AuthIdentity,
  type LoginResult,
  type MuseAuth,
  type UserRole
} from "@muse/auth";
import type { McpServer } from "@muse/mcp";
import type { TaskMemoryMaintenance, UserMemory, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type {
  JarvisObservabilitySnapshot,
  LatencyQuery,
  LatencyPoint,
  LatencySummary,
  TokenCostQuery
} from "@muse/observability";
import type {
  RagDocumentStore,
  RagIngestionCandidateStatus,
  RagIngestionCandidateStore,
  RagIngestionPolicy,
  RagIngestionPolicyStore,
  StoredRagDocument,
  StoredRagIngestionCandidate
} from "@muse/rag";
import type { RuntimeSetting, RuntimeSettings, RuntimeSettingType } from "@muse/runtime-settings";
import type {
  AgentRunHistoryStore,
  AgentRunRecord,
  ConversationMessageRecord,
  DebugReplayCaptureStore,
  SessionTag,
  SessionTagStore,
  ToolCallRecord
} from "@muse/runtime-state";
import type { ScheduledJobExecution } from "@muse/scheduler";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { registerAdminAnalyticsCompatRoutes } from "./admin-analytics-compat-routes.js";
import { isRecord, nowIso } from "./compat-parsers.js";
import { notFound } from "./compat-responses.js";
import { listDocuments } from "./compat-document-store.js";
import { currentAuthIdentity } from "./compat-user-memory-store.js";
import { defaultRagIngestionPolicy } from "./compat-rag-ingestion.js";
import { registerAdminObservabilityCompatRoutes } from "./admin-observability-compat-routes.js";
import { registerAdminPlatformCompatRoutes } from "./admin-platform-compat-routes.js";
import { registerAdminSessionCompatRoutes } from "./admin-session-compat-routes.js";
import { registerAdminPlatformAlertCompatRoutes } from "./admin-platform-alert-compat-routes.js";
import { registerAgentCompatibilityRoutes } from "./agent-compat-routes.js";
import { registerAuthCompatibilityRoutes } from "./auth-compat-routes.js";
import { registerMcpCompatibilityRoutes } from "./mcp-compat-routes.js";
import { registerMetricIngestionCompatRoutes } from "./metric-ingestion-compat-routes.js";
import { registerPromptAndRagRoutes } from "./rag-ingestion-compat-routes.js";
import { registerSessionCompatibilityRoutes } from "./session-compat-routes.js";
import { registerUserMemoryCompatRoutes } from "./user-memory-compat-routes.js";
import { recordedSpans, recordedTraceEvents, type AdminRouteState } from "./admin-routes.js";
import type { McpRouteMcp } from "./mcp-routes.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface ReactorCompatibilityRouteOptions {
  readonly admin?: AdminRouteState;
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly authorizeAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly apiPathRegistry?: () => readonly string[];
  readonly debugReplayCaptureStore?: DebugReplayCaptureStore;
  readonly defaultModel?: string;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly ragIngestion?: {
    readonly candidateStore: RagIngestionCandidateStore;
    readonly documentStore?: RagDocumentStore;
    readonly policyStore: RagIngestionPolicyStore;
  };
  readonly runtimeSettings: RuntimeSettings;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly sessionTagStore?: SessionTagStore;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
  readonly userMemoryStore?: UserMemoryStore;
  readonly agentCardIdentity?: {
    readonly name?: string;
    readonly version?: string;
    readonly description?: string;
  };
  readonly agentCardToolProvider?: () => Awaitable<readonly AgentCardToolInput[]>;
  readonly jarvisObservabilitySnapshot?: () => Promise<JarvisObservabilitySnapshot>;
}

type Awaitable<T> = T | Promise<T>;

export type CompatRecord = JsonObject & {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CompatCollection = Map<string, CompatRecord>;
export type { CompatBody } from "./compat-parsers.js";

interface CompatState {
  readonly documents: CompatCollection;
  readonly metricEvents: CompatCollection;
  readonly proactiveChannels: CompatCollection;
  readonly ragCandidates: CompatCollection;
  ragIngestionPolicy: JsonObject;
  ragIngestionPolicyStored: boolean;
  readonly sessionTags: Map<string, CompatRecord[]>;
  readonly userMemory: Map<string, {
    facts: Record<string, string>;
    preferences: Record<string, string>;
    recentTopics: string[];
    updatedAt: string;
  }>;
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
  registerUserMemoryCompatRoutes(server, options);
  registerPromptAndRagRoutes(server, options);
  registerMcpCompatibilityRoutes(server, options);
  registerAdminPlatformCompatRoutes(server, options);
  registerAdminPlatformAlertCompatRoutes(server, options);
  registerAdminSessionCompatRoutes(server, options);
  registerAdminObservabilityCompatRoutes(server, options);
  registerAdminAnalyticsCompatRoutes(server, options);
  registerMetricIngestionCompatRoutes(server, options);
}

function createCompatState(): CompatState {
  return {
    documents: new Map(),
    metricEvents: new Map(),
    proactiveChannels: new Map(),
    ragCandidates: new Map(),
    ragIngestionPolicy: defaultRagIngestionPolicy(),
    ragIngestionPolicyStored: false,
    sessionTags: new Map(),
    userMemory: new Map()
  };
}

// registerAuthCompatibilityRoutes lives in apps/api/src/auth-compat-routes.ts.
// Re-imported into the registerReactorCompatibilityRoutes call site below.

// registerSessionCompatibilityRoutes lives in apps/api/src/session-compat-routes.ts.

// registerAgentCompatibilityRoutes lives in apps/api/src/agent-compat-routes.ts.

// registerDocumentRoutes lives in apps/api/src/document-compat-routes.ts.

// registerPromptAndRagRoutes lives in apps/api/src/rag-ingestion-compat-routes.ts.

// registerMcpCompatibilityRoutes lives in apps/api/src/mcp-compat-routes.ts.

// registerAdminAnalyticsCompatibilityRoutes lives in apps/api/src/admin-analytics-compat-routes.ts.

// Session/run helpers live in apps/api/src/compat-session-store.ts.
export {
  exportSession,
  listAllRuns,
  listAllToolCalls,
  reactorSessionDetail,
  sessionDetail,
  summarizeUsers,
  toSessionResponse
} from "./compat-session-store.js";

// Pure run-aggregation helpers live in apps/api/src/compat-run-aggregations.ts.
export {
  aggregateFailurePatterns,
  dailyUsage,
  latencyDistribution,
  latencySummary,
  latencySummaryFromQuery,
  latencyTimeseries,
  latencyTimeseriesFromQuery,
  latencyWindowStart,
  toolCallRanking,
  toolOutcomeStats,
  usageByModel,
  usageByUser
} from "./compat-run-aggregations.js";



/**
 * Personal-Muse: dispatch debug-replay persistence to the configured
 * `DebugReplayCaptureStore` when present, otherwise drop the capture.
 * Mirrors the surface admin-analytics-compat-routes.ts expects without
 * pulling the deleted `@muse/eval` package back in.
 */
export async function saveDebugReplayCapture(
  options: ReactorCompatibilityRouteOptions,
  record: JsonObject
): Promise<JsonObject> {
  if (options.debugReplayCaptureStore) {
    return options.debugReplayCaptureStore.saveDebugReplayCapture(record);
  }
  return record;
}

export async function listDebugReplayCaptures(
  options: ReactorCompatibilityRouteOptions,
  limit: number
): Promise<readonly JsonObject[]> {
  if (options.debugReplayCaptureStore) {
    return options.debugReplayCaptureStore.listDebugReplayCaptures(limit);
  }
  return [];
}

export async function getDebugReplayCapture(
  options: ReactorCompatibilityRouteOptions,
  id: string
): Promise<JsonObject | undefined> {
  return options.debugReplayCaptureStore?.getDebugReplayCapture(id);
}

export function ragStatusSummary(documents: readonly CompatRecord[] = [...getStateDocuments().values()]): JsonObject {
  const records = [...state.ragCandidates.values(), ...documents];
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

// chunkText lives in apps/api/src/compat-parsers.ts.

export function groupRecordsByField(records: readonly JsonObject[], field: string, fallback: string): readonly JsonObject[] {
  const groups = new Map<string, { count: number; key: string }>();

  for (const record of records) {
    const key = typeof record[field] === "string" ? record[field] : fallback;
    const existing = groups.get(key) ?? { count: 0, key };
    groups.set(key, { count: existing.count + 1, key });
  }

  return [...groups.values()].sort((left, right) => right.count - left.count);
}

export function debugReplayResponse(run: AgentRunRecord): JsonObject {
  return {
    capturedAt: run.createdAt.toISOString(),
    errorCode: run.status === "failed" ? "RUN_FAILED" : null,
    errorMessage: run.error ?? null,
    expiresAt: new Date(run.createdAt.getTime() + 30 * 86_400_000).toISOString(),
    id: run.id,
    modelId: run.model,
    toolsAttempted: [],
    userHash: run.userId ?? "anonymous",
    userPrompt: run.input
  };
}

export { csvRows, runsCsv, toolCallsCsv } from "./compat-csv.js";

// Numeric/boolean parsers live in apps/api/src/compat-parsers.ts.

// registerMetricIngestionRoutes lives in apps/api/src/metric-ingestion-compat-routes.ts.


// Agent-spec helpers live in apps/api/src/compat-agent-spec.ts.
export {
  agentCardResponse,
  agentSpecInputError,
  agentSpecNotFound,
  findAgentSpec,
  findAgentSpecOrReply,
  parseAgentSpecInput,
  toAgentSpecResponse,
  toAgentSpecUpdateInput
} from "./compat-agent-spec.js";

export function createRecord(collection: CompatCollection, input: JsonObject, prefix: string): CompatRecord {
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

export function compatRecord(input: JsonObject, prefix: string, existing?: JsonObject): CompatRecord {
  const id = typeof input.id === "string" && input.id.length > 0 ? input.id : createRunId(prefix);
  return {
    ...input,
    createdAt: typeof existing?.createdAt === "string" ? existing.createdAt : nowIso(),
    id,
    updatedAt: nowIso()
  };
}

// Session-tag store helpers live in apps/api/src/compat-session-tag-store.ts.
export {
  createSessionTag,
  deleteSessionTag,
  deleteSessionTags,
  listSessionTags
} from "./compat-session-tag-store.js";

export function findCompatRecord(collection: CompatCollection, id: string): CompatRecord | undefined {
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


export function getStateRagIngestionPolicy(): JsonObject {
  return state.ragIngestionPolicy;
}

export function getStateRagCandidates(): readonly CompatRecord[] {
  return [...state.ragCandidates.values()];
}

export function getStateMetricEvents(): CompatCollection {
  return state.metricEvents;
}

export function getStateSessionTags(): Map<string, CompatRecord[]> {
  return state.sessionTags;
}

export function isStateRagIngestionPolicyStored(): boolean {
  return state.ragIngestionPolicyStored;
}

export function setStateRagIngestionPolicy(policy: JsonObject, stored: boolean): JsonObject {
  state.ragIngestionPolicy = policy;
  state.ragIngestionPolicyStored = stored;
  return state.ragIngestionPolicy;
}

export function getStateRagCandidatesMap(): CompatCollection {
  return state.ragCandidates;
}

export function getStateDocuments(): CompatCollection {
  return state.documents;
}

export type UserMemoryRecord = {
  facts: Record<string, string>;
  preferences: Record<string, string>;
  recentTopics: string[];
  updatedAt: string;
};

export function getStateUserMemory(): Map<string, UserMemoryRecord> {
  return state.userMemory;
}

export function readIfMatchVersion(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value ? Number.parseInt(value.trim().replace(/^"|"$/g, ""), 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Document/RAG store helpers live in apps/api/src/compat-document-store.ts.
export {
  computeContentHash,
  countDocuments,
  createDocument,
  deleteDocument,
  deleteDocuments,
  duplicateDocumentConflict,
  findDocumentByContentHash,
  listDocuments,
  saveDocumentRecord,
  searchDocuments,
  toDocumentResponse,
  toSearchResultResponse,
  validateAddDocumentBody
} from "./compat-document-store.js";

// validationErrorResponse + prefixValidationDetails live in apps/api/src/compat-responses.ts.

// Auth helpers live in apps/api/src/compat-auth.ts.
export {
  errorMessage,
  parseAuthCredentials,
  requireAuthService,
  toReactorAuthResponse,
  toReactorUserResponse
} from "./compat-auth.js";

// Model registry helpers live in apps/api/src/compat-models.ts.
export {
  agentModeResponse,
  listAdminModelRegistry,
  listSessionModels,
  parseAgentMode
} from "./compat-models.js";

// MCP admin proxy helpers live in apps/api/src/compat-mcp-proxy.ts.
export {
  findMcpCompatServer,
  mcpProxyUnavailable,
  parseMcpAccessPolicy,
  proxyMcpAdminRequest,
  proxySwaggerSourceRequest,
  readAdminUrl,
  swaggerSourcePath
} from "./compat-mcp-proxy.js";

// Dashboard + platform-health helpers live in apps/api/src/compat-dashboard.ts.
export {
  dashboardSummary,
  platformHealthDashboard
} from "./compat-dashboard.js";

// Doctor diagnostic helpers live in apps/api/src/compat-doctor.ts.
export { adminDiagnostic } from "./compat-doctor.js";



// User-memory + auth-identity helpers live in apps/api/src/compat-user-memory-store.ts.
export {
  canAccessUserMemory,
  currentAuthIdentity,
  deleteUserMemory,
  readUserMemory,
  toUserMemoryResponse,
  updateUserMemory,
  userForbidden,
  userMemoryNotFound
} from "./compat-user-memory-store.js";


// errorResponse + badRequest + clampLimit live in apps/api/src/compat-responses.ts.

// RAG ingestion policy + candidate review helpers live in apps/api/src/compat-rag-ingestion.ts.
export {
  clearRagIngestionPolicy,
  defaultRagIngestionPolicy,
  listRagCandidates,
  parseRagIngestionPolicy,
  readStoredRagIngestionPolicy,
  reviewRagCandidate,
  saveRagIngestionPolicy,
  toRagCandidateResponse,
  toRagIngestionPolicyResponse
} from "./compat-rag-ingestion.js";

// stringMapField lives in apps/api/src/compat-parsers.ts.

export function toReactorRuntimeSetting(setting: RuntimeSetting): JsonObject {
  return {
    category: setting.category,
    description: setting.description ?? null,
    key: setting.key,
    type: runtimeSettingTypeResponse(setting.type),
    updatedAt: setting.updatedAt.toISOString(),
    updatedBy: setting.updatedBy ?? null,
    value: setting.value
  };
}

function runtimeSettingTypeResponse(type: string): string {
  return type.toUpperCase();
}

export function adminCapabilitiesResponse(options: ReactorCompatibilityRouteOptions): JsonObject {
  return {
    generatedAt: Date.now(),
    paths: [...(options.apiPathRegistry?.() ?? compatibilityApiPaths())],
    source: "request-mappings"
  };
}

function compatibilityApiPaths(): readonly string[] {
  return [
    "/api/admin/agent-specs",
    "/api/admin/agent-specs/{id}",
    "/api/admin/agent-specs/{id}/system-prompt",
    "/api/admin/capabilities",
    "/api/admin/conversation-analytics/failure-patterns",
    "/api/admin/conversation-analytics/latency-distribution",
    "/api/admin/debug/replay",
    "/api/admin/debug/replay/{id}",
    "/api/admin/doctor",
    "/api/admin/doctor/summary",
    "/api/admin/metrics/latency/summary",
    "/api/admin/metrics/latency/timeseries",
    "/api/admin/models",
    "/api/admin/platform/alerts",
    "/api/admin/platform/alerts/{id}/resolve",
    "/api/admin/platform/alerts/evaluate",
    "/api/admin/platform/cache/invalidate",
    "/api/admin/platform/cache/stats",
    "/api/admin/platform/health",
    "/api/admin/platform/vectorstore/stats",
    "/api/admin/rag-analytics/by-channel",
    "/api/admin/rag-analytics/status",
    "/api/admin/rag/seed-policy",
    "/api/admin/sessions",
    "/api/admin/sessions/{sessionId}",
    "/api/admin/sessions/{sessionId}/export",
    "/api/admin/sessions/{sessionId}/tags",
    "/api/admin/sessions/{sessionId}/tags/{tagId}",
    "/api/admin/sessions/overview",
    "/api/admin/settings",
    "/api/admin/settings/{key}",
    "/api/admin/settings/refresh",
    "/api/admin/task-memory/maintenance/purge-expired",
    "/api/admin/task-memory/maintenance/purge-terminal",
    "/api/admin/tenant/export/executions",
    "/api/admin/tenant/export/tools",
    "/api/admin/token-cost/by-session",
    "/api/admin/token-cost/daily",
    "/api/admin/token-cost/top-expensive",
    "/api/admin/tool-calls",
    "/api/admin/tool-calls/ranking",
    "/api/admin/tools/accuracy",
    "/api/admin/tools/stats",
    "/api/admin/traces",
    "/api/admin/traces/{traceId}/spans",
    "/api/admin/users",
    "/api/admin/users/{userId}/sessions",
    "/api/admin/users/usage/by-model",
    "/api/admin/users/usage/cost",
    "/api/admin/users/usage/daily",
    "/api/auth/change-password",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/register",
    "/api/documents",
    "/api/documents/{documentId}",
    "/api/documents/batch",
    "/api/documents/search",
    "/api/error-report",
    "/api/mcp/servers",
    "/api/mcp/servers/{name}",
    "/api/mcp/servers/{name}/access-policy",
    "/api/mcp/servers/{name}/access-policy/emergency-deny-all",
    "/api/mcp/servers/{name}/connect",
    "/api/mcp/servers/{name}/disconnect",
    "/api/mcp/servers/{name}/preflight",
    "/api/mcp/servers/{name}/swagger/sources",
    "/api/mcp/servers/{name}/swagger/sources/{sourceName}",
    "/api/mcp/servers/{name}/swagger/sources/{sourceName}/diff",
    "/api/mcp/servers/{name}/swagger/sources/{sourceName}/publish",
    "/api/mcp/servers/{name}/swagger/sources/{sourceName}/revisions",
    "/api/mcp/servers/{name}/swagger/sources/{sourceName}/sync",
    "/api/models",
    "/api/ops/dashboard",
    "/api/ops/metrics/names",
    "/api/rag-ingestion/candidates",
    "/api/rag-ingestion/candidates/{id}/approve",
    "/api/rag-ingestion/candidates/{id}/reject",
    "/api/rag-ingestion/policy",
    "/api/sessions",
    "/api/sessions/{sessionId}",
    "/api/sessions/{sessionId}/export",
    "/api/user-memory/{userId}",
    "/api/user-memory/{userId}/facts",
    "/api/user-memory/{userId}/preferences"
  ].sort();
}

export function opsMetricSnapshots(options: ReactorCompatibilityRouteOptions): readonly JsonObject[] {
  const events = options.admin?.observability?.metrics?.recordedEvents() ?? [];

  return events.map((event) => {
    const record = isRecord(event) ? event : {};
    return {
    measurements: { count: 1 },
    meterCount: 1,
    name: String(record.name ?? "unknown"),
    series: []
    };
  });
}


export function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return normalized === "string" || normalized === "number" || normalized === "boolean" || normalized === "json"
    ? normalized
    : undefined;
}


// Body/query parsers + JSON normalizers live in apps/api/src/compat-parsers.ts.
export {
  chunkText,
  containsIgnoreCase,
  dateOrNull,
  dateOrUndefined,
  epochMillisOrNull,
  isAdminLikeRequest,
  isJsonValue,
  isRecord,
  jsonObjectField,
  nowIso,
  nullableNumberResponse,
  nullableStringResponse,
  numberField,
  numberOrString,
  reactorEnumString,
  readAuthUserId,
  readBodyNullableString,
  readBodyString,
  readBoolean,
  readNullableNumber,
  readNullableStringField,
  readNumber,
  readOptionalStringField,
  readQueryBoolean,
  readQueryInstantMillis,
  readQueryInteger,
  readQueryString,
  readQueryStringSet,
  readStringArray,
  readStringSet,
  sanitizeFilename,
  stringArrayField,
  stringField,
  stringMapField,
  toBody,
  toJsonObject
} from "./compat-parsers.js";

// Error envelopes + ParseResult/ApiError types live in apps/api/src/compat-responses.ts.
export {
  badRequest,
  clampLimit,
  errorResponse,
  invalid,
  notFound,
  prefixValidationDetails,
  validationErrorResponse,
  type ApiError,
  type ParseResult
} from "./compat-responses.js";
