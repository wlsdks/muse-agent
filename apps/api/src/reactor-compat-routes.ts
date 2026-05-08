import type { AgentCardToolInput, AgentSpec, AgentSpecInput, AgentSpecRegistry } from "@muse/agent-specs";
import { buildAgentCard } from "@muse/agent-specs";
import type { AgentRunResult, AgentRuntime } from "@muse/agent-core";
import {
  AuthRateLimiter,
  adminScope,
  extractBearerToken,
  type AuthIdentity,
  type IamTokenExchange,
  type LoginResult,
  type MuseAuth,
  type UserRole
} from "@muse/auth";
import type { McpServer } from "@muse/mcp";
import type {
  ChannelFaqRegistration,
  ChannelFaqRegistrationStore,
  SlackBotInstance,
  SlackBotInstanceStore,
  SlackFeedbackEventStore,
  SlackResponseTrackerStore
} from "@muse/integrations";
import type { AgentEvalStore } from "@muse/eval";
import type { TaskMemoryMaintenance, UserMemory, UserMemoryStore } from "@muse/memory";
import type { ModelProvider } from "@muse/model";
import type {
  FollowupSuggestionStore,
  JarvisObservabilitySnapshot,
  LatencyQuery,
  LatencyPoint,
  LatencySummary,
  TokenCostQuery
} from "@muse/observability";
import type { GuardRuleStore, ToolPolicyInput, ToolPolicyStore } from "@muse/policy";
import { inputGuardSimulationToJson, simulateInputGuardPipeline, toolPolicyToJson } from "@muse/policy";
import type { FeedbackStore, PromptLabCatalogStore, PromptLabExperimentStore } from "@muse/promptlab";
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
  PendingApprovalStore,
  PlatformAlertRule,
  PlatformModelPricing,
  SessionTag,
  SessionTagStore,
  ToolCallRecord
} from "@muse/runtime-state";
import type { ScheduledJobExecution } from "@muse/scheduler";
import { createRunId, type JsonObject } from "@muse/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { registerAdminAnalyticsCompatRoutes } from "./admin-analytics-compat-routes.js";
import {
  agentEvalResult,
  countBehaviorAssertions,
  countEvalAssertions,
  replayRunId,
  replayToolCalls,
  syntheticReplayRun,
  toEvalRunLogResponse,
  toEvalToolCall
} from "./compat-agent-eval-shape.js";
import {
  saveAgentEvalRunLog,
  saveAgentEvalResult
} from "./compat-agent-eval-store.js";
import {
  countDocuments,
  listDocuments,
  saveDocumentRecord
} from "./compat-document-store.js";
import { judgeEvalWithModel } from "./compat-eval-judge.js";
import { feedbackRating, listFeedback } from "./compat-feedback-store.js";
import { listInputGuardRules } from "./compat-guard-rule-store.js";
import {
  appendPromptVersion,
  getPromptTemplate,
  listPromptTemplates,
  promptVersions,
  savePromptTemplate,
  toVersionResponse
} from "./compat-promptlab-catalog-store.js";
import { defaultToolPolicy } from "./compat-tool-policy-store.js";
import { registerAdminObservabilityCompatRoutes } from "./admin-observability-compat-routes.js";
import { registerAdminPlatformCompatRoutes } from "./admin-platform-compat-routes.js";
import { registerAdminSessionCompatRoutes } from "./admin-session-compat-routes.js";
import { registerAdminTenantAlertCompatRoutes } from "./admin-tenant-alert-compat-routes.js";
import { registerAgentCompatibilityRoutes } from "./agent-compat-routes.js";
import { registerAgentEvalCompatRoutes } from "./agent-eval-compat-routes.js";
import { registerApprovalCompatibilityRoutes } from "./approval-compat-routes.js";
import { registerAuthCompatibilityRoutes } from "./auth-compat-routes.js";
import { registerGuardCompatibilityRoutes } from "./guard-compat-routes.js";
import { registerMcpCompatibilityRoutes } from "./mcp-compat-routes.js";
import { registerMetricIngestionCompatRoutes } from "./metric-ingestion-compat-routes.js";
import { registerPolicyCompatibilityRoutes } from "./policy-compat-routes.js";
import { registerFeedbackCompatRoutes } from "./feedback-compat-routes.js";
import { registerPromptAndRagRoutes } from "./prompt-rag-compat-routes.js";
import { registerSessionCompatibilityRoutes } from "./session-compat-routes.js";
import { registerSlackCompatibilityRoutes } from "./slack-compat-routes.js";
import { registerUserMemoryCompatRoutes } from "./user-memory-compat-routes.js";
import { recordedSpans, recordedTraceEvents, type AdminRouteState } from "./admin-routes.js";
import type { McpRouteMcp } from "./mcp-routes.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";

export interface ReactorCompatibilityRouteOptions {
  readonly admin?: AdminRouteState;
  readonly agentEvalStore?: AgentEvalStore;
  readonly agentRuntime?: AgentRuntime;
  readonly agentSpecRegistry: AgentSpecRegistry;
  readonly authRateLimiter: AuthRateLimiter;
  readonly authService?: MuseAuth;
  readonly iamTokenExchangeService?: IamTokenExchange;
  readonly authorizeAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly authorizeAnyAdmin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  readonly apiPathRegistry?: () => readonly string[];
  readonly defaultModel?: string;
  readonly feedbackStore?: FeedbackStore;
  readonly promptLabCatalogStore?: PromptLabCatalogStore;
  readonly promptLabExperimentStore?: PromptLabExperimentStore;
  readonly followupSuggestionStore?: FollowupSuggestionStore;
  readonly latencyQuery?: LatencyQuery;
  readonly tokenCostQuery?: TokenCostQuery;
  readonly historyStore?: AgentRunHistoryStore;
  readonly mcp?: McpRouteMcp;
  readonly modelProvider?: ModelProvider;
  readonly pendingApprovalStore?: PendingApprovalStore;
  readonly ragIngestion?: {
    readonly candidateStore: RagIngestionCandidateStore;
    readonly documentStore?: RagDocumentStore;
    readonly policyStore: RagIngestionPolicyStore;
  };
  readonly runtimeSettings: RuntimeSettings;
  readonly scheduler?: SchedulerRouteScheduler;
  readonly slackPersistence?: {
    readonly botStore: SlackBotInstanceStore;
    readonly faqStore: ChannelFaqRegistrationStore;
    readonly feedbackStore?: SlackFeedbackEventStore;
    readonly responseTrackerStore?: SlackResponseTrackerStore;
  };
  readonly sessionTagStore?: SessionTagStore;
  readonly taskMemoryMaintenance?: TaskMemoryMaintenance;
  readonly guardRuleStore?: GuardRuleStore;
  readonly toolPolicyStore?: ToolPolicyStore;
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

export type CompatBody = Record<string, unknown>;
export type CompatCollection = Map<string, CompatRecord>;

interface CompatState {
  readonly agentEvalCases: CompatCollection;
  readonly agentEvalResults: CompatCollection;
  readonly agentEvalRunLogs: CompatCollection;
  readonly adminAudits: CompatCollection;
  readonly documents: CompatCollection;
  readonly feedback: CompatCollection;
  readonly inputGuardRules: CompatCollection;
  readonly intents: CompatCollection;
  readonly outputGuardRuleAudits: CompatCollection;
  readonly outputGuardRules: CompatCollection;
  readonly personas: CompatCollection;
  readonly platformAlertRules: CompatCollection;
  readonly platformPricing: CompatCollection;
  readonly metricEvents: CompatCollection;
  readonly promptExperiments: CompatCollection;
  readonly promptExperimentReports: CompatCollection;
  readonly promptExperimentTrials: Map<string, JsonObject[]>;
  readonly proactiveChannels: CompatCollection;
  readonly promptTemplates: CompatCollection;
  readonly ragCandidates: CompatCollection;
  ragIngestionPolicy: JsonObject;
  ragIngestionPolicyStored: boolean;
  readonly sessionTags: Map<string, CompatRecord[]>;
  readonly slackBots: CompatCollection;
  readonly slackFaq: CompatCollection;
  readonly slackFaqEvents: Map<string, CompatRecord[]>;
  readonly slackFaqFeedback: Map<string, Record<string, { thumbsDown: number; thumbsUp: number }>>;
  readonly swaggerSources: CompatCollection;
  readonly userMemory: Map<string, {
    facts: Record<string, string>;
    preferences: Record<string, string>;
    recentTopics: string[];
    updatedAt: string;
  }>;
  retentionPolicy: JsonObject;
  toolPolicyStored: boolean;
  toolPolicy: JsonObject;
}

interface CompatGuardStage {
  readonly className: string;
  readonly config: readonly CompatGuardStageField[];
  readonly enabled: boolean;
  readonly name: string;
  readonly order: number;
}

interface CompatGuardStageField {
  readonly defaultValue: string;
  readonly description: string;
  readonly key: string;
  readonly restartRequired: boolean;
  readonly type: string;
}

let state: CompatState = createCompatState();

export const inputGuardStages: readonly CompatGuardStage[] = [
  {
    className: "RateLimitStage",
    config: [
      {
        defaultValue: "60",
        description: "Requests per minute per user",
        key: "requestsPerMinute",
        restartRequired: true,
        type: "int"
      },
      {
        defaultValue: "1800",
        description: "Requests per hour per user",
        key: "requestsPerHour",
        restartRequired: true,
        type: "int"
      }
    ],
    enabled: true,
    name: "RateLimit",
    order: 0
  },
  {
    className: "InputValidationStage",
    config: [
      {
        defaultValue: "10000",
        description: "Maximum input character length",
        key: "maxLength",
        restartRequired: true,
        type: "int"
      },
      {
        defaultValue: "1",
        description: "Minimum input character length",
        key: "minLength",
        restartRequired: true,
        type: "int"
      }
    ],
    enabled: true,
    name: "InputValidation",
    order: 1
  },
  {
    className: "InjectionDetectionStage",
    config: [
      {
        defaultValue: "medium",
        description: "Prompt injection detection sensitivity",
        key: "sensitivityLevel",
        restartRequired: true,
        type: "enum(low|medium|high)"
      }
    ],
    enabled: true,
    name: "InjectionDetection",
    order: 2
  },
  {
    className: "CompositeClassificationStage",
    config: [
      {
        defaultValue: "false",
        description: "Whether to use LLM classification",
        key: "llmEnabled",
        restartRequired: true,
        type: "bool"
      }
    ],
    enabled: true,
    name: "Classification",
    order: 3
  },
  {
    className: "UnicodeNormalizationStage",
    config: [
      {
        defaultValue: "0.1",
        description: "Allowed ratio of zero-width characters",
        key: "maxZeroWidthRatio",
        restartRequired: true,
        type: "float"
      }
    ],
    enabled: true,
    name: "UnicodeNormalization",
    order: 4
  }
];

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
  registerUserMemoryCompatRoutes(server, options);
  registerFeedbackCompatRoutes(server, options);
  registerPromptAndRagRoutes(server, options);
  registerMcpCompatibilityRoutes(server, options);
  registerSlackCompatibilityRoutes(server, options);
  registerAdminPlatformCompatRoutes(server, options);
  registerAdminTenantAlertCompatRoutes(server, options);
  registerAdminSessionCompatRoutes(server, options);
  registerAdminObservabilityCompatRoutes(server, options);
  registerAdminAnalyticsCompatRoutes(server, options);
  registerAgentEvalCompatRoutes(server, options);
  registerMetricIngestionCompatRoutes(server, options);
}

function createCompatState(): CompatState {
  return {
    agentEvalCases: new Map(),
    agentEvalResults: new Map(),
    agentEvalRunLogs: new Map(),
    adminAudits: new Map(),
    documents: new Map(),
    feedback: new Map(),
    inputGuardRules: new Map(),
    intents: new Map(),
    outputGuardRuleAudits: new Map(),
    outputGuardRules: new Map(),
    personas: new Map(),
    platformAlertRules: new Map(),
    platformPricing: new Map(),
    metricEvents: new Map(),
    promptExperiments: new Map(),
    promptExperimentReports: new Map(),
    promptExperimentTrials: new Map(),
    proactiveChannels: new Map(),
    promptTemplates: new Map(),
    ragCandidates: new Map(),
    ragIngestionPolicy: defaultRagIngestionPolicy(),
    ragIngestionPolicyStored: false,
    sessionTags: new Map(),
    slackBots: new Map(),
    slackFaq: new Map(),
    slackFaqEvents: new Map(),
    slackFaqFeedback: new Map(),
    swaggerSources: new Map(),
    userMemory: new Map(),
    retentionPolicy: {
      auditRetentionDays: 730,
      conversationRetentionDays: 365,
      metricRetentionDays: 180,
      sessionRetentionDays: 90
    },
    toolPolicy: defaultToolPolicy(),
    toolPolicyStored: false
  };
}

// registerAuthCompatibilityRoutes lives in apps/api/src/auth-compat-routes.ts.
// Re-imported into the registerReactorCompatibilityRoutes call site below.

// registerSessionCompatibilityRoutes lives in apps/api/src/session-compat-routes.ts.

// registerAgentCompatibilityRoutes lives in apps/api/src/agent-compat-routes.ts.

// registerApprovalCompatibilityRoutes lives in apps/api/src/approval-compat-routes.ts.

// registerPolicyCompatibilityRoutes lives in apps/api/src/policy-compat-routes.ts.

// registerGuardCompatibilityRoutes lives in apps/api/src/guard-compat-routes.ts.

// registerPersonaRoutes lives in apps/api/src/persona-compat-routes.ts.

// registerPromptTemplateRoutes lives in apps/api/src/prompt-template-compat-routes.ts.

// registerIntentRoutes lives in apps/api/src/intent-compat-routes.ts.

// registerDocumentRoutes lives in apps/api/src/document-compat-routes.ts.

