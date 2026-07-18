/** Response shapes for the Muse API endpoints the web consumes. */

export interface HealthResponse {
  readonly service?: string;
  readonly status?: string;
}

export interface TaglineResponse {
  readonly tagline: string;
  readonly grounded: boolean;
}

export interface Citation {
  readonly url: string;
  readonly title: string;
}

export interface PendingApproval {
  readonly id: string;
  readonly tool: string;
  readonly draft: string;
}

export interface ChatResponse {
  readonly content?: string;
  readonly response?: string;
  readonly runId?: string;
  readonly model?: string;
  readonly citations?: readonly Citation[];
  readonly toolsUsed?: readonly string[];
  readonly pendingApprovals?: readonly PendingApproval[];
  /** S3b: the shared-conversation-store id this turn was appended to (server-issued if the client omitted one). */
  readonly conversationId?: string;
  /**
   * Set (to the user's original ask) when this reply is about a RECURRING
   * automation chat cannot register itself — `chat-automation-honesty.ts`'s
   * post-pass. The Chat view renders a "Create in Builder" action that seeds
   * the Flows copilot composer with this text; `null`/absent means no
   * automation context applies to this turn.
   */
  readonly builderHint?: string | null;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly origin: string;
  readonly turnCount: number;
}
export interface ConversationsListResponse {
  readonly conversations: readonly ConversationSummary[];
}
export interface ConversationTurnRow {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly at?: string;
}
export interface ConversationDetail extends ConversationSummary {
  readonly turns: readonly ConversationTurnRow[];
}

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}
export interface TasksResponse {
  readonly tasks: readonly TaskRow[];
  readonly status: "open" | "done" | "all";
  readonly total: number;
}

export interface BoardTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly blockedReason?: string;
  readonly decomposed?: boolean;
  readonly synthesize?: boolean;
}
export interface BoardResponse {
  readonly tasks: readonly BoardTaskRow[];
}

export interface ReminderRow {
  readonly id: string;
  readonly text: string;
  readonly dueAt: string;
  readonly status: "pending" | "fired";
  readonly firedAt?: string;
  readonly createdAt: string;
}
export interface RemindersResponse {
  readonly reminders: readonly ReminderRow[];
  readonly status: "pending" | "fired" | "all" | "due";
  readonly total: number;
}

interface CalendarEventRow {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAtIso: string;
  readonly endsAtIso: string;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly url: string | null;
}
export interface CalendarEventsResponse {
  readonly events: readonly CalendarEventRow[];
  readonly total: number;
}

interface NotesEntryRow {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes?: number;
}
export interface NotesListResponse {
  readonly dir: string;
  readonly entries: readonly NotesEntryRow[];
  readonly truncated: boolean;
}
export interface NotesReadResponse {
  readonly path: string;
  readonly content: string;
}
interface NotesSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}
export interface NotesSearchResponse {
  readonly matches: readonly NotesSearchMatch[];
  readonly mode: string;
}

/** `POST /api/ask`'s grounded-recall verdict — mirrors `GroundedRecallResult["verdict"]`
 * from `@muse/recall` (the web ships no `@muse/*` deps, so the shape is mirrored here). */
export type AskVerdict = "confident" | "ambiguous" | "none";

/** The early `event: retrieval` SSE frame — arrives before any answer text,
 * so the panel can show grounding breadth while the model is still generating. */
export interface AskRetrieval {
  readonly groundedChunkCount: number;
  readonly notesUnavailable: boolean;
  readonly verdict: AskVerdict;
}

/** The buffered JSON body / final `event: result` SSE frame — mirrors
 * `GroundedRecallResult`. */
export interface AskResult {
  readonly answer: string;
  readonly verdict: AskVerdict;
  readonly citations: readonly string[];
  readonly strippedCitations: readonly string[];
  readonly receipts?: string;
  readonly refusal: boolean;
  readonly notesUnavailable: boolean;
  readonly groundedChunkCount: number;
}

export interface TodayBriefingResponse {
  readonly generatedAt: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
  readonly events?: readonly {
    readonly id: string;
    readonly title: string;
    readonly startsAtIso: string;
  }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
}

