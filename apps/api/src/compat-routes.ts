import type { AgentCardToolInput, AgentSpecRegistry } from "@muse/agent-specs";
import type { AgentRuntime } from "@muse/agent-core";
import type { MuseAuth } from "@muse/auth";
import type { TaskMemoryMaintenance, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type {
  MuseObservabilitySnapshot,
  LatencyQuery,
  TokenCostQuery
} from "@muse/observability";
import type { RuntimeSetting, RuntimeSettings } from "@muse/runtime-settings";
import type {
  AgentRunHistoryStore,
  AgentRunRecord,
  DebugReplayCaptureStore,
  SessionTagStore
} from "@muse/runtime-state";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerAdminAnalyticsCompatRoutes } from "./admin-analytics-compat-routes.js";
import { isRecord, nowIso } from "./compat-parsers.js";
import { registerAdminObservabilityCompatRoutes } from "./admin-observability-compat-routes.js";
import { registerAdminPlatformCompatRoutes } from "./admin-platform-compat-routes.js";
import { registerAdminSessionCompatRoutes } from "./admin-session-compat-routes.js";
import { registerAgentCompatibilityRoutes } from "./agent-compat-routes.js";
import { registerAuthCompatibilityRoutes } from "./auth-compat-routes.js";
import { registerMcpCompatibilityRoutes } from "./mcp-compat-routes.js";
import { registerSessionCompatibilityRoutes } from "./session-compat-routes.js";
import { registerUserMemoryCompatRoutes } from "./user-memory-compat-routes.js";
import { type AdminRouteState } from "./admin-routes.js";
import type { McpRouteMcp } from "./mcp-routes.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface CompatibilityRouteOptions {
  readonly admin?: AdminRouteState;
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authService?: MuseAuth;
  readonly requireAuthenticated: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly apiPathRegistry?: () => readonly string[];
  readonly debugReplayCaptureStore?: DebugReplayCaptureStore;
  readonly defaultModel?: string;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
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
  readonly museObservabilitySnapshot?: () => Promise<MuseObservabilitySnapshot>;
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
  readonly sessionTags: Map<string, CompatRecord[]>;
  readonly userMemory: Map<string, {
    facts: Record<string, string>;
    preferences: Record<string, string>;
    recentTopics: string[];
    updatedAt: string;
  }>;
}

let state: CompatState = createCompatState();

export function registerCompatibilityRoutes(
  server: FastifyInstance,
  options: CompatibilityRouteOptions
): void {
  state = createCompatState();
  registerAuthCompatibilityRoutes(server, options);
  registerSessionCompatibilityRoutes(server, options);
  registerAgentCompatibilityRoutes(server, options);
  registerUserMemoryCompatRoutes(server, options);
  registerMcpCompatibilityRoutes(server, options);
  registerAdminPlatformCompatRoutes(server, options);
  registerAdminSessionCompatRoutes(server, options);
  registerAdminObservabilityCompatRoutes(server, options);
  registerAdminAnalyticsCompatRoutes(server, options);
}

function createCompatState(): CompatState {
  return {
    sessionTags: new Map(),
    userMemory: new Map()
  };
}

// registerAuthCompatibilityRoutes lives in apps/api/src/auth-compat-routes.ts.
// Re-imported into the registerCompatibilityRoutes call site below.

// registerSessionCompatibilityRoutes lives in apps/api/src/session-compat-routes.ts.

// registerAgentCompatibilityRoutes lives in apps/api/src/agent-compat-routes.ts.

// registerMcpCompatibilityRoutes lives in apps/api/src/mcp-compat-routes.ts.

// registerAdminAnalyticsCompatibilityRoutes lives in apps/api/src/admin-analytics-compat-routes.ts.

// Session/run helpers live in apps/api/src/compat-session-store.ts.
export {
  exportSession,
  listAllRuns,
  listAllToolCalls,
  compatSessionDetail,
  sessionDetail,
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
  toolOutcomeStats
} from "./compat-run-aggregations.js";



/**
 * Personal-Muse: dispatch debug-replay persistence to the configured
 * `DebugReplayCaptureStore` when present, otherwise drop the capture.
 * Mirrors the surface admin-analytics-compat-routes.ts expects without
 * pulling the deleted `@muse/eval` package back in.
 */
export async function saveDebugReplayCapture(
  options: CompatibilityRouteOptions,
  record: JsonObject
): Promise<JsonObject> {
  if (options.debugReplayCaptureStore) {
    return options.debugReplayCaptureStore.saveDebugReplayCapture(record);
  }
  return record;
}

export async function listDebugReplayCaptures(
  options: CompatibilityRouteOptions,
  limit: number
): Promise<readonly JsonObject[]> {
  if (options.debugReplayCaptureStore) {
    return options.debugReplayCaptureStore.listDebugReplayCaptures(limit);
  }
  return [];
}

export async function getDebugReplayCapture(
  options: CompatibilityRouteOptions,
  id: string
): Promise<JsonObject | undefined> {
  return options.debugReplayCaptureStore?.getDebugReplayCapture(id);
}

// chunkText lives in apps/api/src/compat-parsers.ts.

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

// Numeric/boolean parsers live in apps/api/src/compat-parsers.ts.

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

export function getStateSessionTags(): Map<string, CompatRecord[]> {
  return state.sessionTags;
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

// validationErrorResponse + prefixValidationDetails live in apps/api/src/compat-responses.ts.

// Auth helpers live in apps/api/src/compat-auth.ts.
export {
  errorMessage,
  parseAuthCredentials,
  requireAuthService,
  toCompatAuthResponse,
  toCompatUserResponse
} from "./compat-auth.js";

// Model registry helpers live in apps/api/src/compat-models.ts.
export {
  agentModeResponse,
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

// Dashboard helpers live in apps/api/src/compat-dashboard.ts.
export { dashboardSummary } from "./compat-dashboard.js";

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

// stringMapField lives in apps/api/src/compat-parsers.ts.

export function toCompatRuntimeSetting(setting: RuntimeSetting): JsonObject {
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

export function adminCapabilitiesResponse(options: CompatibilityRouteOptions): JsonObject {
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
    "/api/admin/platform/cache/invalidate",
    "/api/admin/platform/cache/stats",
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
    "/api/admin/token-cost/by-session",
    "/api/admin/token-cost/daily",
    "/api/admin/token-cost/top-expensive",
    "/api/admin/tool-calls",
    "/api/admin/tool-calls/ranking",
    "/api/admin/tools/accuracy",
    "/api/admin/tools/stats",
    "/api/admin/traces",
    "/api/admin/traces/{traceId}/spans",
    "/api/auth/change-password",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/register",
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
    "/api/sessions",
    "/api/sessions/{sessionId}",
    "/api/sessions/{sessionId}/export",
    "/api/user-memory/{userId}",
    "/api/user-memory/{userId}/facts",
    "/api/user-memory/{userId}/preferences"
  ].sort();
}

export function opsMetricSnapshots(options: CompatibilityRouteOptions): readonly JsonObject[] {
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


export { parseRuntimeSettingType } from "./server-input-utils.js";


// Body/query parsers + JSON normalizers live in apps/api/src/compat-parsers.ts.
export {
  chunkText,
  epochMillisOrNull,
  isRecord,
  jsonObjectField,
  nowIso,
  nullableStringResponse,
  compatEnumString,
  readAuthUserId,
  readBodyNullableString,
  readBodyString,
  coerceBoolean,
  coerceNumber,
  readQueryBoolean,
  readQueryInteger,
  readQueryString,
  coerceStringArray,
  coerceStringSet,
  sanitizeFilename,
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