// registerPromptAndRagRoutes lives in apps/api/src/prompt-rag-compat-routes.ts.

// registerMcpCompatibilityRoutes lives in apps/api/src/mcp-compat-routes.ts.

// registerSlackCompatibilityRoutes lives in apps/api/src/slack-compat-routes.ts.

// registerAdminAnalyticsCompatibilityRoutes lives in apps/api/src/admin-analytics-compat-routes.ts.

// registerAgentEvalCompatibilityRoutes lives in apps/api/src/agent-eval-compat-routes.ts.

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

// Eval orchestrators live in apps/api/src/compat-agent-eval-orchestrator.ts.

// Agent-eval store CRUD helpers live in apps/api/src/compat-agent-eval-store.ts.
export {
  getAgentEvalCase,
  getDebugReplayCapture,
  listAgentEvalCases,
  listAgentEvalResults,
  listAgentEvalRunLogs,
  listDebugReplayCaptures,
  saveAgentEvalCase,
  saveDebugReplayCapture
} from "./compat-agent-eval-store.js";

// Eval response shape helpers live in apps/api/src/compat-agent-eval-shape.ts.

export {
  evaluateRunAgainstCase,
  replayEvalCase,
  runLogRecord,
  runLogResponse,
  storeEvalResult
} from "./compat-agent-eval-orchestrator.js";

export { toEvalCaseResponse, toEvalRunLogResponse } from "./compat-agent-eval-shape.js";


// LLM-as-judge pipeline lives in apps/api/src/compat-eval-judge.ts.

export { countBehaviorAssertions, countEvalAssertions } from "./compat-agent-eval-shape.js";

// Pure run-aggregation helpers live in apps/api/src/compat-run-aggregations.ts.
export {
  aggregateFailurePatterns,
  dailyUsage,
  groupRunsByMetadata,
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


// Platform pricing + alert-rule store helpers live in
// apps/api/src/compat-platform-store.ts.
export {
  deletePlatformAlertRule,
  listPlatformAlertRules,
  listPlatformPricing,
  savePlatformAlertRule,
  savePlatformPricing
} from "./compat-platform-store.js";

// Admin-audit + metric-event store helpers live in
// apps/api/src/compat-audit-store.ts.
export {
  adminAuditRows,
  adminAuditStoreRecordToCompat,
  compareCreatedAtDesc,
  inputGuardStatsResponse,
  listAdminAuditRecords,
  passRateByDay,
  recordAdminAudit,
  recordMetricEvent,
  toAdminAuditResponse,
  toInputGuardAuditResponse
} from "./compat-audit-store.js";

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

export function chunkText(content: string): readonly string[] {
  const maxChunkChars = 2_000;
  const chunks: string[] = [];

  for (let index = 0; index < content.length; index += maxChunkChars) {
    chunks.push(content.slice(index, index + maxChunkChars));
  }

  return chunks.length > 0 ? chunks : [content];
}

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
    tenantId: run.workspaceId ?? "default",
    toolsAttempted: [],
    userHash: run.userId ?? "anonymous",
    userPrompt: run.input
  };
}

export { csvRows, runsCsv, toolCallsCsv } from "./compat-csv.js";

export function numberField(value: JsonObject, key: string): number {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
}

export function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

export function readNullableNumber(value: unknown): number | undefined {
  const parsed = readNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numberOrString(value: unknown, fallback: number): number | string {
  return typeof value === "string" && value.trim().length > 0 ? value : readNumber(value, fallback);
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value === "true" || value === "1";
  }

  return fallback;
}