export interface ToolCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute";
  readonly keywords?: readonly string[];
}
export interface ToolCatalogResponse {
  readonly tools: readonly ToolCatalogEntry[];
  readonly total: number;
}

export interface McpServerSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly toolCount: number;
  readonly transportType: string;
  readonly autoConnect: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface McpSecurityPolicyView {
  allowedServerNames: string[];
  allowedStdioCommands: string[];
  maxToolOutputLength: number;
  createdAt: number;
  updatedAt: number;
}

export interface McpSecurityResponse {
  configDefault: McpSecurityPolicyView;
  effective: McpSecurityPolicyView;
  stored: McpSecurityPolicyView | null;
}

interface HistoryEntry {
  readonly runId?: string;
  readonly inputPreview?: string;
  readonly outputPreview?: string;
  readonly model?: string;
  readonly status?: string;
  readonly startedAt?: string;
  /** `/api/history`'s real unified-feed shape (reminder/proactive/followup/pattern/episode). */
  readonly id?: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly whenIso?: string;
}
export interface HistoryResponse {
  readonly entries?: readonly HistoryEntry[];
  readonly items?: readonly HistoryEntry[];
}

export interface ProactiveNotice {
  readonly id?: string;
  readonly message?: string;
  readonly text?: string;
  readonly kind?: string;
  readonly createdAt?: string;
}
export interface ProactiveHistoryResponse {
  readonly entries?: readonly ProactiveNotice[];
  readonly items?: readonly ProactiveNotice[];
}

interface ModelInfo {
  readonly id?: string;
  readonly name?: string;
  readonly provider?: string;
}
export interface ModelsResponse {
  readonly models?: readonly ModelInfo[];
  readonly active?: string;
  readonly defaultModel?: string;
}

export interface TokenCostDailyRow {
  readonly day: string;
  readonly model?: string;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly totalCostUsd?: number;
}

interface ToolByName {
  readonly tool: string;
  readonly server?: string;
  readonly outcome?: string;
  readonly count: number;
}
export interface ToolStatsResponse {
  readonly total?: number;
  readonly accuracy?: number;
  readonly byOutcome?: Record<string, number>;
  readonly byTool?: readonly ToolByName[];
}

export interface LatencySummary {
  readonly count?: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
  readonly p99Ms?: number;
}

interface ObjectiveRow {
  readonly id: string;
  readonly spec: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastEvaluatedAt?: string;
  readonly resolution?: string;
}
export interface ObjectivesResponse {
  readonly objectives: readonly ObjectiveRow[];
  readonly total: number;
}

interface ActionRow {
  readonly id: string;
  readonly when: string;
  readonly what: string;
  readonly why: string;
  readonly result: "performed" | "refused" | "failed" | string;
  readonly objectiveId?: string;
  readonly detail?: string;
}
export interface ActionsResponse {
  readonly actions: readonly ActionRow[];
  readonly total: number;
}

interface ContactRow {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly handle?: string;
  readonly phone?: string;
}
export interface ContactsResponse {
  readonly contacts: readonly ContactRow[];
  readonly total: number;
}

interface VetoRow {
  readonly id: string;
  readonly objectiveId: string;
  readonly scope: string;
  readonly vetoedAt: string;
  readonly reason?: string;
}
export interface VetoesResponse {
  readonly vetoes: readonly VetoRow[];
  readonly total: number;
}

export type ProgressiveAutonomyReviewDecision = "needs-adjustment" | "would-approve" | "would-deny";

export type ProgressiveAutonomyCurrentSource =
  | { readonly state: "exact" }
  | { readonly reason: string; readonly state: "stale" | "unavailable" };

