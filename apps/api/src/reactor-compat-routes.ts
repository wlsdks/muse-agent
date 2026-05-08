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
import { currentAuthIdentity } from "./compat-user-memory-store.js";
import { listInputGuardRules } from "./compat-guard-rule-store.js";
import {
  appendPromptVersion,
  getPromptTemplate,
  listPromptTemplates,
  promptVersions,
  savePromptTemplate,
  toVersionResponse
} from "./compat-promptlab-catalog-store.js";
import { defaultRagIngestionPolicy } from "./compat-rag-ingestion.js";
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

export function getStatePromptExperiments(): CompatCollection {
  return state.promptExperiments;
}

export function getStatePromptExperimentReports(): CompatCollection {
  return state.promptExperimentReports;
}

export function getStatePromptExperimentTrials(): Map<string, JsonObject[]> {
  return state.promptExperimentTrials;
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

// Prompt-experiment lifecycle helpers live in apps/api/src/compat-prompt-experiment.ts.
export {
  activatePromptExperiment,
  cancelPromptExperiment,
  createPromptExperiment,
  deletePromptExperiment,
  getPromptExperiment,
  getPromptExperimentReport,
  listPromptExperimentTrials,
  listPromptExperiments,
  parsePromptExperimentRequest,
  prepareCatalogRecord,
  promptFeedbackAnalysis,
  promptLabRecordToCompat,
  respondPromptExperiment,
  runPromptAutoOptimize,
  runPromptExperiment,
  toPromptExperimentResponse,
  toPromptExperimentStatusResponse,
  toPromptReportResponse,
  toPromptTrialResponse
} from "./compat-prompt-experiment.js";

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

// Input guard pipeline definition + simulation live in apps/api/src/compat-guard-pipeline.ts.
export {
  inputGuardStages,
  simulateGuard,
  stageConfigResponse,
  toGuardStageResponse
} from "./compat-guard-pipeline.js";

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

// RBAC role + retention policy helpers live in apps/api/src/compat-rbac-retention.ts.
export {
  parseRetentionPolicy,
  parseUserRole,
  roleDefinitions,
  userRoleResponse
} from "./compat-rbac-retention.js";

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