export function containsIgnoreCase(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

// registerMetricIngestionRoutes lives in apps/api/src/metric-ingestion-compat-routes.ts.

export function requireAuthService(options: ReactorCompatibilityRouteOptions, reply: FastifyReply): MuseAuth | undefined {
  if (!options.authService) {
    reply.status(404).send({
      code: "AUTH_UNAVAILABLE",
      message: "Auth service is not configured"
    });
    return undefined;
  }

  return options.authService;
}

export function requirePendingApprovalStore(
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

export function parseAuthCredentials(
  value: unknown,
  mode: "login" | "register"
): ParseResult<{ readonly email: string; readonly name: string; readonly password: string }> {
  if (!isRecord(value) || typeof value.email !== "string" || typeof value.password !== "string") {
    return invalid("INVALID_AUTH_REQUEST", "Body must include email and password strings");
  }

  if (value.email.trim().length === 0 || value.password.length === 0) {
    return invalid("INVALID_AUTH_REQUEST", "Email and password must not be blank");
  }

  if (mode === "register" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email.trim())) {
    return invalid("INVALID_AUTH_REQUEST", "Invalid email format");
  }

  if (mode === "register" && value.password.length < 8) {
    return invalid("INVALID_AUTH_REQUEST", "Password must be at least 8 characters");
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

export async function respondPromptExperiment(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const id = (request.params as { readonly id: string }).id;
  const record = await getPromptExperiment(options, id);
  return record ? toPromptExperimentResponse(record) : reply.status(404).send(errorResponse(`Experiment not found: ${id}`));
}

// Input/output guard-rule store helpers live in apps/api/src/compat-guard-rule-store.ts.
export {
  createInputGuardRule,
  createOutputGuardRule,
  deleteInputGuardRule,
  deleteOutputGuardRule,
  getInputGuardRule,
  getOutputGuardRule,
  listInputGuardRules,
  listOutputGuardAudits,
  listOutputGuardRules,
  outputGuardRuleDetail,
  outputGuardRuleNotFound,
  recordOutputGuardAudit,
  simulateOutputGuardRules,
  toInputGuardRuleResponse,
  toOutputGuardAuditResponse,
  toOutputGuardRuleResponse,
  updateInputGuardRule,
  updateOutputGuardRule,
  validateInputGuardRule,
  validateOutputGuardRule,
  validateOutputGuardSimulation
} from "./compat-guard-rule-store.js";

export function getStateToolPolicy(): JsonObject {
  return state.toolPolicy;
}

export function getStateRetentionPolicy(): JsonObject {
  return state.retentionPolicy;
}

export function updateStateRetentionPolicy(patch: JsonObject): JsonObject {
  state.retentionPolicy = { ...state.retentionPolicy, ...patch };
  return state.retentionPolicy;
}

export function getStateSlackFaqEvents(channelId: string): readonly CompatRecord[] {
  return state.slackFaqEvents.get(channelId) ?? [];
}

export function getStateSlackFaqFeedback(channelId: string): Record<string, { thumbsDown: number; thumbsUp: number }> {
  return state.slackFaqFeedback.get(channelId) ?? {};
}

export function deleteStateSlackFaqChannel(channelId: string): void {
  state.slackFaqEvents.delete(channelId);
  state.slackFaqFeedback.delete(channelId);
}

export function getStateRagIngestionPolicy(): JsonObject {
  return state.ragIngestionPolicy;
}

export function getStateRagCandidates(): readonly CompatRecord[] {
  return [...state.ragCandidates.values()];
}

export function getStateAgentEvalCases(): CompatCollection {
  return state.agentEvalCases;
}

export function getStateAgentEvalRunLogs(): CompatCollection {
  return state.agentEvalRunLogs;
}

export function getStateAgentEvalResults(): CompatCollection {
  return state.agentEvalResults;
}

export function getStatePlatformPricing(): CompatCollection {
  return state.platformPricing;
}

export function getStatePlatformAlertRules(): CompatCollection {
  return state.platformAlertRules;
}

export function getStateMetricEvents(): CompatCollection {
  return state.metricEvents;
}

export function getStateAdminAudits(): CompatCollection {
  return state.adminAudits;
}

export function getStateInputGuardRules(): CompatCollection {
  return state.inputGuardRules;
}

export function getStateOutputGuardRules(): CompatCollection {
  return state.outputGuardRules;
}

export function getStateOutputGuardRuleAudits(): CompatCollection {
  return state.outputGuardRuleAudits;
}

export function getStateSessionTags(): Map<string, CompatRecord[]> {
  return state.sessionTags;
}

export function isStateToolPolicyStored(): boolean {
  return state.toolPolicyStored;
}

export function setStateToolPolicy(policy: JsonObject, stored: boolean): JsonObject {
  state.toolPolicy = policy;
  state.toolPolicyStored = stored;
  return state.toolPolicy;
}

export function getStateFeedback(): CompatCollection {
  return state.feedback;
}

export function getStatePersonas(): CompatCollection {
  return state.personas;
}

export function getStatePromptTemplates(): CompatCollection {
  return state.promptTemplates;
}

export function getStateIntents(): CompatCollection {
  return state.intents;
}

export function getStateDocuments(): CompatCollection {
  return state.documents;
}

export function getStateSlackBots(): CompatCollection {
  return state.slackBots;
}

export function getStateSlackFaq(): CompatCollection {
  return state.slackFaq;
}

export function getAllStateSlackFaqEvents(): readonly CompatRecord[] {
  return [...state.slackFaqEvents.values()].flat();
}

// Tool-policy store helpers live in apps/api/src/compat-tool-policy-store.ts.
export {
  clearToolPolicy,
  defaultToolPolicy,
  readStoredToolPolicy,
  saveToolPolicy,
  toToolPolicyResponse,
  validateToolPolicyBody
} from "./compat-tool-policy-store.js";

// Feedback store + helpers live in apps/api/src/compat-feedback-store.ts.
export {
  createFeedback,
  deleteFeedback,
  feedbackStats,
  filterFeedback,
  getFeedback,
  isUnreviewedNegativeFeedback,
  listFeedback,
  parseFeedbackRating,
  parseFeedbackReviewStatus,
  toFeedbackExportItem,
  toFeedbackResponse,
  updateFeedbackReview,
  validateFeedbackReviewBody,
  validateFeedbackSubmitBody
} from "./compat-feedback-store.js";

export function readIfMatchVersion(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value ? Number.parseInt(value.trim().replace(/^"|"$/g, ""), 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// PromptLab catalog store helpers (persona+template+intent) live in apps/api/src/compat-promptlab-catalog-store.ts.
export {
  appendPromptVersion,
  createIntent,
  createPersona,
  createPromptTemplate,
  deleteIntent,
  deletePersona,
  deletePromptTemplate,
  getIntent,
  getPersona,
  getPromptTemplate,
  listIntents,
  listPersonas,
  listPromptTemplates,
  savePromptTemplate,
  setPromptVersionStatus,
  toIntentResponse,
  toPersonaResponse,
  toTemplateDetailResponse,
  toTemplateResponse,
  updateIntent,
  updatePersona,
  validateIntentBody,
  validatePersonaBody,
  validatePromptTemplateBody,
  validatePromptVersionBody
} from "./compat-promptlab-catalog-store.js";

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

export function validationErrorResponse(details: JsonObject): JsonObject {
  return {
    details,
    error: "요청 형식이 올바르지 않습니다",
    timestamp: nowIso()
  };
}

export function prefixValidationDetails(prefix: string, details: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(details).map(([field, message]) => [`${prefix}.${field}`, message])
  );
}

// Slack-bot + proactive-channel store helpers live in apps/api/src/compat-slack-store.ts.
export {
  createSlackBot,
  deleteSlackBot,
  getSlackBot,
  listProactiveChannels,
  listSlackBots,
  saveProactiveChannels,
  slackBotNotFound,
  toProactiveChannelResponse,
  toSlackBotResponse,
  updateSlackBot,
  validateSlackBotCreate
} from "./compat-slack-store.js";

interface PromptExperimentInput {
  readonly autoGenerated: boolean;
  readonly baselineVersionId: string;
  readonly candidateVersionIds: readonly string[];
  readonly description: string;
  readonly evaluationConfig: JsonObject;
  readonly judgeModel: string | null;
  readonly model: string | null;
  readonly name: string;
  readonly repetitions: number;
  readonly templateId: string;
  readonly temperature: number;
  readonly testQueries: readonly JsonObject[];
}

export function parsePromptExperimentRequest(request: FastifyRequest): ParseResult<PromptExperimentInput> {
  const body = toBody(request.body);
  const name = readBodyString(body, "name")?.trim();
  const templateId = readBodyString(body, "templateId")?.trim();
  const baselineVersionId = readBodyString(body, "baselineVersionId")?.trim();
  const candidateVersionIds = readStringSet(body.candidateVersionIds);
  const testQueries = parsePromptTestQueries(body.testQueries);

  if (!name) {
    return invalid("INVALID_PROMPT_EXPERIMENT", "Body must include name");
  }

  if (!templateId) {
    return invalid("INVALID_PROMPT_EXPERIMENT", "Body must include templateId");
  }

  if (!baselineVersionId) {
    return invalid("INVALID_PROMPT_EXPERIMENT", "Body must include baselineVersionId");
  }

  if (candidateVersionIds.length === 0) {
    return invalid("INVALID_PROMPT_EXPERIMENT", "Body must include candidateVersionIds");
  }

  if (testQueries.length === 0) {
    return invalid("INVALID_PROMPT_EXPERIMENT", "Body must include testQueries");
  }

  return {
    ok: true,
    value: {
      autoGenerated: Boolean(body.autoGenerated),
      baselineVersionId,
      candidateVersionIds,
      description: readBodyString(body, "description") ?? "",
      evaluationConfig: promptEvaluationConfig(body.evaluationConfig),
      judgeModel: readNullableStringField(body, "judgeModel"),
      model: readNullableStringField(body, "model"),
      name,
      repetitions: Math.max(1, Math.trunc(readNumber(body.repetitions, 1))),
      templateId,
      temperature: readNumber(body.temperature, 0.3),
      testQueries
    }
  };
}

export async function createPromptExperiment(
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions,
  input: PromptExperimentInput
): Promise<CompatRecord> {
  const identity = await currentAuthIdentity(request, options);

  return savePromptExperiment(options, {
    autoGenerated: input.autoGenerated,
    baselineVersionId: input.baselineVersionId,
    candidateVersionIds: [...input.candidateVersionIds],
    completedAt: null,
    createdBy: identity?.userId ?? "admin",
    description: input.description,
    errorMessage: null,
    evaluationConfig: input.evaluationConfig,
    judgeModel: input.judgeModel,
    model: input.model,
    name: input.name,
    repetitions: input.repetitions,
    startedAt: null,
    status: "PENDING",
    templateId: input.templateId,
    temperature: input.temperature,
    testQueries: [...input.testQueries]
  });
}

async function savePromptExperiment(
  options: ReactorCompatibilityRouteOptions,
  record: JsonObject
): Promise<CompatRecord> {
  const existing = stringField(record.id, "") ? await getPromptExperiment(options, stringField(record.id, "")) : undefined;
  const prepared = {
    ...existing,
    ...record,
    createdAt: nullableStringResponse(record.createdAt) ?? nullableStringResponse(existing?.createdAt) ?? nowIso(),
    id: stringField(record.id, "") || stringField(existing?.id, "") || createRunId("prompt_experiment"),
    updatedAt: nowIso()
  };

  if (options.promptLabExperimentStore) {
    const saved = await options.promptLabExperimentStore.saveExperiment(prepared);
    return promptLabRecordToCompat(saved, "prompt_experiment");
  }

  return createRecord(state.promptExperiments, prepared, "prompt_experiment");
}

export async function listPromptExperiments(options: ReactorCompatibilityRouteOptions): Promise<readonly CompatRecord[]> {
  if (options.promptLabExperimentStore) {
    const rows = await options.promptLabExperimentStore.listExperiments();
    return rows.map((row) => promptLabRecordToCompat(row, "prompt_experiment"));
  }

  return [...state.promptExperiments.values()];
}

export async function getPromptExperiment(
  options: ReactorCompatibilityRouteOptions,
  id: string
): Promise<CompatRecord | undefined> {
  if (options.promptLabExperimentStore) {
    const record = await options.promptLabExperimentStore.getExperiment(id);
    return record ? promptLabRecordToCompat(record, "prompt_experiment") : undefined;
  }

  return findCompatRecord(state.promptExperiments, id);
}

export async function deletePromptExperiment(options: ReactorCompatibilityRouteOptions, id: string): Promise<boolean> {
  if (options.promptLabExperimentStore) {
    return options.promptLabExperimentStore.deleteExperiment(id);
  }

  const deleted = state.promptExperiments.delete(id);
  state.promptExperimentReports.delete(id);
  state.promptExperimentTrials.delete(id);
  return deleted;
}

async function savePromptExperimentTrials(
  options: ReactorCompatibilityRouteOptions,
  experimentId: string,
  trials: readonly JsonObject[]
): Promise<void> {
  if (options.promptLabExperimentStore) {
    await options.promptLabExperimentStore.saveTrials(experimentId, trials);
    return;
  }

  state.promptExperimentTrials.set(experimentId, [...trials]);
}

export async function listPromptExperimentTrials(
  options: ReactorCompatibilityRouteOptions,
  experimentId: string
): Promise<readonly CompatRecord[]> {
  if (options.promptLabExperimentStore) {
    const trials = await options.promptLabExperimentStore.listTrials(experimentId);
    return trials.map((trial) => promptLabRecordToCompat(trial, "prompt_trial"));
  }

  return (state.promptExperimentTrials.get(experimentId) ?? []).map((trial) => promptLabRecordToCompat(trial, "prompt_trial"));
}

async function savePromptExperimentReport(
  options: ReactorCompatibilityRouteOptions,
  experimentId: string,
  report: JsonObject
): Promise<CompatRecord> {
  if (options.promptLabExperimentStore) {
    const saved = await options.promptLabExperimentStore.saveReport(experimentId, report);
    return promptLabRecordToCompat(saved, "prompt_experiment_report");
  }

  return createRecord(state.promptExperimentReports, report, "prompt_experiment_report");
}

export async function getPromptExperimentReport(
  options: ReactorCompatibilityRouteOptions,
  experimentId: string
): Promise<CompatRecord | undefined> {
  if (options.promptLabExperimentStore) {
    const report = await options.promptLabExperimentStore.getReport(experimentId);
    return report ? promptLabRecordToCompat(report, "prompt_experiment_report") : undefined;
  }

  return findCompatRecord(state.promptExperimentReports, experimentId);
}

export function promptLabRecordToCompat(record: JsonObject, prefix: string): CompatRecord {
  const id = stringField(record.id, "") || stringField(record.experimentId, "") || createRunId(prefix);
  const createdAt = nullableStringResponse(record.createdAt)
    ?? nullableStringResponse(record.generatedAt)
    ?? nullableStringResponse(record.executedAt)
    ?? nowIso();

  return {
    ...record,
    createdAt,
    id,
    updatedAt: nullableStringResponse(record.updatedAt) ?? createdAt
  };
}

export function prepareCatalogRecord(record: JsonObject, prefix: string): JsonObject {
  const createdAt = nullableStringResponse(record.createdAt) ?? nowIso();
  return {
    ...record,
    createdAt,
    id: stringField(record.id, "") || (prefix === "intent" ? stringField(record.name, "") : createRunId(prefix)),
    updatedAt: nowIso()
  };
}

export async function promptFeedbackAnalysis(
  templateId: string,
  maxSamples: number,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  const related = (await listFeedback(options)).filter((feedback) => nullableStringResponse(feedback.templateId) === templateId);
  const negative = related
    .filter((feedback) => feedbackRating(feedback.rating) === "thumbs_down")
    .slice(0, Math.max(0, Math.trunc(maxSamples)));

  if (negative.length === 0) {
    return {
      analyzedAt: Date.now(),
      negativeCount: 0,
      sampleQueryCount: 0,
      totalFeedback: 0,
      weaknesses: []
    };
  }

  return {
    analyzedAt: Date.now(),
    negativeCount: negative.length,
    sampleQueryCount: negative.filter((feedback) => stringField(feedback.query, "").length > 0).length,
    totalFeedback: related.length,
    weaknesses: promptFeedbackWeaknesses(negative)
  };
}

export async function runPromptAutoOptimize(
  templateId: string,
  options: ReactorCompatibilityRouteOptions,
  body: CompatBody
): Promise<CompatRecord | undefined> {
  const negativeFeedback = await promptNegativeFeedback(templateId, 50, options);

  if (negativeFeedback.length < 5) {
    return undefined;
  }

  const template = await getPromptTemplate(options, templateId);
  const baseline = template
    ? promptVersions(template).find((version) => version.status === "ACTIVE") ?? promptVersions(template)[0]
    : undefined;

  if (!template || !baseline) {
    return undefined;
  }

  const candidateCount = Math.max(1, Math.trunc(readNumber(body.candidateCount, 3)));
  const analysis = await promptFeedbackAnalysis(templateId, negativeFeedback.length, options);
  const weaknesses = Array.isArray(analysis.weaknesses)
    ? analysis.weaknesses.filter(isRecord).map(toJsonObject)
    : [];
  const candidateIds = await createPromptAutoCandidates(options, templateId, baseline, weaknesses, candidateCount);

  if (candidateIds.length === 0) {
    return undefined;
  }

  const experiment = await savePromptExperiment(options, {
    autoGenerated: true,
    baselineVersionId: stringField(baseline.id, ""),
    candidateVersionIds: candidateIds,
    completedAt: null,
    createdBy: "system",
    description: `Auto-generated experiment from ${negativeFeedback.length} negative feedback entries`,
    errorMessage: null,
    evaluationConfig: promptEvaluationConfig(undefined),
    judgeModel: readNullableStringField(body, "judgeModel"),
    model: null,
    name: `Auto-optimize: ${templateId}`,
    repetitions: 1,
    startedAt: null,
    status: "PENDING",
    templateId,
    temperature: 0.3,
    testQueries: negativeFeedback.map((feedback) => ({
      domain: nullableStringResponse(feedback.domain),
      expectedBehavior: null,
      intent: nullableStringResponse(feedback.intent),
      query: stringField(feedback.query, ""),
      tags: stringArrayField(feedback.tags, [])
    }))
  });

  await completePromptExperimentRun(experiment, options);
  return experiment;
}

async function promptNegativeFeedback(
  templateId: string,
  maxSamples: number,
  options: ReactorCompatibilityRouteOptions
): Promise<CompatRecord[]> {
  return (await listFeedback(options))
    .filter((feedback) => nullableStringResponse(feedback.templateId) === templateId)
    .filter((feedback) => feedbackRating(feedback.rating) === "thumbs_down")
    .slice(0, Math.max(0, Math.trunc(maxSamples)));
}

async function createPromptAutoCandidates(
  options: ReactorCompatibilityRouteOptions,
  templateId: string,
  baseline: JsonObject,
  weaknesses: readonly JsonObject[],
  candidateCount: number
): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < candidateCount; index += 1) {
    const weakness = weaknesses[index % Math.max(weaknesses.length, 1)];
    const description = weakness ? stringField(weakness.description, "Improve response quality.") : "Improve response quality.";
    const version = await appendPromptVersion(options, templateId, {
      changeLog: "Auto-generated from feedback analysis",
      content: `${stringField(baseline.content, "")}\n\nImprove: ${description}`
    });

    if (!("error" in version)) {
      ids.push(stringField(version.id, ""));
    }
  }

  return ids.filter((id) => id.length > 0);
}

function promptFeedbackWeaknesses(feedback: readonly CompatRecord[]): JsonObject[] {
  const byCategory = new Map<string, { description: string; examples: string[]; frequency: number }>();

  for (const item of feedback) {
    const category = promptWeaknessCategory(item);
    const current = byCategory.get(category) ?? {
      description: promptWeaknessDescription(category),
      examples: [],
      frequency: 0
    };
    const query = stringField(item.query, "");
    byCategory.set(category, {
      ...current,
      examples: query && current.examples.length < 5 ? [...current.examples, query] : current.examples,
      frequency: current.frequency + 1
    });
  }

  return [...byCategory.entries()]
    .sort((left, right) => right[1].frequency - left[1].frequency || left[0].localeCompare(right[0]))
    .map(([category, item]) => ({
      category,
      description: item.description,
      exampleQueries: item.examples,
      frequency: item.frequency
    }));
}

function promptWeaknessCategory(feedback: JsonObject): string {
  const text = [
    feedback.comment,
    feedback.response,
    feedback.query,
    ...stringArrayField(feedback.tags, [])
  ].map((item) => String(item ?? "").toLowerCase()).join(" ");

  if (text.includes("source") || text.includes("citation") || text.includes("reference")) {
    return "missing_sources";
  }

  if (text.includes("short") || text.includes("detail") || text.includes("brief")) {
    return "short_answer";
  }

  if (text.includes("wrong") || text.includes("incorrect") || text.includes("inaccurate")) {
    return "incorrect_info";
  }

  if (text.includes("tool")) {
    return "no_tool_usage";
  }

  if (text.includes("context")) {
    return "missing_context";
  }

  if (text.includes("format") || text.includes("structure")) {
    return "poor_formatting";
  }

  return "other";
}

function promptWeaknessDescription(category: string): string {
  const descriptions: Record<string, string> = {
    incorrect_info: "Feedback indicates inaccurate or incorrect information.",
    missing_context: "Feedback indicates missing context for the user's task.",
    missing_sources: "Feedback indicates missing sources or citations.",
    no_tool_usage: "Feedback indicates the answer should have used tools.",
    other: "Feedback indicates a recurring unresolved quality issue.",
    poor_formatting: "Feedback indicates formatting or structure problems.",
    short_answer: "Feedback indicates the answer needs more detail."
  };
  return descriptions[category] ?? "Feedback indicates a recurring unresolved quality issue.";
}

function parsePromptTestQueries(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const query = typeof item.query === "string" ? item.query.trim() : "";

    if (!query) {
      return [];
    }

    return [{
      domain: nullableStringResponse(item.domain),
      expectedBehavior: nullableStringResponse(item.expectedBehavior),
      intent: nullableStringResponse(item.intent),
      query,
      tags: readStringSet(item.tags)
    }];
  });
}

function promptEvaluationConfig(value: unknown): JsonObject {
  const body = toBody(value);
  return {
    customRubric: readNullableStringField(body, "customRubric"),
    llmJudgeBudgetTokens: Math.trunc(readNumber(body.llmJudgeBudgetTokens, 100_000)),
    llmJudgeEnabled: readBoolean(body.llmJudgeEnabled, true),
    rulesEnabled: readBoolean(body.rulesEnabled, true),
    structuralEnabled: readBoolean(body.structuralEnabled, true)
  };
}

export function toPromptExperimentResponse(record: JsonObject) {
  return {
    autoGenerated: readBoolean(record.autoGenerated, false),
    baselineVersionId: typeof record.baselineVersionId === "string" ? record.baselineVersionId : "",
    candidateVersionIds: readStringSet(record.candidateVersionIds),
    completedAt: epochMillisOrNull(record.completedAt),
    createdAt: epochMillisOrNull(record.createdAt) ?? Date.now(),
    createdBy: typeof record.createdBy === "string" ? record.createdBy : "admin",
    description: typeof record.description === "string" ? record.description : "",
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "",
    startedAt: epochMillisOrNull(record.startedAt),
    status: reactorEnumString(record.status, "PENDING"),
    templateId: typeof record.templateId === "string" ? record.templateId : ""
  };
}

export function toPromptExperimentStatusResponse(record: JsonObject) {
  return {
    completedAt: epochMillisOrNull(record.completedAt),
    errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
    experimentId: typeof record.id === "string" ? record.id : "",
    startedAt: epochMillisOrNull(record.startedAt),
    status: reactorEnumString(record.status, "PENDING")
  };
}