export interface ProgressiveAutonomyReviewOpportunity {
  readonly action: string;
  readonly currentSource: ProgressiveAutonomyCurrentSource;
  readonly evidenceClass: "organic";
  readonly linkedAt: string;
  readonly opportunityId: string;
  readonly ownerUserId: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly shadowAssessment: string;
  readonly shadowRationale: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

export interface ProgressiveAutonomyReviewResponse {
  readonly opportunity: ProgressiveAutonomyReviewOpportunity | null;
  readonly schemaVersion: 1;
}

// Mirrors apps/api's `automation-routes.ts` GET /api/automation/upcoming.
interface UpcomingDigest {
  readonly enabled: boolean;
  readonly hour: number;
  readonly nextAtIso: string;
}
interface UpcomingBudget {
  readonly hourUsed: number;
  readonly hourCap: number;
  readonly dayUsed: number;
  readonly dayCap: number;
}
interface UpcomingScheduledJob {
  readonly id: string;
  readonly label: string;
  readonly nextRunAtIso: string | null;
}
interface UpcomingReminder {
  readonly id: string;
  readonly text: string;
  readonly dueAtIso: string;
}
export interface AutomationUpcomingResponse {
  readonly digest: UpcomingDigest | null;
  readonly budget: UpcomingBudget | null;
  readonly scheduledJobs: readonly UpcomingScheduledJob[];
  readonly nextReminder: UpcomingReminder | null;
}

// Mirrors `apps/api`'s `FlowProjection`/`FlowNode`/`FlowEdge` (flow-projection.ts).
// Duplicated as a plain JSON-shape type — same reason as `CadenceSummary`
// below: apps/web only talks to the API server, never a `@muse/*` package.
export type FlowNodeKind =
  | "trigger.schedule"
  | "action.agent"
  | "action.tool"
  | "output.notify"
  | "output.webhook"
  | "output.record";

export interface FlowNode {
  readonly id: string;
  readonly kind: FlowNodeKind;
  readonly label: string;
  readonly meta: Record<string, string | number | boolean | null>;
}

export interface FlowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly loop?: boolean;
}

export interface FlowProjection {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source: "scheduler";
  readonly nextRunAtIso: string | null;
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
}

export interface FlowsResponse {
  readonly flows: readonly FlowProjection[];
}

// Mirrors `apps/api`'s `PersistedWork`/`WorkOutcome` (works-store.ts, via
// `serializeWork`). Duplicated as a plain JSON-shape type for the same reason
// as `FlowProjection` above — apps/web only talks to the API server.
export interface WorkOutcomeRow {
  readonly atIso: string;
  readonly kind: "used" | "adjusted" | "ignored";
  readonly note?: string;
}