export function toPromptTrialResponse(record: JsonObject) {
  const evaluations = Array.isArray(record.evaluations)
    ? record.evaluations.filter(isRecord).map(toJsonObject)
    : [];
  const scores = evaluations
    .map((evaluation) => readNumber(evaluation.score, Number.NaN))
    .filter((score) => Number.isFinite(score));

  return {
    durationMs: readNumber(record.durationMs, 0),
    executedAt: epochMillisOrNull(record.executedAt) ?? Date.now(),
    id: stringField(record.id, ""),
    passed: evaluations.every((evaluation) => readBoolean(evaluation.passed, false)),
    promptVersionId: stringField(record.promptVersionId, ""),
    promptVersionNumber: readNumber(record.promptVersionNumber, 1),
    query: stringField(record.query, ""),
    response: nullableStringResponse(record.response),
    score: scores.length > 0 ? scores.reduce((total, score) => total + score, 0) / scores.length : 0,
    success: readBoolean(record.success, false),
    toolsUsed: stringArrayField(record.toolsUsed, [])
  };
}

export function toPromptReportResponse(record: JsonObject) {
  const versionSummaries = Array.isArray(record.versionSummaries)
    ? record.versionSummaries.filter(isRecord).map(toJsonObject)
    : [];

  return {
    experimentId: stringField(record.experimentId, ""),
    experimentName: stringField(record.experimentName, ""),
    generatedAt: epochMillisOrNull(record.generatedAt) ?? Date.now(),
    recommendation: jsonObjectField(record.recommendation),
    totalTrials: readNumber(record.totalTrials, 0),
    versionSummaries
  };
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

export async function runPromptExperiment(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { id } = request.params as { readonly id: string };
  const existing = await getPromptExperiment(options, id);

  if (!existing) {
    return reply.status(404).send(errorResponse(`Experiment not found: ${id}`));
  }

  if (reactorEnumString(existing.status, "PENDING") !== "PENDING") {
    return reply.status(400).send(errorResponse(`Experiment must be PENDING to run, current: ${existing.status}`));
  }

  const running = await completePromptExperimentRun(existing, options);

  return reply.status(202).send({ experimentId: running.id, status: "RUNNING" });
}

async function completePromptExperimentRun(
  experiment: CompatRecord,
  options: ReactorCompatibilityRouteOptions
): Promise<CompatRecord> {
  const now = nowIso();
  const running = await savePromptExperiment(options, {
    ...experiment,
    completedAt: experiment.completedAt ?? null,
    startedAt: now,
    status: "RUNNING",
    updatedAt: now
  });

  const trials = await buildPromptExperimentTrials(running, options);
  await savePromptExperimentTrials(options, running.id, trials);
  await createPromptExperimentReport(running, trials, options);
  await savePromptExperiment(options, {
    ...running,
    completedAt: nowIso(),
    status: "COMPLETED"
  });
  return running;
}

async function buildPromptExperimentTrials(
  experiment: JsonObject,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject[]> {
  const versionIds = [
    stringField(experiment.baselineVersionId, ""),
    ...stringArrayField(experiment.candidateVersionIds, [])
  ].filter((versionId) => versionId.length > 0);
  const testQueries = Array.isArray(experiment.testQueries)
    ? experiment.testQueries.filter(isRecord).map(toJsonObject)
    : [];
  const repetitions = Math.max(1, Math.trunc(readNumber(experiment.repetitions, 1)));
  const trials: JsonObject[] = [];

  for (const [versionIndex, versionId] of versionIds.entries()) {
    const version = await findPromptVersionById(options, versionId);
    const versionNumber = version ? readNumber(version.version, versionIndex + 1) : versionIndex + 1;
    const systemPrompt = version ? stringField(version.content, "") : "";

    for (const testQuery of testQueries) {
      for (let repetitionIndex = 0; repetitionIndex < repetitions; repetitionIndex += 1) {
        trials.push(await executePromptTrial({
          experiment,
          options,
          repetitionIndex,
          systemPrompt,
          testQuery,
          versionId,
          versionNumber
        }));
      }
    }
  }

  return trials;
}

interface PromptTrialExecutionInput {
  readonly experiment: JsonObject;
  readonly options: ReactorCompatibilityRouteOptions;
  readonly repetitionIndex: number;
  readonly systemPrompt: string;
  readonly testQuery: JsonObject;
  readonly versionId: string;
  readonly versionNumber: number;
}

async function executePromptTrial(input: PromptTrialExecutionInput): Promise<JsonObject> {
  const query = stringField(input.testQuery.query, "");
  const startedAt = Date.now();
  const model = stringField(input.experiment.model, input.options.defaultModel ?? "compat/default");

  try {
    const result = input.options.agentRuntime
      ? await input.options.agentRuntime.run({
          messages: [
            ...(input.systemPrompt ? [{ content: input.systemPrompt, role: "system" as const }] : []),
            { content: query, role: "user" as const }
          ],
          metadata: {
            promptExperimentId: stringField(input.experiment.id, ""),
            promptVersionId: input.versionId,
            repetitionIndex: input.repetitionIndex
          },
          model
        })
      : undefined;
    const response = result?.response.output ?? null;
    const success = typeof response === "string" && response.trim().length > 0;

    return createPromptTrialRecord({
      durationMs: Date.now() - startedAt,
      evaluations: [promptTrialEvaluation(success, success ? "Response completed" : "No response was produced")],
      query,
      repetitionIndex: input.repetitionIndex,
      response,
      success,
      toolsUsed: result?.toolsUsed ?? [],
      versionId: input.versionId,
      versionNumber: input.versionNumber
    });
  } catch (error) {
    return createPromptTrialRecord({
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.name : "Error",
      evaluations: [promptTrialEvaluation(false, "Trial execution failed")],
      query,
      repetitionIndex: input.repetitionIndex,
      response: null,
      success: false,
      toolsUsed: [],
      versionId: input.versionId,
      versionNumber: input.versionNumber
    });
  }
}

interface PromptTrialRecordInput {
  readonly durationMs: number;
  readonly errorMessage?: string;
  readonly evaluations: readonly JsonObject[];
  readonly query: string;
  readonly repetitionIndex: number;
  readonly response: string | null;
  readonly success: boolean;
  readonly toolsUsed: readonly string[];
  readonly versionId: string;
  readonly versionNumber: number;
}

function createPromptTrialRecord(input: PromptTrialRecordInput): JsonObject {
  return {
    durationMs: input.durationMs,
    errorMessage: input.errorMessage ?? null,
    evaluations: [...input.evaluations],
    executedAt: nowIso(),
    id: createRunId("prompt_trial"),
    promptVersionId: input.versionId,
    promptVersionNumber: input.versionNumber,
    query: input.query,
    repetitionIndex: input.repetitionIndex,
    response: input.response,
    success: input.success,
    toolsUsed: [...input.toolsUsed]
  };
}

function promptTrialEvaluation(passed: boolean, reason: string): JsonObject {
  return {
    evaluatorName: "compatibility",
    passed,
    reason,
    score: passed ? 1 : 0,
    tier: "STRUCTURAL"
  };
}

async function findPromptVersionById(
  options: ReactorCompatibilityRouteOptions,
  versionId: string
): Promise<JsonObject | undefined> {
  for (const template of await listPromptTemplates(options)) {
    const version = promptVersions(template).find((item) => item.id === versionId);

    if (version) {
      return version;
    }
  }

  return undefined;
}

async function createPromptExperimentReport(
  experiment: JsonObject,
  trials: readonly JsonObject[],
  options: ReactorCompatibilityRouteOptions
): Promise<CompatRecord> {
  const versionSummaries = promptVersionSummaries(experiment, trials);
  return savePromptExperimentReport(options, stringField(experiment.id, ""), {
    experimentId: stringField(experiment.id, ""),
    experimentName: stringField(experiment.name, ""),
    generatedAt: nowIso(),
    id: stringField(experiment.id, ""),
    recommendation: promptRecommendation(versionSummaries),
    totalTrials: trials.length,
    versionSummaries
  });
}

function promptVersionSummaries(experiment: JsonObject, trials: readonly JsonObject[]): JsonObject[] {
  const byVersion = new Map<string, JsonObject[]>();

  for (const trial of trials) {
    const versionId = stringField(trial.promptVersionId, "");
    byVersion.set(versionId, [...(byVersion.get(versionId) ?? []), trial]);
  }

  return [...byVersion.entries()].map(([versionId, versionTrials]) =>
    promptVersionSummary(versionId, versionTrials, versionId === stringField(experiment.baselineVersionId, ""))
  );
}

function promptVersionSummary(versionId: string, trials: readonly JsonObject[], isBaseline: boolean): JsonObject {
  const passCount = trials.filter(promptTrialPassed).length;
  const scores = trials.flatMap((trial) => promptTrialScores(trial));
  const durations = trials.map((trial) => readNumber(trial.durationMs, 0));

  return {
    avgDurationMs: average(durations),
    avgScore: average(scores),
    errorRate: trials.length > 0 ? trials.filter((trial) => !readBoolean(trial.success, false)).length / trials.length : 0,
    isBaseline,
    passCount,
    passRate: trials.length > 0 ? passCount / trials.length : 0,
    tierBreakdown: promptTierBreakdown(trials),
    toolUsageFrequency: promptToolUsageFrequency(trials),
    totalTokens: 0,
    totalTrials: trials.length,
    versionId,
    versionNumber: readNumber(trials[0]?.promptVersionNumber, 0)
  };
}

function promptRecommendation(summaries: readonly JsonObject[]): JsonObject {
  const ranked = [...summaries].sort((left, right) =>
    promptRecommendationScore(right) - promptRecommendationScore(left)
  );
  const best = ranked[0];
  const baseline = summaries.find((summary) => readBoolean(summary.isBaseline, false));

  if (!best) {
    return {
      bestVersionId: "",
      bestVersionNumber: 0,
      confidence: "LOW",
      improvements: [],
      reasoning: "Insufficient data for recommendation",
      warnings: ["No trial data available"]
    };
  }

  return {
    bestVersionId: stringField(best.versionId, ""),
    bestVersionNumber: readNumber(best.versionNumber, 0),
    confidence: promptRecommendationConfidence(best, baseline),
    improvements: promptRecommendationImprovements(best, baseline),
    reasoning: promptRecommendationReasoning(best, baseline),
    warnings: promptRecommendationWarnings(best, baseline)
  };
}

function promptRecommendationScore(summary: JsonObject): number {
  return readNumber(summary.passRate, 0) * 0.6 + readNumber(summary.avgScore, 0) * 0.4;
}

function promptRecommendationConfidence(best: JsonObject, baseline: JsonObject | undefined): string {
  if (!baseline) {
    return "LOW";
  }

  const delta = readNumber(best.passRate, 0) - readNumber(baseline.passRate, 0);
  return delta > 0.1 ? "HIGH" : delta > 0.05 ? "MEDIUM" : "LOW";
}

function promptRecommendationReasoning(best: JsonObject, baseline: JsonObject | undefined): string {
  if (!baseline) {
    return `Selected version ${readNumber(best.versionNumber, 0)} (no baseline comparison)`;
  }

  if (readBoolean(best.isBaseline, false)) {
    return `Baseline version ${readNumber(best.versionNumber, 0)} remains the best option`;
  }

  return `Version ${readNumber(best.versionNumber, 0)} outperforms baseline`;
}

function promptRecommendationImprovements(best: JsonObject, baseline: JsonObject | undefined): string[] {
  if (!baseline || readBoolean(best.isBaseline, false)) {
    return [];
  }

  return readNumber(best.passRate, 0) > readNumber(baseline.passRate, 0)
    ? ["Pass rate improved"]
    : [];
}

function promptRecommendationWarnings(best: JsonObject, baseline: JsonObject | undefined): string[] {
  if (!baseline) {
    return ["No baseline for comparison"];
  }

  return readNumber(best.errorRate, 0) > readNumber(baseline.errorRate, 0)
    ? ["Error rate increased"]
    : [];
}

function promptTierBreakdown(trials: readonly JsonObject[]): JsonObject {
  const tiers = ["STRUCTURAL", "RULES", "LLM_JUDGE"];
  const output: Record<string, JsonObject> = {};

  for (const tier of tiers) {
    const evaluations = trials.flatMap((trial) => promptTrialEvaluations(trial))
      .filter((evaluation) => stringField(evaluation.tier, "") === tier);
    const passCount = evaluations.filter((evaluation) => readBoolean(evaluation.passed, false)).length;
    const scores = evaluations.map((evaluation) => readNumber(evaluation.score, 0));
    output[tier] = {
      avgScore: average(scores),
      failCount: evaluations.length - passCount,
      passCount,
      passRate: evaluations.length > 0 ? passCount / evaluations.length : 0
    };
  }

  return output;
}

function promptToolUsageFrequency(trials: readonly JsonObject[]): JsonObject {
  const output: Record<string, number> = {};

  for (const trial of trials) {
    for (const tool of stringArrayField(trial.toolsUsed, [])) {
      output[tool] = (output[tool] ?? 0) + 1;
    }
  }

  return output;
}

function promptTrialPassed(trial: JsonObject): boolean {
  return promptTrialEvaluations(trial).every((evaluation) => readBoolean(evaluation.passed, false));
}

function promptTrialScores(trial: JsonObject): number[] {
  return promptTrialEvaluations(trial).map((evaluation) => readNumber(evaluation.score, 0));
}

function promptTrialEvaluations(trial: JsonObject): JsonObject[] {
  return Array.isArray(trial.evaluations)
    ? trial.evaluations.filter(isRecord).map(toJsonObject)
    : [];
}

function average(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((total, value) => total + value, 0) / finite.length : 0;
}

export async function cancelPromptExperiment(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { id } = request.params as { readonly id: string };
  const existing = await getPromptExperiment(options, id);

  if (!existing) {
    return reply.status(404).send(errorResponse(`Experiment not found: ${id}`));
  }

  if (reactorEnumString(existing.status, "PENDING") !== "RUNNING") {
    return reply.status(400).send(errorResponse("Only RUNNING experiments can be cancelled"));
  }

  const updated = await savePromptExperiment(options, {
    ...existing,
    completedAt: nowIso(),
    status: "CANCELLED"
  });
  return toPromptExperimentResponse(updated);
}

export async function activatePromptExperiment(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { id } = request.params as { readonly id: string };
  const existing = await getPromptExperiment(options, id);

  if (!existing) {
    return reply.status(404).send(errorResponse(`Experiment not found: ${id}`));
  }

  const report = await getPromptExperimentReport(options, id);

  if (!report) {
    return reply.status(400).send(errorResponse("No report available for this experiment"));
  }

  const recommendation = jsonObjectField(report.recommendation);
  const versionId = stringField(recommendation.bestVersionId, "");
  const activated = await activatePromptVersionById(options, stringField(existing.templateId, ""), versionId);

  if (!activated) {
    return reply.status(400).send(errorResponse(`Failed to activate version: ${versionId}`));
  }

  return {
    activated: true,
    templateId: stringField(existing.templateId, ""),
    versionId: stringField(activated.id, ""),
    versionNumber: readNumber(activated.version, 0)
  };
}

async function activatePromptVersionById(
  options: ReactorCompatibilityRouteOptions,
  templateId: string,
  versionId: string
): Promise<JsonObject | undefined> {
  const template = await getPromptTemplate(options, templateId);

  if (!template) {
    return undefined;
  }

  let selected: JsonObject | undefined;
  const versions = promptVersions(template).map((version) => {
    if (version.id === versionId) {
      selected = { ...version, status: "ACTIVE" };
      return selected;
    }

    return version.status === "ACTIVE" ? { ...version, status: "ARCHIVED" } : version;
  });

  if (!selected) {
    return undefined;
  }

  await savePromptTemplate(options, {
    ...template,
    versions
  });
  return toVersionResponse(selected);
}

// Slack FAQ store + helpers live in apps/api/src/compat-slack-faq-store.ts.
export {
  deleteSlackFaqRegistration,
  getSlackFaqRegistration,
  listSlackFaqRegistrations,
  saveSlackFaqRegistration,
  slackFaqAutoReplyMode,
  slackFaqDryRun,
  slackFaqIngest,
  slackFaqNotFound,
  slackFaqProbe,
  slackFaqStats,
  toSlackFaqEvent,
  toSlackFaqRegistration,
  validateSlackFaqChannelId
} from "./compat-slack-faq-store.js";

export function reactorPromptSectionKeys(): string[] {
  return [
    "accuracy",
    "cross-tool",
    "critical",
    "domain:aggregate",
    "domain:marketing",
    "domain:onboarding",
    "domain:policy",
    "domain:summon",
    "domain:workspace",
    "format-slack",
    "identity",
    "proactive",
    "rules",
    "safety",
    "tools",
    "workflow:ask",
    "workflow:search"
  ];
}

export async function updateTenantStatus(
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
    return reply.status(404).send(errorResponse(`Tenant not found: ${id}`));
  }

  return options.admin?.operations?.upsertTenant({
    id,
    monthlyBudgetUsd: tenant.monthlyBudgetUsd,
    name: tenant.name,
    status
  });
}

export async function tenantSummary(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  if (!options.authorizeAnyAdmin(request, reply)) {
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

export function toPlatformAlertRuleResponse(record: JsonObject): JsonObject {
  return {
    createdAt: stringField(record.createdAt, nowIso()),
    description: stringField(record.description, ""),
    enabled: readBoolean(record.enabled, true),
    id: stringField(record.id, ""),
    metric: stringField(record.metric, ""),
    name: stringField(record.name, ""),
    platformOnly: readBoolean(record.platformOnly, false),
    severity: stringField(record.severity, "WARNING"),
    tenantId: nullableStringResponse(record.tenantId),
    threshold: readNumber(record.threshold, 0),
    type: stringField(record.type, "STATIC_THRESHOLD"),
    windowMinutes: readNumber(record.windowMinutes, 15)
  };
}

export async function dashboardSummary(options: ReactorCompatibilityRouteOptions) {
  const [scheduledJobs, pendingApprovals, mcpServers, recentExecutions] = await Promise.all([
    options.scheduler?.store.list() ?? [],
    options.pendingApprovalStore?.countPending() ?? 0,
    options.mcp?.manager.listServers() ?? [],
    options.scheduler?.executionStore?.findRecent(6) ?? []
  ]);
  const metricEvents = recordedMetricEvents(options);
  const documentCount = await countDocuments(options);
  const enabledJobs = scheduledJobs.filter((job) => job.enabled !== false).length;
  const runningJobs = scheduledJobs.filter((job) => job.lastStatus === "running").length;
  const failedJobs = scheduledJobs.filter((job) => job.enabled !== false && job.lastStatus === "failed").length;

  return {
    approvals: {
      pendingCount: pendingApprovals
    },
    employeeValue: employeeValueSummary(metricEvents),
    generatedAt: Date.now(),
    mcp: mcpStatusSummary(options, mcpServers),
    metrics: opsMetricSnapshots(options),
    ragEnabled: documentCount > 0 || state.ragCandidates.size > 0,
    recentSchedulerExecutions: recentExecutions.map(toOpsSchedulerExecutionSummary),
    recentTrustEvents: recentTrustEvents(metricEvents),
    responseTrust: responseTrustSummary(metricEvents),
    scheduler: {
      agentJobs: scheduledJobs.filter((job) => job.enabled !== false && job.jobType === "agent").length,
      attentionBacklog: runningJobs + failedJobs,
      enabledJobs,
      failedJobs,
      runningJobs,
      totalJobs: scheduledJobs.length
    }
  };
}

export async function platformHealthDashboard(options: ReactorCompatibilityRouteOptions): Promise<JsonObject> {
  const alerts = await (options.admin?.operations?.listAlerts() ?? []);
  return {
    activeAlerts: alerts.filter((alert) => toJsonObject(alert).status === "open").length,
    cacheExactHits: 0,
    cacheMisses: 0,
    cacheSemanticHits: 0,
    pipelineBufferUsage: 0,
    pipelineDropRate: 0,
    pipelineWriteLatencyMs: 0,
    services: []
  };
}

function recordedMetricEvents(options: ReactorCompatibilityRouteOptions): readonly JsonObject[] {
  return (options.admin?.observability?.metrics?.recordedEvents() ?? []).map(toJsonObject);
}

function mcpStatusSummary(options: ReactorCompatibilityRouteOptions, servers: readonly McpServer[]): JsonObject {
  const statusCounts: Record<string, number> = {};

  for (const server of servers) {
    const status = reactorEnumString(options.mcp?.manager.getStatus(server.name), "PENDING");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    statusCounts,
    total: servers.length
  };
}

function toOpsSchedulerExecutionSummary(execution: ScheduledJobExecution): JsonObject {
  return {
    completedAt: execution.completedAt?.getTime() ?? null,
    dryRun: execution.dryRun,
    durationMs: execution.durationMs,
    failureReason: schedulerFailureReason(execution.result) ?? null,
    id: execution.id,
    jobId: execution.jobId,
    jobName: execution.jobName,
    resultPreview: schedulerResultPreview(execution.result) ?? null,
    startedAt: execution.startedAt.getTime(),
    status: reactorEnumString(execution.status, "UNKNOWN")
  };
}

function responseTrustSummary(events: readonly JsonObject[]): JsonObject {
  const outputGuardActions = events
    .filter((event) => event.type === "output_guard_action")
    .map((event) => jsonObjectField(event.payload));
  const agentRuns = events
    .filter((event) => event.type === "agent_run")
    .map((event) => jsonObjectField(event.payload));

  return {
    boundaryFailures: events.filter((event) => event.type === "guard_rejection").length,
    outputGuardModified: outputGuardActions.filter((payload) => payload.action === "modified").length,
    outputGuardRejected: outputGuardActions.filter((payload) => payload.action === "rejected").length,
    unverifiedResponses: agentRuns.filter((payload) => {
      const metadata = jsonObjectField(payload.metadata);
      return readBoolean(metadata.verified, true) === false || readBoolean(metadata.grounded, true) === false;
    }).length
  };
}

function recentTrustEvents(events: readonly JsonObject[], limit = 8): readonly JsonObject[] {
  return events
    .filter((event) => event.type === "guard_rejection" || event.type === "output_guard_action")
    .slice(-limit)
    .reverse()
    .map((event) => {
      const payload = jsonObjectField(event.payload);
      const metadata = jsonObjectField(payload.metadata);
      const type = stringField(event.type, "trust_event");

      return {
        action: nullableStringResponse(payload.action),
        channel: nullableStringResponse(metadata.channel),
        occurredAt: Date.now(),
        policy: nullableStringResponse(metadata.policy),
        queryCluster: nullableStringResponse(metadata.queryCluster),
        queryLabel: nullableStringResponse(metadata.queryLabel),
        reason: nullableStringResponse(payload.reason),
        severity: type === "guard_rejection" || payload.action === "rejected" ? "warning" : "info",
        stage: nullableStringResponse(payload.stage),
        type,
        violation: nullableStringResponse(metadata.violation)
      };
    });
}

function employeeValueSummary(events: readonly JsonObject[]): JsonObject {
  const agentRuns = events
    .filter((event) => event.type === "agent_run")
    .map((event) => jsonObjectField(event.payload));
  const guardRejections = events.filter((event) => event.type === "guard_rejection");
  const answerModes: Record<string, number> = {};
  const channels: Record<string, number> = {};
  const toolFamilies: Record<string, number> = {};
  const lanes = new Map<string, {
    blockedResponses: number;
    groundedResponses: number;
    observedResponses: number;
  }>();
  let groundedResponses = 0;
  let interactiveResponses = 0;
  let scheduledResponses = 0;

  for (const run of agentRuns) {
    const metadata = jsonObjectField(run.metadata);
    const answerMode = stringField(metadata.answerMode, "unknown");
    const channel = stringField(metadata.channel, "api");
    const toolFamily = stringField(metadata.toolFamily, "");
    const grounded = readBoolean(metadata.grounded, false);
    const lane = lanes.get(answerMode) ?? { blockedResponses: 0, groundedResponses: 0, observedResponses: 0 };

    incrementRecord(answerModes, answerMode);
    incrementRecord(channels, channel);

    if (toolFamily) {
      incrementRecord(toolFamilies, toolFamily);
    }

    lane.observedResponses += 1;

    if (grounded) {
      groundedResponses += 1;
      lane.groundedResponses += 1;
    }

    if (readBoolean(metadata.interactive, false)) {
      interactiveResponses += 1;
    }

    if (readBoolean(metadata.scheduled, false)) {
      scheduledResponses += 1;
    }

    lanes.set(answerMode, lane);
  }

  const observedResponses = agentRuns.length;

  return {
    answerModes,
    blockedResponses: guardRejections.length,
    channels: recordToBuckets(channels),
    groundedRatePercent: observedResponses > 0 ? Math.floor((groundedResponses * 100) / observedResponses) : 0,
    groundedResponses,
    interactiveResponses,
    lanes: [...lanes.entries()].map(([answerMode, lane]) => ({
      answerMode,
      blockedResponses: lane.blockedResponses,
      groundedRatePercent: lane.observedResponses > 0
        ? Math.floor((lane.groundedResponses * 100) / lane.observedResponses)
        : 0,
      groundedResponses: lane.groundedResponses,
      observedResponses: lane.observedResponses
    })),
    observedResponses,
    scheduledResponses,
    toolFamilies: recordToBuckets(toolFamilies),
    topMissingQueries: guardRejections.slice(-5).reverse().map((event) => {
      const payload = jsonObjectField(event.payload);
      const metadata = jsonObjectField(payload.metadata);

      return {
        blockReason: nullableStringResponse(payload.reason),
        count: 1,
        lastOccurredAt: Date.now(),
        queryCluster: stringField(metadata.queryCluster, "unknown"),
        queryLabel: stringField(metadata.queryLabel, stringField(payload.reason, "unknown"))
      };
    })
  };
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function recordToBuckets(record: Record<string, number>): JsonObject[] {
  return Object.entries(record)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => ({ count, key }));
}

function schedulerFailureReason(result: string | undefined): string | undefined {
  const value = result?.trim() ?? "";

  if (!value.toLowerCase().includes("failed:")) {
    return undefined;
  }

  return value.slice(value.toLowerCase().indexOf("failed:") + "failed:".length).trim() || value;
}

function schedulerResultPreview(result: string | undefined, maxLength = 140): string | undefined {
  const value = result?.trim() ?? "";

  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

export async function adminDiagnostic(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  mode: "report" | "summary"
) {
  if (!options.authorizeAnyAdmin(request, reply)) {
    return reply;
  }

  const report = doctorReport(options);
  const status = doctorOverallStatus(report);
  reply.header("x-doctor-status", status);

  const format = resolveDoctorFormat(request);
  if (mode === "summary") {
    if (format === "text") {
      reply.header("content-type", "text/plain; charset=utf-8");
      return `${doctorSummary(report)} | ${doctorStatusLabel(report)} | ${stringField(report.generatedAt, nowIso())}`;
    }

    if (format === "markdown") {
      reply.header("content-type", "text/markdown; charset=utf-8");
      return `*[${status}]* ${doctorSummary(report)} _(${stringField(report.generatedAt, nowIso())})_`;
    }

    return {
      allHealthy: doctorAllHealthy(report),
      generatedAt: stringField(report.generatedAt, nowIso()),
      status,
      summary: doctorSummary(report)
    };
  }

  if (format === "text") {
    reply.header("content-type", "text/plain; charset=utf-8");
    return doctorHumanReadable(report);
  }

  if (format === "markdown") {
    reply.header("content-type", "text/markdown; charset=utf-8");
    return doctorMarkdown(report);
  }

  return report;
}

function doctorReport(options: ReactorCompatibilityRouteOptions): JsonObject {
  const traceSinkConfigured = Boolean(options.admin?.observability?.traceSink ?? options.admin?.observability?.tracer);

  return {
    generatedAt: nowIso(),
    sections: [
      doctorSection("Runtime Settings", "OK", "활성", [
        doctorCheck("runtimeSettings bean", "OK", "등록됨")
      ]),
      doctorSection(
        "Dynamic Scheduler",
        options.scheduler?.service ? "OK" : "SKIPPED",
        options.scheduler?.service ? "활성" : "비활성",
        [doctorCheck("scheduler service", options.scheduler?.service ? "OK" : "SKIPPED", options.scheduler?.service ? "등록됨" : "등록 안 됨")]
      ),
      doctorSection(
        "Model Provider",
        options.modelProvider ? "OK" : "SKIPPED",
        options.modelProvider ? "활성" : "비활성",
        [
          doctorCheck("model provider", options.modelProvider ? "OK" : "SKIPPED", options.modelProvider ? "등록됨" : "등록 안 됨"),
          doctorCheck(
            "model provider configured",
            options.modelProvider ? "OK" : "SKIPPED",
            options.modelProvider ? "configured" : "not configured"
          )
        ]
      ),
      doctorSection(
        "Database",
        "OK",
        options.historyStore ? "configured" : "in-memory",
        [
          doctorCheck(
            "database configured or in-memory",
            "OK",
            options.historyStore ? "configured" : "in-memory"
          )
        ]
      ),
      doctorSection(
        "Runner",
        "OK",
        "disabled",
        [doctorCheck("runner configured or disabled", "OK", "disabled")]
      ),
      doctorSection(
        "MCP Live Health",
        "OK",
        options.mcp?.manager ? "configured" : "empty",
        [
          doctorCheck("mcp manager", options.mcp?.manager ? "OK" : "SKIPPED", options.mcp?.manager ? "등록됨" : "등록 안 됨"),
          doctorCheck("MCP configured or empty", "OK", options.mcp?.manager ? "configured" : "empty")
        ]
      ),
      doctorSection(
        "Response Cache",
        options.admin?.cache?.responseCache ? "OK" : "SKIPPED",
        options.admin?.cache?.responseCache ? "활성" : "비활성",
        [doctorCheck("response cache", options.admin?.cache?.responseCache ? "OK" : "SKIPPED", options.admin?.cache?.responseCache ? "등록됨" : "등록 안 됨")]
      ),
      doctorSection(
        "Observability Assets",
        traceSinkConfigured ? "OK" : "SKIPPED",
        traceSinkConfigured ? "활성" : "비활성",
        [
          doctorCheck("observability state", options.admin?.observability ? "OK" : "SKIPPED", options.admin?.observability ? "등록됨" : "등록 안 됨"),
          doctorCheck("trace sink configured", traceSinkConfigured ? "OK" : "SKIPPED", traceSinkConfigured ? "configured" : "not configured")
        ]
      )
    ]
  };
}

function doctorSection(
  name: string,
  status: string,
  message: string,
  checks: readonly JsonObject[]
): JsonObject {
  return {
    checks: [...checks],
    message,
    name,
    status
  };
}

function doctorCheck(name: string, status: string, detail: string): JsonObject {
  return {
    detail,
    name,
    status
  };
}

function doctorSections(report: JsonObject): JsonObject[] {
  return Array.isArray(report.sections) ? report.sections.filter(isRecord).map(toJsonObject) : [];
}

function doctorSummary(report: JsonObject): string {
  const sections = doctorSections(report);
  const counts = new Map<string, number>();
  for (const section of sections) {
    const status = stringField(section.status, "OK");
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const order = ["OK", "SKIPPED", "WARN", "ERROR"];
  const summary = order
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => `${status} ${counts.get(status) ?? 0}`)
    .join(", ");
  return `${sections.length} 섹션 — ${summary}`;
}

function doctorOverallStatus(report: JsonObject): "ERROR" | "OK" | "WARN" {
  const statuses = doctorSections(report).map((section) => stringField(section.status, "OK"));
  if (statuses.includes("ERROR")) {
    return "ERROR";
  }

  if (statuses.includes("WARN")) {
    return "WARN";
  }

  return "OK";
}

function doctorAllHealthy(report: JsonObject): boolean {
  return doctorSections(report).every((section) => {
    const status = stringField(section.status, "OK");
    return status === "OK" || status === "SKIPPED";
  });
}

function doctorStatusLabel(report: JsonObject): string {
  const status = doctorOverallStatus(report);
  return status === "ERROR" ? "오류 포함" : status === "WARN" ? "경고 포함" : "정상";
}

function resolveDoctorFormat(request: FastifyRequest): "json" | "markdown" | "text" {
  const accept = String(request.headers.accept ?? "").toLowerCase();
  if (accept.includes("text/markdown") || accept.includes("text/x-markdown")) {
    return "markdown";
  }

  if (accept.includes("text/plain")) {
    return "text";
  }

  return "json";
}

function doctorHumanReadable(report: JsonObject): string {
  const lines = [
    "=== Reactor Doctor Report ===",
    `생성 시각: ${stringField(report.generatedAt, nowIso())}`,
    `요약: ${doctorSummary(report)}`,
    `전체 상태: ${doctorStatusLabel(report)}`,
    ""
  ];

  for (const section of doctorSections(report)) {
    lines.push(`[${doctorStatusShortCode(stringField(section.status, "OK"))}] ${stringField(section.name, "")}`);
    lines.push(`     ${stringField(section.message, "")}`);
    const checks = Array.isArray(section.checks) ? section.checks.filter(isRecord).map(toJsonObject) : [];
    for (const check of checks) {
      lines.push(
        `     [${doctorStatusShortCode(stringField(check.status, "OK"))}] ${stringField(check.name, "")}: ${stringField(check.detail, "")}`
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function doctorMarkdown(report: JsonObject): string {
  const lines = ["*Reactor Doctor Report*", `> ${doctorSummary(report)}`, ""];
  for (const section of doctorSections(report)) {
    lines.push(
      "`[" +
        doctorStatusShortCode(stringField(section.status, "OK")) +
        "]` *" +
        stringField(section.name, "") +
        "* — " +
        stringField(section.message, "")
    );
  }

  return lines.join("\n").trimEnd();
}

function doctorStatusShortCode(status: string): string {
  return status === "SKIPPED" ? "SKIP" : status;
}

export async function simulateGuard(value: unknown, options: ReactorCompatibilityRouteOptions) {
  const input = readBodyString(value, "input")
    ?? readBodyString(value, "text")
    ?? readBodyString(value, "message")
    ?? "";
  return inputGuardSimulationToJson(await simulateInputGuardPipeline({
    input,
    ruleStore: {
      listInputRules: () => listInputGuardRules(options)
    }
  }));
}


export async function updateUserMemory(
  request: FastifyRequest,
  reply: FastifyReply,
  key: "facts" | "preferences",
  options?: ReactorCompatibilityRouteOptions
) {
  const { userId } = request.params as { readonly userId: string };
  const body = toBody(request.body);
  const itemKey = readBodyString(body, "key")?.trim();
  const itemValue = readBodyString(body, "value")?.trim();

  if (!itemKey || !itemValue) {
    return reply.status(400).send(errorResponse("Body must include non-empty key and value"));
  }

  if (options?.userMemoryStore) {
    await (key === "facts"
      ? options.userMemoryStore.upsertFact(userId, itemKey, itemValue)
      : options.userMemoryStore.upsertPreference(userId, itemKey, itemValue));
    return { updated: true };
  }

  const existing = state.userMemory.get(userId) ?? {
    facts: {},
    preferences: {},
    recentTopics: [],
    updatedAt: nowIso()
  };
  const updated = {
    facts: key === "facts" ? { ...existing.facts, [itemKey]: itemValue } : existing.facts,
    preferences: key === "preferences" ? { ...existing.preferences, [itemKey]: itemValue } : existing.preferences,
    recentTopics: existing.recentTopics,
    updatedAt: nowIso()
  };
  state.userMemory.set(userId, updated);
  return { updated: true };
}

export async function readUserMemory(
  options: ReactorCompatibilityRouteOptions,
  userId: string
): Promise<UserMemory | {
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: string[];
  readonly updatedAt: string;
} | undefined> {
  return await options.userMemoryStore?.findByUserId(userId) ?? state.userMemory.get(userId);
}

export async function deleteUserMemory(options: ReactorCompatibilityRouteOptions, userId: string): Promise<void> {
  await options.userMemoryStore?.deleteByUserId(userId);
  state.userMemory.delete(userId);
}

export async function canAccessUserMemory(
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions,
  userId: string
): Promise<boolean> {
  if (userId.trim().length === 0 || userId.toLowerCase() === "anonymous") {
    return false;
  }

  const identity = await currentAuthIdentity(request, options);
  return Boolean(identity?.userId && identity.userId === userId && identity.userId.toLowerCase() !== "anonymous");
}

async function currentAuthIdentity(
  request: FastifyRequest,
  options: ReactorCompatibilityRouteOptions
): Promise<AuthIdentity | undefined> {
  return (request as { auth?: AuthIdentity }).auth
    ?? await options.authService?.authenticateBearer(extractBearerToken(request.headers.authorization));
}

export function toUserMemoryResponse(memory: {
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: string | Date;
}) {
  return {
    facts: memory.facts,
    preferences: memory.preferences,
    recentTopics: [...memory.recentTopics],
    updatedAt: memory.updatedAt instanceof Date ? memory.updatedAt.toISOString() : memory.updatedAt
  };
}

export function userForbidden(reply: FastifyReply) {
  return reply.status(403).send({
    error: "관리자 권한이 필요합니다",
    timestamp: nowIso()
  });
}

export function userMemoryNotFound(reply: FastifyReply, userId: string) {
  return reply.status(404).send({
    error: `User memory not found: ${userId}`,
    timestamp: nowIso()
  });
}

export async function listSessionModels(options: ReactorCompatibilityRouteOptions) {
  const models = await options.modelProvider?.listModels();
  const names = models && models.length > 0
    ? models.map((model) => `${model.providerId}/${model.modelId}`)
    : options.defaultModel ? [options.defaultModel] : [];
  const defaultModel = options.defaultModel ?? names[0] ?? "";

  return {
    defaultModel,
    models: names.map((name) => ({ isDefault: name === defaultModel, name }))
  };
}

export function listAdminModelRegistry(options: ReactorCompatibilityRouteOptions) {
  const defaultModel = options.defaultModel ?? "";
  const pricing = [
    { input: 0.15, name: "gemini-3-flash-preview", output: 0.6 },
    { input: 0.15, name: "gemini-3-flash", output: 0.6 },
    { input: 1.25, name: "gemini-3-pro-preview", output: 10 },
    { input: 1.25, name: "gemini-3-pro", output: 10 },
    { input: 0.15, name: "gemini-2.5-flash", output: 0.6 },
    { input: 1.25, name: "gemini-2.5-pro", output: 10 },
    { input: 2.5, name: "gpt-4o", output: 10 },
    { input: 0.15, name: "gpt-4o-mini", output: 0.6 },
    { input: 3, name: "claude-sonnet-4-20250514", output: 15 },
    { input: 15, name: "claude-opus-4-20250514", output: 75 }
  ];

  return pricing.map((model) => ({
    inputPricePerMillionTokens: model.input,
    isDefault: model.name === defaultModel,
    name: model.name,
    outputPricePerMillionTokens: model.output
  }));
}

function notFound(reply: FastifyReply, code: string) {
  return reply.status(404).send({
    code,
    message: "Compatibility record was not found"
  });
}

export function badRequest(reply: FastifyReply, code: string, message: string) {
  return reply.status(400).send({ code, message });
}

export function errorResponse(error: string): JsonObject {
  return {
    error,
    timestamp: nowIso()
  };
}

export function clampLimit(limit: number): number {
  return Math.min(200, Math.max(1, limit));
}

export function userRoleResponse(role: UserRole): string {
  return role.toUpperCase();
}

function userRoleScope(role: UserRole): string | null {
  if (role === "admin") {
    return "FULL";
  }

  if (role === "admin_manager") {
    return "MANAGER";
  }

  if (role === "admin_developer") {
    return "DEVELOPER";
  }

  return null;
}

export function parseUserRole(value: unknown): UserRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase() as UserRole;
  return normalized === "user"
    || normalized === "admin"
    || normalized === "admin_manager"
    || normalized === "admin_developer"
    ? normalized
    : undefined;
}

export function roleDefinitions(): readonly JsonObject[] {
  const roles: readonly UserRole[] = ["user", "admin", "admin_manager", "admin_developer"];
  return roles.map((role) => ({
    permissions: [...permissionsForRole(role)],
    role: userRoleResponse(role),
    scope: userRoleScope(role)
  }));
}

function permissionsForRole(role: UserRole): readonly string[] {
  if (role === "admin") {
    return [
      "persona:read", "persona:write",
      "prompt:read", "prompt:write",
      "session:read", "session:export",
      "feedback:read",
      "guard:read", "guard:write",
      "mcp:read", "mcp:write",
      "scheduler:read", "scheduler:write",
      "audit:read", "audit:export",
      "user:read", "user:write",
      "settings:read", "settings:write",
      "agent-spec:read", "agent-spec:write"
    ];
  }

  if (role === "admin_developer") {
    return [
      "persona:read", "persona:write",
      "prompt:read", "prompt:write",
      "session:read",
      "feedback:read",
      "guard:read", "guard:write",
      "mcp:read", "mcp:write",
      "scheduler:read", "scheduler:write",
      "audit:read",
      "agent-spec:read", "agent-spec:write"
    ];
  }

  if (role === "admin_manager") {
    return ["session:read", "session:export", "feedback:read", "audit:read", "persona:read"];
  }

  return ["chat:use", "persona:select"];
}

export function parseRetentionPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const parsed: Record<string, number> = {};

  for (const key of [
    "sessionRetentionDays",
    "conversationRetentionDays",
    "auditRetentionDays",
    "metricRetentionDays"
  ]) {
    if (body[key] === undefined || body[key] === null) {
      continue;
    }

    const parsedValue = readNumber(body[key], Number.NaN);

    if (!Number.isInteger(parsedValue) || parsedValue < 1) {
      return invalid("INVALID_RETENTION_POLICY", `${key} must be >= 1`);
    }

    parsed[key] = parsedValue;
  }

  return { ok: true, value: parsed };
}

export function parseRagIngestionPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const allowedChannels = readStringSet(body.allowedChannels);
  const blockedPatterns = readStringSet(body.blockedPatterns);

  if (allowedChannels.length > 300) {
    return invalid("INVALID_RAG_INGESTION_POLICY", "allowedChannels must not exceed 300 entries");
  }

  if (blockedPatterns.length > 200) {
    return invalid("INVALID_RAG_INGESTION_POLICY", "blockedPatterns must not exceed 200 entries");
  }

  const parsed: JsonObject = {
    allowedChannels: allowedChannels.map((channel) => channel.toLowerCase()),
    blockedPatterns,
    enabled: typeof body.enabled === "boolean" ? body.enabled : false,
    minQueryChars: Math.max(1, readNumber(body.minQueryChars, 10)),
    minResponseChars: Math.max(1, readNumber(body.minResponseChars, 20)),
    requireReview: typeof body.requireReview === "boolean" ? body.requireReview : true
  };
  const invalidPattern = blockedPatterns.find((pattern) =>
    pattern.length > 500 || !isValidRegex(pattern));

  if (invalidPattern) {
    return invalid("INVALID_RAG_INGESTION_POLICY", `Invalid blocked pattern: ${invalidPattern.slice(0, 30)}`);
  }

  return { ok: true, value: parsed };
}

export async function readStoredRagIngestionPolicy(options: ReactorCompatibilityRouteOptions): Promise<JsonObject | undefined> {
  const stored = await options.ragIngestion?.policyStore.getOrNull();

  if (stored) {
    return ragPolicyToCompat(stored);
  }

  return state.ragIngestionPolicyStored ? state.ragIngestionPolicy : undefined;
}

export async function saveRagIngestionPolicy(
  options: ReactorCompatibilityRouteOptions,
  policy: JsonObject
): Promise<JsonObject> {
  if (options.ragIngestion?.policyStore) {
    const saved = await options.ragIngestion.policyStore.save(compatToRagPolicy(policy));
    const compat = ragPolicyToCompat(saved);
    state.ragIngestionPolicy = compat;
    state.ragIngestionPolicyStored = true;
    return compat;
  }

  const timestamp = nowIso();
  state.ragIngestionPolicy = {
    ...policy,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.ragIngestionPolicyStored = true;
  return state.ragIngestionPolicy;
}

export async function clearRagIngestionPolicy(options: ReactorCompatibilityRouteOptions): Promise<void> {
  await options.ragIngestion?.policyStore.delete();
  state.ragIngestionPolicy = defaultRagIngestionPolicy();
  state.ragIngestionPolicyStored = false;
}

export async function listRagCandidates(
  options: ReactorCompatibilityRouteOptions,
  query: { readonly channel?: string; readonly limit: number; readonly status?: string }
): Promise<readonly JsonObject[]> {
  if (options.ragIngestion?.candidateStore) {
    const status = ragCandidateStatusValue(query.status);
    const candidates = await options.ragIngestion.candidateStore.list({
      channel: query.channel,
      limit: query.limit,
      ...(status ? { status } : {})
    });
    return candidates.map(ragCandidateToCompat);
  }

  return [...state.ragCandidates.values()]
    .filter((candidate) => !query.status || candidateStatus(candidate.status) === query.status)
    .filter((candidate) => !query.channel || nullableStringResponse(candidate.channel) === query.channel)
    .slice(0, query.limit);
}

async function findRagCandidate(
  options: ReactorCompatibilityRouteOptions,
  id: string
): Promise<JsonObject | undefined> {
  if (options.ragIngestion?.candidateStore) {
    const candidate = await options.ragIngestion.candidateStore.findById(id);
    return candidate ? ragCandidateToCompat(candidate) : undefined;
  }

  return findCompatRecord(state.ragCandidates, id);
}

async function updateRagCandidateReview(
  options: ReactorCompatibilityRouteOptions,
  input: {
    readonly id: string;
    readonly status: Exclude<RagIngestionCandidateStatus, "PENDING">;
    readonly reviewedBy: string;
    readonly reviewComment?: string | null;
    readonly ingestedDocumentId?: string | null;
  }
): Promise<JsonObject | undefined> {
  if (options.ragIngestion?.candidateStore) {
    const candidate = await options.ragIngestion.candidateStore.updateReview(input);
    return candidate ? ragCandidateToCompat(candidate) : undefined;
  }

  const candidate = findCompatRecord(state.ragCandidates, input.id);

  if (!candidate) {
    return undefined;
  }

  return createRecord(state.ragCandidates, {
    ...candidate,
    ingestedDocumentId: input.ingestedDocumentId ?? null,
    reviewComment: input.reviewComment ?? null,
    reviewedAt: nowIso(),
    reviewedBy: input.reviewedBy,
    status: input.status
  }, "rag_candidate");
}

function compatToRagPolicy(policy: JsonObject): RagIngestionPolicy {
  return {
    allowedChannels: readStringSet(policy.allowedChannels),
    blockedPatterns: readStringSet(policy.blockedPatterns),
    enabled: readBoolean(policy.enabled, false),
    minQueryChars: readNumber(policy.minQueryChars, 10),
    minResponseChars: readNumber(policy.minResponseChars, 20),
    requireReview: readBoolean(policy.requireReview, true)
  };
}

function ragPolicyToCompat(policy: RagIngestionPolicy): JsonObject {
  return {
    allowedChannels: [...policy.allowedChannels],
    blockedPatterns: [...policy.blockedPatterns],
    createdAt: policy.createdAt?.toISOString() ?? nowIso(),
    enabled: policy.enabled,
    minQueryChars: policy.minQueryChars,
    minResponseChars: policy.minResponseChars,
    requireReview: policy.requireReview,
    updatedAt: policy.updatedAt?.toISOString() ?? nowIso()
  };
}

function ragCandidateToCompat(candidate: StoredRagIngestionCandidate): JsonObject {
  return {
    capturedAt: candidate.capturedAt.toISOString(),
    channel: candidate.channel,
    id: candidate.id,
    ingestedDocumentId: candidate.ingestedDocumentId,
    query: candidate.query,
    response: candidate.response,
    reviewComment: candidate.reviewComment,
    reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
    reviewedBy: candidate.reviewedBy,
    runId: candidate.runId,
    sessionId: candidate.sessionId,
    status: candidate.status,
    userId: candidate.userId
  };
}

function ragCandidateStatusValue(value: string | undefined): RagIngestionCandidateStatus | undefined {
  return value === "PENDING" || value === "REJECTED" || value === "INGESTED" ? value : undefined;
}

function defaultRagIngestionPolicy(): JsonObject {
  const timestamp = nowIso();
  return {
    allowedChannels: [],
    blockedPatterns: [],
    createdAt: timestamp,
    enabled: false,
    minQueryChars: 10,
    minResponseChars: 20,
    requireReview: true,
    updatedAt: timestamp
  };
}

export function toRagIngestionPolicyResponse(policy: JsonObject): JsonObject {
  return {
    allowedChannels: readStringSet(policy.allowedChannels),
    blockedPatterns: readStringSet(policy.blockedPatterns),
    createdAt: epochMillisOrNull(policy.createdAt) ?? Date.now(),
    enabled: readBoolean(policy.enabled, false),
    minQueryChars: readNumber(policy.minQueryChars, 10),
    minResponseChars: readNumber(policy.minResponseChars, 20),
    requireReview: readBoolean(policy.requireReview, true),
    updatedAt: epochMillisOrNull(policy.updatedAt) ?? Date.now()
  };
}

export async function reviewRagCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  targetStatus: "INGESTED" | "REJECTED"
): Promise<JsonObject | FastifyReply> {
  const { id } = request.params as { readonly id: string };
  const candidate = await findRagCandidate(options, id);

  if (!candidate) {
    return reply.status(404).send(errorResponse(`Candidate not found: ${id}`));
  }

  if (candidateStatus(candidate.status) !== "PENDING") {
    return reply.status(409).send({
      error: "Candidate is already reviewed",
      timestamp: nowIso()
    });
  }

  const body = toBody(request.body);
  const comment = readBodyNullableString(body, "comment");

  if (typeof comment === "string" && comment.length > 500) {
    return reply.status(400).send(errorResponse("comment must not exceed 500 characters"));
  }

  const documentId = targetStatus === "INGESTED" ? createRunId("rag_document") : null;

  if (targetStatus === "INGESTED") {
    await saveDocumentRecord(options, {
      content: stringField(candidate.response, ""),
      id: documentId,
      metadata: {
        candidateId: id,
        channel: nullableStringResponse(candidate.channel),
        runId: stringField(candidate.runId, "")
      }
    });
  }

  const reviewed = await updateRagCandidateReview(options, {
    id,
    ingestedDocumentId: documentId,
    reviewComment: typeof comment === "string" ? comment.trim() : null,
    reviewedBy: readAuthUserId(request) ?? "admin",
    status: targetStatus
  });

  if (!reviewed) {
    return reply.status(404).send(errorResponse(`Candidate not found: ${id}`));
  }

  return toRagCandidateResponse(reviewed);
}

export function toRagCandidateResponse(candidate: JsonObject): JsonObject {
  return {
    capturedAt: epochMillisOrNull(candidate.capturedAt) ?? epochMillisOrNull(candidate.createdAt) ?? Date.now(),
    channel: nullableStringResponse(candidate.channel),
    id: stringField(candidate.id, ""),
    ingestedDocumentId: nullableStringResponse(candidate.ingestedDocumentId),
    query: stringField(candidate.query, ""),
    response: stringField(candidate.response, ""),
    reviewComment: nullableStringResponse(candidate.reviewComment),
    reviewedAt: epochMillisOrNull(candidate.reviewedAt),
    reviewedBy: nullableStringResponse(candidate.reviewedBy),
    runId: stringField(candidate.runId, ""),
    status: candidateStatus(candidate.status)
  };
}

function candidateStatus(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return ["APPROVED", "INGESTED", "PENDING", "REJECTED"].includes(normalized) ? normalized : "PENDING";
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export async function findMcpCompatServer(
  options: ReactorCompatibilityRouteOptions,
  name: string
): Promise<McpServer | undefined> {
  return (await options.mcp?.manager.listServers())?.find((server) => server.name === name);
}

export function mcpProxyUnavailable(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions
) {
  const { name } = request.params as { readonly name: string };

  if (!options.mcp) {
    return reply.status(503).send({
      error: "MCP manager is not configured",
      timestamp: nowIso()
    });
  }

  return reply.status(404).send({
    error: `MCP server '${name}' not found`,
    timestamp: nowIso()
  });
}

export async function proxySwaggerSourceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ReactorCompatibilityRouteOptions,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject
) {
  if (!options.authorizeAdmin(request, reply)) {
    return reply;
  }

  const serverConfig = await findMcpCompatServer(options, (request.params as { readonly name: string }).name);

  if (!serverConfig) {
    return mcpProxyUnavailable(request, reply, options);
  }

  if (method === "GET" && path === "/admin/swagger/spec-sources" && !readBodyString(serverConfig.config, "adminToken")) {
    return reply
      .header("X-Mcp-Admin-Available", "false")
      .header("X-Mcp-Admin-Reason", "no-admin-token")
      .send([]);
  }

  return proxyMcpAdminRequest(reply, serverConfig, method, path, body);
}

export function swaggerSourcePath(request: FastifyRequest): string {
  const { sourceName } = request.params as { readonly sourceName: string };
  return `/admin/swagger/spec-sources/${encodeURIComponent(sourceName)}`;
}

export function readAdminUrl(config: JsonObject): string | null {
  const adminUrl = readBodyString(config, "adminUrl");

  if (adminUrl && isHttpUrl(adminUrl)) {
    return adminUrl;
  }

  const url = readBodyString(config, "url");

  if (url && isHttpUrl(url)) {
    return url.replace(/\/sse\/?$/u, "");
  }

  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function proxyMcpAdminRequest(
  reply: FastifyReply,
  serverConfig: McpServer,
  method: "DELETE" | "GET" | "POST" | "PUT",
  path: string,
  body?: JsonObject
) {
  const adminUrl = readAdminUrl(serverConfig.config);

  if (!adminUrl) {
    return reply.status(400).send({
      error: `MCP server '${serverConfig.name}' has invalid admin URL`,
      timestamp: nowIso()
    });
  }

  const adminToken = readBodyString(serverConfig.config, "adminToken");

  if (!adminToken) {
    return reply.status(400).send({
      error: `MCP server '${serverConfig.name}' has no admin token. Set config.adminToken`,
      timestamp: nowIso()
    });
  }

  const timeoutMs = readNumber(serverConfig.config.adminTimeoutMs, 15_000);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const upstream = await fetch(new URL(path, adminUrl), {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "muse-admin",
        "x-admin-token": adminToken,
        "x-request-id": createRunId("mcp_admin")
      },
      method,
      signal: abort.signal
    });
    const text = await upstream.text();

    if (upstream.status === 204 || text.length === 0) {
      return reply.status(upstream.status).send();
    }

    return reply.status(upstream.status).send(parseJsonOrText(text));
  } catch (error) {
    return reply.status(error instanceof DOMException && error.name === "AbortError" ? 504 : 502).send({
      error: error instanceof DOMException && error.name === "AbortError"
        ? `MCP admin API timed out after ${timeoutMs}ms`
        : "Failed to call MCP admin API",
      timestamp: nowIso()
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseMcpAccessPolicy(value: unknown): ParseResult<JsonObject> {
  const body = toBody(value);
  const parsed: JsonObject = {
    allowedBitbucketRepositories: readStringSet(body.allowedBitbucketRepositories),
    allowedConfluenceSpaceKeys: readStringSet(body.allowedConfluenceSpaceKeys),
    allowedJiraProjectKeys: readStringSet(body.allowedJiraProjectKeys),
    allowedSourceNames: readStringSet(body.allowedSourceNames),
    allowDirectUrlLoads: nullableBoolean(body.allowDirectUrlLoads),
    allowPreviewReads: nullableBoolean(body.allowPreviewReads),
    allowPreviewWrites: nullableBoolean(body.allowPreviewWrites),
    publishedOnly: nullableBoolean(body.publishedOnly)
  };

  for (const [key, list] of Object.entries(parsed)) {
    if (Array.isArray(list) && list.length > 300) {
      return invalid("INVALID_MCP_ACCESS_POLICY", `${key} must not exceed 300 entries`);
    }
  }

  return { ok: true, value: parsed };
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export async function toGuardStageResponse(
  stage: CompatGuardStage,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  return {
    className: stage.className,
    enabled: stage.enabled,
    name: stage.name,
    order: await options.runtimeSettings.getInteger(`guard.stage.${stage.name}.order`, stage.order),
    runtimeOverride: await runtimeSettingStringOrNull(options, `guard.stage.${stage.name}.enabled`)
  };
}

export async function stageConfigResponse(
  stage: CompatGuardStage,
  options: ReactorCompatibilityRouteOptions
): Promise<JsonObject> {
  const config: Record<string, JsonObject> = {};

  for (const field of stage.config) {
    const value = await runtimeSettingStringOrNull(options, `guard.stage.${stage.name}.${field.key}`);
    config[field.key] = {
      default: field.defaultValue,
      description: field.description,
      overridden: value !== null,
      restartRequired: field.restartRequired,
      type: field.type,
      value: value ?? field.defaultValue
    };
  }

  return {
    className: stage.className,
    config,
    enabled: stage.enabled,
    note: stage.config.length === 0 ? "This stage has no exposed tunable parameters." : null,
    order: await options.runtimeSettings.getInteger(`guard.stage.${stage.name}.order`, stage.order),
    stageName: stage.name
  };
}

async function runtimeSettingStringOrNull(
  options: ReactorCompatibilityRouteOptions,
  key: string
): Promise<string | null> {
  const setting = await options.runtimeSettings.find(key);
  return setting?.value && setting.value.trim().length > 0 ? setting.value : null;
}

export function stringMapField(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string")
  );
}

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
    "/api/admin/agent-eval/cases",
    "/api/admin/agent-eval/cases/{caseId}/evaluate-run/{runId}",
    "/api/admin/agent-eval/cases/{id}/replay",
    "/api/admin/agent-eval/cases/promote",
    "/api/admin/agent-eval/results",
    "/api/admin/agent-eval/run-logs",
    "/api/admin/agent-specs",
    "/api/admin/agent-specs/{id}",
    "/api/admin/agent-specs/{id}/system-prompt",
    "/api/admin/audits",
    "/api/admin/audits/export",
    "/api/admin/capabilities",
    "/api/admin/conversation-analytics/by-channel",
    "/api/admin/conversation-analytics/failure-patterns",
    "/api/admin/conversation-analytics/latency-distribution",
    "/api/admin/debug/replay",
    "/api/admin/debug/replay/{id}",
    "/api/admin/doctor",
    "/api/admin/doctor/summary",
    "/api/admin/evals/pass-rate",
    "/api/admin/evals/runs",
    "/api/admin/followup-suggestions/stats",
    "/api/admin/input-guard/audits",
    "/api/admin/input-guard/pipeline",
    "/api/admin/input-guard/pipeline/reorder",
    "/api/admin/input-guard/rules",
    "/api/admin/input-guard/rules/{id}",
    "/api/admin/input-guard/settings",
    "/api/admin/input-guard/simulate",
    "/api/admin/input-guard/stages/{stageName}/config",
    "/api/admin/input-guard/stats",
    "/api/admin/metrics/latency/summary",
    "/api/admin/metrics/latency/timeseries",
    "/api/admin/models",
    "/api/admin/platform/alerts",
    "/api/admin/platform/alerts/{id}/resolve",
    "/api/admin/platform/alerts/evaluate",
    "/api/admin/platform/alerts/rules",
    "/api/admin/platform/alerts/rules/{id}",
    "/api/admin/platform/cache/invalidate",
    "/api/admin/platform/cache/invalidate-by-pattern",
    "/api/admin/platform/cache/invalidate-key",
    "/api/admin/platform/cache/stats",
    "/api/admin/platform/health",
    "/api/admin/platform/pricing",
    "/api/admin/platform/tenants",
    "/api/admin/platform/tenants/{id}",
    "/api/admin/platform/tenants/{id}/activate",
    "/api/admin/platform/tenants/{id}/suspend",
    "/api/admin/platform/tenants/analytics",
    "/api/admin/platform/users/{id}/role",
    "/api/admin/platform/users/by-email",
    "/api/admin/platform/vectorstore/stats",
    "/api/admin/rag-analytics/by-channel",
    "/api/admin/rag-analytics/status",
    "/api/admin/rag/seed-policy",
    "/api/admin/rbac/roles",
    "/api/admin/rbac/users/{userId}/role",
    "/api/admin/retention",
    "/api/admin/sessions",
    "/api/admin/sessions/{sessionId}",
    "/api/admin/sessions/{sessionId}/export",
    "/api/admin/sessions/{sessionId}/tags",
    "/api/admin/sessions/{sessionId}/tags/{tagId}",
    "/api/admin/sessions/overview",
    "/api/admin/settings",
    "/api/admin/settings/{key}",
    "/api/admin/settings/refresh",
    "/api/admin/slack-activity/channels",
    "/api/admin/slack-activity/daily",
    "/api/admin/slack-bots",
    "/api/admin/slack-bots/{id}",
    "/api/admin/slack/channels/faq",
    "/api/admin/slack/channels/faq/{channelId}",
    "/api/admin/slack/channels/faq/{channelId}/dry-run",
    "/api/admin/slack/channels/faq/{channelId}/events",
    "/api/admin/slack/channels/faq/{channelId}/feedback",
    "/api/admin/slack/channels/faq/{channelId}/ingest",
    "/api/admin/slack/channels/faq/{channelId}/probe",
    "/api/admin/slack/channels/faq/{channelId}/stats",
    "/api/admin/slack/channels/faq/scheduler/health",
    "/api/admin/slack/channels/faq/stats",
    "/api/admin/slack/prompts/reload",
    "/api/admin/task-memory/maintenance/purge-expired",
    "/api/admin/task-memory/maintenance/purge-terminal",
    "/api/admin/tenant/alerts",
    "/api/admin/tenant/cost",
    "/api/admin/tenant/export/executions",
    "/api/admin/tenant/export/tools",
    "/api/admin/tenant/overview",
    "/api/admin/tenant/quality",
    "/api/admin/tenant/quota",
    "/api/admin/tenant/slo",
    "/api/admin/tenant/tools",
    "/api/admin/tenant/usage",
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
    "/api/admin/users/usage/top",
    "/api/approvals",
    "/api/approvals/{id}/approve",
    "/api/approvals/{id}/reject",
    "/api/auth/change-password",
    "/api/auth/demo-login",
    "/api/auth/exchange",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/register",
    "/api/documents",
    "/api/documents/{documentId}",
    "/api/documents/batch",
    "/api/documents/search",
    "/api/error-report",
    "/api/feedback",
    "/api/feedback/{feedbackId}",
    "/api/feedback/bulk-update",
    "/api/feedback/export",
    "/api/feedback/stats",
    "/api/feedback/unreviewed-count",
    "/api/intents",
    "/api/intents/{intentName}",
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
    "/api/output-guard/rules",
    "/api/output-guard/rules/{id}",
    "/api/output-guard/rules/audits",
    "/api/output-guard/rules/simulate",
    "/api/personas",
    "/api/personas/{personaId}",
    "/api/proactive-channels",
    "/api/proactive-channels/{channelId}",
    "/api/prompt-lab/analyze",
    "/api/prompt-lab/auto-optimize",
    "/api/prompt-lab/experiments",
    "/api/prompt-lab/experiments/{id}",
    "/api/prompt-lab/experiments/{id}/activate",
    "/api/prompt-lab/experiments/{id}/cancel",
    "/api/prompt-lab/experiments/{id}/report",
    "/api/prompt-lab/experiments/{id}/run",
    "/api/prompt-lab/experiments/{id}/status",
    "/api/prompt-lab/experiments/{id}/trials",
    "/api/prompt-templates",
    "/api/prompt-templates/{templateId}",
    "/api/prompt-templates/{templateId}/versions",
    "/api/prompt-templates/{templateId}/versions/{versionId}/activate",
    "/api/prompt-templates/{templateId}/versions/{versionId}/archive",
    "/api/rag-ingestion/candidates",
    "/api/rag-ingestion/candidates/{id}/approve",
    "/api/rag-ingestion/candidates/{id}/reject",
    "/api/rag-ingestion/policy",
    "/api/sessions",
    "/api/sessions/{sessionId}",
    "/api/sessions/{sessionId}/export",
    "/api/tool-policy",
    "/api/user-memory/{userId}",
    "/api/user-memory/{userId}/facts",
    "/api/user-memory/{userId}/preferences"
  ].sort();
}

function opsMetricSnapshots(options: ReactorCompatibilityRouteOptions): readonly JsonObject[] {
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

export function toReactorAuthResponse(login: LoginResult): JsonObject {
  return {
    error: null,
    token: login.token,
    user: toReactorUserResponse(login.user)
  };
}

export function toReactorUserResponse(user: LoginResult["user"]): JsonObject {
  const scope = adminScope(user.role);

  return {
    adminScope: scope ? scope.toUpperCase() : null,
    email: user.email,
    id: user.id,
    name: user.name,
    role: user.role.toUpperCase()
  };
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return normalized === "string" || normalized === "number" || normalized === "boolean" || normalized === "json"
    ? normalized
    : undefined;
}

export function parseAgentMode(value: unknown): AgentSpecInput["mode"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "standard" || normalized === "plan_execute" || normalized === "react" ? normalized : undefined;
}

export function agentModeResponse(value: AgentSpecInput["mode"]): string {
  return value === "plan_execute" ? "PLAN_EXECUTE" : (value ?? "react").toUpperCase();
}

export function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export function readStringSet(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  }

  return typeof value === "string"
    ? [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))]
    : [];
}

export function readQueryString(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readQueryStringSet(request: FastifyRequest, key: string): Set<string> {
  const query = request.query as Record<string, unknown>;
  return new Set(readStringSet(query[key]));
}

export function readQueryInteger(request: FastifyRequest, key: string, fallback: number): number {
  const raw = readQueryString(request, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readQueryInstantMillis(request: FastifyRequest, key: string): number | undefined {
  const raw = readQueryString(request, key);

  if (!raw) {
    return undefined;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readQueryBoolean(request: FastifyRequest, key: string, fallback: boolean): boolean {
  const raw = readQueryString(request, key);

  if (raw === undefined) {
    return fallback;
  }

  return raw === "true" || raw === "1";
}

export function readAuthUserId(request: FastifyRequest): string | undefined {
  return (request as { auth?: { userId?: string } }).auth?.userId;
}

export function isAdminLikeRequest(request: FastifyRequest): boolean {
  const role = (request as { auth?: { role?: string } }).auth?.role;
  return role === undefined || role === "admin" || role === "admin_developer";
}

function isAuthenticatedDeveloperAdminLikeRequest(request: FastifyRequest): boolean {
  const role = (request as { auth?: { role?: string } }).auth?.role;
  return role === "admin" || role === "admin_developer";
}

export function readBodyString(value: unknown, key: string): string | undefined {
  const body = toBody(value);
  const item = body[key];
  return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

export function readBodyNullableString(value: unknown, key: string): string | null | undefined {
  const item = toBody(value)[key];
  return item === null || typeof item === "string" ? item : undefined;
}

export function readNullableStringField(value: CompatBody, key: string): string | null {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

export function readOptionalStringField(value: CompatBody, key: string, fallback: unknown): string | null {
  const item = value[key];
  return typeof item === "string" ? item : nullableStringResponse(fallback);
}

export function nullableStringResponse(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nullableNumberResponse(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function stringArrayField(value: unknown, fallback: string[]): string[] {
  const parsed = readStringArray(value);
  return parsed ? [...parsed] : fallback;
}

export function jsonObjectField(value: unknown): JsonObject {
  return isRecord(value) ? toJsonObject(value) : {};
}

export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(([, item]) => isJsonValue(item))) as JsonObject;
}

export function toBody(value: unknown): CompatBody {
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

export function authRateLimitKey(
  forwardedFor: string | string[] | undefined,
  fallbackIp: string,
  path: string
): string {
  const forwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = forwarded?.split(",")[0]?.trim() || fallbackIp || "unknown";
  return `${ip}:${path}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export function epochMillisOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function dateOrUndefined(value: unknown): Date | undefined {
  const millis = epochMillisOrNull(value);
  return millis === null ? undefined : new Date(millis);
}

export function dateOrNull(value: unknown): Date | null {
  return dateOrUndefined(value) ?? null;
}

export function reactorEnumString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toUpperCase()
    : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function invalid(code: string, message: string): ParseResult<never> {
  return {
    error: { code, message },
    ok: false
  };
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly error: ApiError; readonly ok: false };

export interface ApiError {
  readonly code: string;
  readonly message: string;
}