export interface WorkRow {
  readonly id: string;
  readonly name: string;
  readonly goal: string;
  readonly flowIds: readonly string[];
  readonly boardTaskIds: readonly string[];
  readonly threadId?: string;
  readonly status: "active" | "paused" | "done";
  readonly outcomes: readonly WorkOutcomeRow[];
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface WorksResponse {
  readonly works: readonly WorkRow[];
}

// Mirrors the fields of `@muse/scheduler`'s `ScheduledJob` /
// `ScheduledJobInput` / `ScheduledJobUpdateInput` (packages/scheduler/src/index.ts)
// that the Flows edit/create panels actually read or write — duplicated as
// plain string-literal-keyed JSON shapes (never imported: apps/web has no
// `@muse/scheduler` dependency, only talks to the API server). Field-name
// drift against the real server contract is caught by
// `flow-edit-compile.test.ts` asserting these keys as string literals.
export interface ScheduledJobDetail {
  readonly id: string;
  readonly name: string;
  readonly jobType: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly agentPrompt: string | null;
  readonly agentModel: string | null;
  readonly agentSystemPrompt: string | null;
  readonly notificationChannelId: string | null;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
  readonly enabled: boolean;
  /** Present on every job (agent or tool), defaulting to `{}` server-side —
   * only meaningful (non-empty) on a `jobType: "mcp_tool"` action. */
  readonly mcpServerName?: string | null;
  readonly toolName?: string | null;
  readonly toolArguments?: Record<string, unknown>;
  /** Inbound webhook-trigger secret (owner console only); null = webhook off. */
  readonly webhookTriggerToken?: string | null;
}

/** Exact `POST /api/scheduler/jobs` body this view sends to create a flow. A
 * `type` alias (not `interface`): it's passed straight into
 * `ApiClient.post`'s `Record<string, unknown>` body param, and TypeScript
 * only structurally matches an index signature against a fresh object type,
 * not a named `interface`. The action is either an agent prompt OR a
 * scheduled MCP tool call — never both — so the two shapes are a
 * discriminated union on `jobType`. */
export type ScheduledJobCreateBody = {
  readonly name: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly notificationChannelId?: string;
  readonly retryOnFailure: boolean;
  readonly maxRetryCount: number;
  readonly enabled: boolean;
} & (
  | { readonly jobType: "agent"; readonly agentPrompt: string; readonly agentModel?: string; readonly agentSystemPrompt?: string }
  | {
      readonly jobType: "mcp_tool";
      readonly mcpServerName: string;
      readonly toolName: string;
      readonly toolArguments: Record<string, unknown>;
    }
);

/** Exact `PATCH /api/scheduler/jobs/:jobId` body shape this view sends — every
 * field is optional (partial update); `null` clears an optional field. Same
 * `type`-alias reasoning as `ScheduledJobCreateBody` above. */
export type ScheduledJobPatchBody = {
  readonly name?: string;
  readonly cronExpression?: string;
  readonly timezone?: string;
  readonly agentPrompt?: string;
  readonly agentModel?: string | null;
  readonly agentSystemPrompt?: string | null;
  readonly notificationChannelId?: string | null;
  readonly retryOnFailure?: boolean;
  readonly maxRetryCount?: number;
  readonly enabled?: boolean;
  readonly toolArguments?: Record<string, unknown>;
  readonly mcpServerName?: string;
  readonly toolName?: string;
};

// Mirrors `apps/api`'s `GET /api/muse/loopback` response (registerToolsRoutes
// in routes-agent-tools.ts) — the builtin loopback MCP server/tool catalog
// the Builder's tool-flow picker reads. `risk` is omitted on the wire (not
// `null`) when a tool declares none, so it is optional here too.
export interface LoopbackToolRow {
  readonly name: string;
  readonly description: string;
  readonly risk?: "read" | "write" | "execute";
}

export interface LoopbackServerRow {
  readonly name: string;
  readonly description: string;
  readonly optIn: boolean;
  readonly tools: readonly LoopbackToolRow[];
}

export interface LoopbackCatalogResponse {
  readonly servers: readonly LoopbackServerRow[];
  readonly total: number;
}

// Mirrors `@muse/scheduler`'s `CadenceSummary` (server computes it from the
// job's persisted `cronExpression` via `summarizeCadence` — the web never
// re-derives it). Duplicated as a plain JSON-shape type rather than an
// import: `apps/web` intentionally has no `@muse/scheduler` dependency, it
// only talks to the API server.
export type CadenceSummary =
  | { readonly kind: "hourly" }
  | { readonly kind: "interval"; readonly minutes: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekdays"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekly"; readonly weekday: number; readonly hour: number; readonly minute: number }
  | { readonly kind: "custom"; readonly cronExpression: string };

export interface SchedulerJobRow {
  readonly id: string;
  readonly name: string;
  readonly agentPrompt: string | null;
  readonly cronExpression: string;
  readonly cadenceSummary: CadenceSummary;
  readonly enabled: boolean;
  readonly lastRunAt: number | null;
  readonly lastStatus: string | null;
  readonly createdAt: number;
}
export interface SchedulerJobsResponse {
  readonly items: readonly SchedulerJobRow[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

// Mirrors `apps/api`'s `toScheduledJobExecutionResponse` (scheduler-routes.ts) —
// same duplication reasoning as `SchedulerJobRow` above.
export type ScheduledJobExecutionStatus = "SUCCESS" | "FAILED" | "RUNNING" | "SKIPPED";
export interface ScheduledJobExecutionRow {
  readonly id: string;
  readonly jobId: string;
  readonly jobName: string;
  readonly status: ScheduledJobExecutionStatus;
  readonly dryRun: boolean;
  readonly durationMs: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly result: string | null;
  readonly resultPreview: string | null;
  readonly failureReason: string | null;
}
export interface ScheduledJobExecutionsResponse {
  readonly items: readonly ScheduledJobExecutionRow[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

// Mirrors `apps/api`'s `FlowDraftPayload` (flows-draft-compile.ts) —
// `POST /api/flows/draft`'s response. A draft is NEVER auto-created — the
// user still reviews it in the create panel and clicks 만들기.
export interface FlowDraftPayloadRow {
  readonly name: string;
  readonly cronExpression: string;
  readonly prompt: string;
  readonly notifyChannel: string | null;
  readonly retry: boolean;
  readonly action: "agent" | "tool";
  readonly toolServer: string | null;
  readonly toolName: string | null;
  readonly toolArguments: Record<string, unknown>;
}
export interface FlowDraftResponse {
  readonly draft: FlowDraftPayloadRow;
}

// Mirrors `@muse/proactivity`'s `FlowProposal` (pattern-flow-proposal.ts) —
// `GET /api/automation/proposals`'s response. A proposal never creates a
// flow by itself — "흐름 초안 열기" prefills the Builder create panel and
// "사양할게요" (`POST /api/automation/proposals/:id/reject`) permanently
// drops it.
export interface FlowProposalReceiptRow {
  readonly observationCount: number;
  readonly distinctCount: number;
  readonly distinctUnit: "days" | "weeks";
  readonly examples: readonly string[];
  readonly confidence: number;
}
export interface FlowProposalRow {
  readonly id: string;
  readonly title: string;
  readonly suggestionText: string;
  readonly cronExpression: string;
  readonly category: "time-of-day-action" | "weekly-task";
  readonly receipt: FlowProposalReceiptRow;
}
export interface AutomationProposalsResponse {
  readonly proposals: readonly FlowProposalRow[];
}

interface WeaknessView {
  axis: string;
  topic: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  hint: string | null;
  pKnown: number | null;
}

export interface WeaknessesResponse {
  total: number;
  entries: WeaknessView[];
}

interface PlaybookStrategyView {
  id: string;
  text: string;
  tag: string | null;
  origin: string | null;
  reward: number;
  probation: boolean;
  timesObserved: number;
  source: string | null;
  createdAt: string;
}

export interface PlaybookStrategiesResponse {
  total: number;
  entries: PlaybookStrategyView[];
}

interface SkillView {
  name: string;
  description: string;
  source: string;
  reward: number;
  avoided: boolean;
}

export interface SkillsResponse {
  total: number;
  entries: SkillView[];
}

export interface JourneyEventView {
  at: string;
  storeKind: "fact" | "skill" | "strategy";
  eventKind: "learned" | "updated" | "superseded" | "forgotten" | "skill" | "strategy";
  content: string;
  ref?: string;
}

export interface JourneyResponse {
  total: number;
  events: JourneyEventView[];
}

export interface UserMemoryResponse {
  readonly facts?: Record<string, string>;
  readonly preferences?: Record<string, string>;
  readonly recentTopics?: readonly string[];
  readonly updatedAt?: string;
}

interface MessagingProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly local?: boolean;
}
export interface MessagingProvidersResponse {
  readonly providers: readonly MessagingProvider[];
}

export interface MessagingSetupProvider {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly configured: boolean;
  readonly registered: boolean;
  readonly source: "env" | "file" | null;
  readonly pairedOwner?: string;
  /** One-time pairing code to send to the bot — present only while configured AND unpaired. */
  readonly pairingCode?: string;
}
export interface ThreadPickRow {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
}
export interface ThreadsResponse {
  readonly threads: readonly ThreadPickRow[];
}
export interface MessagingSetupResponse {
  readonly providers: readonly MessagingSetupProvider[];
}
export interface DayRhythmPairedChannel {
  readonly providerId: string;
  readonly destination: string;
}
export interface DayRhythmStateResponse {
  readonly enabled: boolean;
  readonly morningHour: number;
  readonly eveningHour: number;
  readonly pairedChannel: DayRhythmPairedChannel | null;
}
export interface MessagingConnectResponse {
  readonly ok: boolean;
  readonly account?: string;
  readonly reason?: string;
}
export interface EmailStatusResponse {
  readonly configured: boolean;
  readonly method: "oauth" | "imap" | "env" | null;
  readonly hasRefreshToken?: boolean;
  /** `true` when a stored OAuth record exists but is marked invalid (revoked/expired refresh token) — `muse setup email` reauth clears it. */
  readonly needsReauth?: boolean;
}
interface InboundMessage {
  readonly id?: string;
  readonly from?: string;
  readonly text?: string;
  readonly receivedAt?: string;
}
export interface InboxResponse {
  readonly inbound: readonly InboundMessage[];
  readonly providerId: string;
  readonly total: number;
}

interface DaemonFlagView {
  key: string;
  label: string;
  enabled: boolean;
  running?: boolean;
  lastIngestAtIso?: string;
  lastError?: string;
}
export interface DaemonFlagsResponse {
  flags: DaemonFlagView[];
}

export interface QuietHoursSettingsResponse {
  readonly enabled: boolean;
  readonly range?: string;
  readonly effectiveRange?: string;
  readonly source: "env" | "persisted" | "none";
}

export interface OrchestrationEntry {
  readonly runId: string;
  readonly mode: string;
  readonly status: "completed" | "failed";
  readonly workerCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}
export interface OrchestrationsResponse {
  readonly entries: readonly OrchestrationEntry[];
  readonly total: number;
}
export interface OrchestrationStats {
  readonly totalRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly avgDurationMs: number;
  readonly p95DurationMs: number;
  readonly lastRunAt: string | null;
}
export interface SubAgentRunRow {
  readonly runId: string;
  readonly parentRunId?: string;
  readonly status: "running" | "completed" | "failed" | "timed-out" | "cancelled";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly error?: string;
}
export interface SubAgentRunsResponse {
  readonly activeCount: number;
  readonly runs: readonly SubAgentRunRow[];
}
export interface OrchestrateResponse {
  readonly runId?: string;
  readonly mode?: string;
  readonly response?: { readonly output: string };
  readonly results?: readonly { readonly workerId: string; readonly status: string; readonly error?: string }[];
  readonly background?: boolean;
  readonly orchestrationId?: string;
  readonly cancelled?: boolean;
}
export interface SwarmPendingEntry {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly fromPeerId: string;
  readonly receivedAtIso: string;
  readonly label?: string;
}
export interface SwarmPendingResponse {
  readonly entries: readonly SwarmPendingEntry[];
  readonly total: number;
}

export interface DoctorCheck {
  readonly id: string;
  readonly severity: "ok" | "warn" | "error";
  readonly title: string;
  readonly detail: string;
  readonly fix?: { readonly id: string; readonly label: string };
}
export interface DoctorResponse {
  readonly version: string;
  readonly pid: number;
  readonly startedAtIso: string;
  readonly checks: readonly DoctorCheck[];
}

interface ReflectionView {
  id: string;
  insight: string;
  supportCount: number;
  sourceCount: number;
  createdAt: number;
}
export interface ReflectionsResponse {
  total: number;
  entries: ReflectionView[];
}

export interface PromptPersonaFrontmatter {
  readonly register?: string;
  readonly maxWords?: number;
  readonly language?: string;
}

export interface PromptPersonaResponse {
  readonly defaultInEffect: boolean;
  readonly frontmatter: PromptPersonaFrontmatter;
  readonly raw: string;
  readonly parseError?: string;
}

export interface PromptPersonaSaveResponse {
  readonly frontmatter: PromptPersonaFrontmatter;
  readonly raw: string;
  readonly sanitized: boolean;
}

export interface PromptPreviewSegment {
  readonly layer: string;
  readonly text: string;
  readonly section: "stable" | "dynamic";
  readonly readOnly?: boolean;
}

export interface PromptPreviewResponse {
  readonly layers: readonly PromptPreviewSegment[];
  readonly prompt: string;
  readonly surface: string;
}

export interface PromptExperimentResponse {
  readonly current: { readonly answer: string };
  readonly draft: { readonly answer: string };
}
