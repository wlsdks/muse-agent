import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool, ToolRisk } from "@muse/tools";

import type { McpSecurityPolicyProvider } from "./in-memory-stores.js";

export type Awaitable<T> = T | Promise<T>;
export type McpTransportType = "stdio" | "sse" | "streamable" | "http";
export type McpServerStatus = "pending" | "connecting" | "connected" | "disconnected" | "failed" | "disabled";
export type McpHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface McpServer {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transportType: McpTransportType;
  readonly config: JsonObject;
  readonly version?: string;
  readonly autoConnect: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpServerInput {
  readonly id?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly transportType: McpTransportType;
  readonly config?: JsonObject;
  readonly version?: string | null;
  readonly autoConnect?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface McpServerStore {
  list(): Awaitable<readonly McpServer[]>;
  findByName(name: string): Awaitable<McpServer | undefined>;
  save(input: McpServerInput): Awaitable<McpServer>;
  update(name: string, input: McpServerInput): Awaitable<McpServer | undefined>;
  delete(name: string): Awaitable<void>;
}

export interface McpSecurityPolicy {
  readonly allowedServerNames: readonly string[];
  readonly maxToolOutputLength: number;
  readonly allowedStdioCommands: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface McpSecurityPolicyInput {
  readonly allowedServerNames?: readonly string[];
  readonly maxToolOutputLength?: number;
  readonly allowedStdioCommands?: readonly string[];
}

export interface McpSecurityPolicyStore {
  getOrNull(): Awaitable<McpSecurityPolicy | undefined>;
  save(input: McpSecurityPolicyInput): Awaitable<McpSecurityPolicy>;
  delete(): Awaitable<boolean>;
}

export interface McpRemoteTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly risk?: ToolRisk;
  /**
   * Context Engineering Phase 4 hint. When set, `createMcpMuseTool`
   * forwards this to `MuseToolDefinition.domain` so DefaultToolFilter
   * skips the name-prefix heuristic. Loopback servers tag their tools
   * explicitly; external MCP servers usually don't supply this and
   * fall back to the heuristic as before.
   */
  readonly domain?: string;
  /**
   * Relevance keywords forwarded to `MuseToolDefinition.keywords` so
   * DefaultToolFilter surfaces this specific tool when the prompt
   * mentions one of them — letting a loopback tool be selectable for
   * vocabulary its domain heuristic misses (e.g. availability for "am
   * I free?"). Per-tool, so a generic word only exposes THIS tool, not
   * the whole domain.
   */
  readonly keywords?: readonly string[];
  /**
   * Free-text argument names that must be GROUNDED in the user's utterance,
   * forwarded to `MuseToolDefinition.groundedArgs`. The runtime drops any such
   * arg the model fabricated (an 8B invents a calendar `location`/`notes` the
   * user never said). Loopback actuator tools set this; external MCP tools
   * usually don't.
   */
  readonly groundedArgs?: readonly string[];
}

export interface McpConnection {
  listTools(): Awaitable<readonly McpRemoteTool[]>;
  callTool?(toolName: string, args: JsonObject): Awaitable<string | JsonValue>;
  close?(): Awaitable<void>;
}

export interface McpTransportConnector {
  connect(server: McpServer, policy: McpSecurityPolicy): Promise<McpConnection>;
}

export interface DefaultMcpTransportConnectorOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly stderr?: StdioServerParameters["stderr"];
  /**
   * Filesystem paths exposed to MCP servers via the `roots/list`
   * request. When provided, the client advertises the `roots`
   * capability and answers server-issued `roots/list` calls with
   * these paths as `file://` URIs. When undefined or empty, the
   * client still advertises the capability (so spec-compliant MCP
   * servers stop logging `Client does not support MCP Roots`
   * warnings and fall back to argv-based directories) but returns
   * an empty roots list.
   *
   * Personal-JARVIS default: empty. The user opts in via
   * `MUSE_MCP_CLIENT_ROOTS` (comma-separated absolute paths) when
   * a specific external MCP server (filesystem, search, etc.)
   * needs broader directory access than its launch args allow.
   */
  readonly clientRoots?: readonly string[];
}

export interface McpServerValidationOptions {
  readonly allowPrivateAddresses?: boolean;
}

export interface McpManagerOptions {
  readonly connector?: McpTransportConnector;
  readonly reconnect?: Partial<McpReconnectPolicy>;
  readonly securityPolicyProvider?: McpSecurityPolicyProvider;
  readonly store?: McpServerStore;
  readonly validation?: McpServerValidationOptions;
  readonly now?: () => Date;
}

export interface McpReconnectPolicy {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface McpHealthSnapshot {
  readonly serverName: string;
  readonly status: McpHealthStatus;
  readonly checkedAt?: Date;
  readonly error?: string;
  readonly reconnectAttempts: number;
  readonly nextReconnectAt?: Date;
  readonly toolCount: number;
}

export type McpPreflightCheckStatus = "pass" | "warn" | "fail";

export interface McpPreflightCheck {
  readonly code: string;
  readonly message: string;
  readonly status: McpPreflightCheckStatus;
}

export interface McpPreflightReport {
  readonly checks: readonly McpPreflightCheck[];
  readonly health: McpHealthSnapshot;
  readonly ok: boolean;
  readonly readyForProduction: boolean;
  readonly serverName: string;
  readonly status: McpServerStatus;
  readonly summary: {
    readonly failCount: number;
    readonly passCount: number;
    readonly warnCount: number;
  };
}

export interface InMemoryMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly maxServers?: number;
  readonly now?: () => Date;
}

export interface InMemoryMcpSecurityPolicyStoreOptions {
  readonly initial?: McpSecurityPolicyInput;
  readonly now?: () => Date;
}

export interface KyselyMcpServerStoreOptions {
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export interface KyselyMcpSecurityPolicyStoreOptions {
  readonly now?: () => Date;
}

// In-memory stores + normalizers + error classes live in
// `./in-memory-stores.ts`. Kysely-backed stores live in
// `./server-stores.ts`. Re-export both so external call-sites
// stay byte-identical.
export {
  InMemoryMcpServerStore,
  InMemoryMcpSecurityPolicyStore,
  McpSecurityPolicyProvider,
  McpRegistryError,
  McpConnectionError,
  isRetryableMcpConnectStatus,
  normalizeMcpServerInput,
  normalizeMcpSecurityPolicy,
  normalizeReconnectPolicy
} from "./in-memory-stores.js";

// McpManager runtime registry lives in `./manager.ts`.
export { McpManager } from "./manager.js";

// Transport connector + SDK connection adapter live in `./transport.ts`.
export { DefaultMcpTransportConnector } from "./transport.js";

// Kysely-backed persistence lives in `./server-stores.ts`.
export { KyselyMcpSecurityPolicyStore, KyselyMcpServerStore } from "./server-stores.js";

export {
  isPrivateOrReservedHost,
  isPublicHttpUrl,
  validateMcpServer,
  validateStdioArgs,
  validateStdioCommand
} from "./validators.js";

export function createMcpMuseTool(serverName: string, tool: McpRemoteTool, connection: McpConnection): MuseTool {
  return {
    definition: {
      description: tool.description,
      ...(tool.domain ? { domain: tool.domain } : {}),
      ...(tool.keywords && tool.keywords.length > 0 ? { keywords: tool.keywords } : {}),
      ...(tool.groundedArgs && tool.groundedArgs.length > 0 ? { groundedArgs: tool.groundedArgs } : {}),
      inputSchema: tool.inputSchema ?? {},
      name: `${serverName}.${tool.name}`,
      risk: tool.risk ?? "read"
    },
    execute: async (args) => {
      if (!connection.callTool) {
        return `Error: MCP tool '${tool.name}' is not callable`;
      }

      try {
        return await connection.callTool(tool.name, args);
      } catch (error) {
        // A mid-session callTool rejection (auth expired → 401, server
        // 500, request timeout, an SDK throw) MUST surface to the agent
        // as a clear, actionable error — never escape unhandled (which
        // would crash the tool loop on a non-ToolExecutor consumer) and
        // never be silently read as an empty/successful result (a
        // grounding hole: the model would report "no results" when the
        // call actually FAILED). Redact secrets first: the SDK's HTTP
        // error message can echo the request's `Authorization: Bearer
        // <token>` header, which must never reach the model or a log.
        return `Error: MCP tool '${tool.name}' failed: ${redactMcpSecrets(toMcpErrorMessage(error))}`;
      }
    }
  };
}

function toMcpErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactMcpSecrets(message: string): string {
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

// Row builders + mappers live in `./server-stores.ts`.
export {
  createMcpSecurityPolicyInsert,
  createMcpServerInsert,
  createMcpServerUpdate,
  mapMcpSecurityPolicyRow,
  mapMcpServerRow
} from "./server-stores.js";

export {
  computeAvailability,
  type AvailabilityResult,
  type AvailabilityEventLike,
  type BusyBlock,
  type FreeSlot
} from "@muse/mcp-shared";
export { formatDueLocal } from "@muse/mcp-shared";
export * from "./loopback-helpers.js";
export * from "./provider-routing.js";
export {
  createCryptoMcpServer,
  createDiffMcpServer,
  createJsonMcpServer,
  createLoopbackMcpConnection,
  createLoopbackMcpMuseTools,
  createMathMcpServer,
  evaluateArithmeticExpression,
  createRegexMcpServer,
  createTextUtilsMcpServer,
  createTimeMcpServer,
  createUrlMcpServer,
  type BuiltinLoopbackOptions,
  type LoopbackMcpServer,
  type LoopbackMcpToolDefinition
} from "./loopback.js";

export { gateProactiveNoticeSink, isQuietHour, parseQuietHours, type QuietHourRange } from "@muse/proactivity";
export {
  appendCheckins,
  buildCheckinQuestion,
  cancelCheckin,
  readCheckins,
  runDueCheckins,
  scheduleCheckins,
  selectDueCheckins,
  snoozeCheckin,
  writeCheckins,
  type CancelCheckinResult,
  type CheckinMutationReason,
  type CheckinSendRegistry,
  type CheckinStatus,
  type PersistedCheckin,
  type RunDueCheckinsOptions,
  type RunDueCheckinsSummary,
  type ScheduleCheckinsOptions,
  type SnoozeCheckinResult
} from "@muse/proactivity";

export {
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  chromeDevToolsToolRisk,
  createChromeDevToolsMcpServer,
  withChromeDevToolsRisk,
  type ChromeDevToolsMcpOptions
} from "./chrome-devtools-mcp.js";

export {
  GITHUB_MCP_SERVER_NAME,
  LINEAR_MCP_SERVER_NAME,
  NOTION_MCP_SERVER_NAME,
  OFFICIAL_MCP_PRESETS,
  SENTRY_MCP_SERVER_NAME,
  createGitHubMcpServer,
  createLinearMcpServer,
  createNotionMcpServer,
  createSentryMcpServer,
  githubMcpToolRisk,
  linearMcpToolRisk,
  notionMcpToolRisk,
  resolveOfficialMcpPreset,
  sentryMcpToolRisk,
  withOfficialMcpRisk,
  type OfficialMcpPreset,
  type OfficialMcpPresetOptions
} from "./official-mcp-presets.js";

export {
  createChromeSnapshot,
  createFileSnapshot,
  createHttpSnapshot,
  createWebWatchRunner,
  detectWatchTrigger,
  parseWatchRule,
  webWatchesFromConfig,
  type ChromeSnapshotConnection,
  type WatchRule,
  type WatchTrigger,
  type WebWatch,
  type WebWatchRunner
} from "@muse/proactivity";

export {
  createAmbientNoticeRunner,
  deriveAmbientNotices,
  FileAmbientSignalSource,
  knowledgeAmbientQuery,
  parseAmbientNoticeRules,
  runAmbientNoticeTick,
  type AmbientNotice,
  type AmbientNoticeRunner,
  type AmbientNoticeRule,
  type AmbientSignal,
  type AmbientSignalSource,
  type KnowledgeAmbientTrigger,
  type RunAmbientNoticeTickOptions,
  type RunAmbientNoticeTickSummary
} from "@muse/proactivity";
export {
  MacOsActiveWindowSource,
  parseActiveWindowSignal,
  type MacOsActiveWindowSourceOptions
} from "@muse/proactivity";
export { sendWithRetry, type SendWithRetryOptions } from "@muse/mcp-shared";

// Notes provider abstraction. LocalDir, Apple Notes (osascript), and
// Notion (api.notion.com) are all real adapters. The `muse.notes-multi`
// MCP server in `loopback-notes-registry.ts` routes between them via
// providerId.

// Tasks registry MCP server. Companion to muse.tasks
// (filesystem-only) — exposes `muse.tasks-multi.*` against any
// composed TasksProviderRegistry.

// Relative-time phrase resolver (originally loopback-tasks-only).
// Re-exported so HTTP routes can mirror the MCP tool's dueAt parsing
// rather than duplicate semantics.
export { resolveRelativeTimePhrase } from "@muse/mcp-shared";

// Personal task store — pure data layer shared between the MCP tool,
// the REST routes, and the CLI's --local mode.
export {
  compareTasksByDueDate,
  parseTaskDueAt,
  readTasks,
  readTaskStatusFilter,
  resolveTaskRef,
  resolveTasksDueLine,
  selectTasksDueWithin,
  serializeTask,
  writeTasks,
  type DueTask,
  type PersistedTask,
  type TaskRefResolution,
  type TaskStatusFilter
} from "@muse/stores";

// Personal followups store — agent-self-followup design doc step 2.
// The detector (`extractFollowupPromises` in @muse/agent-core)
// produces typed promises; this layer persists them to
// `~/.muse/followups.json` so the firing daemon (later step) can
// pick them up and honour them.
export {
  cancelFollowup,
  cleanupFollowupTempFiles,
  compareFollowupsByScheduledFor,
  markFollowupFired,
  readFollowups,
  readFollowupStatusFilter,
  serializeFollowup,
  snoozeFollowup,
  upsertFollowup,
  writeFollowups,
  type FollowupStatus,
  type FollowupStatusFilter,
  type PersistedFollowup
} from "@muse/stores";
export {
  addObjective,
  patchObjective,
  readObjectives,
  serializeObjective,
  writeObjectives,
  type ObjectiveKind,
  type ObjectiveStatus,
  type StandingObjective
} from "@muse/stores";
export {
  isProposalActionable,
  patchProposedActionStatus,
  proposeMessageAction,
  readProposedActions,
  writeProposedActions,
  type ProposedAction,
  type ProposedActionKind,
  type ProposedActionStatus
} from "@muse/stores";
export {
  confirmProposedAction,
  declineProposedAction,
  type ConfirmOutcome,
  type ConfirmProposedActionOptions,
  type DeclineProposedActionOptions
} from "@muse/proactivity";
export {
  runDueObjectives,
  type ObjectiveEvaluation,
  type RunDueObjectivesOptions,
  type RunDueObjectivesSummary
} from "@muse/proactivity";
export {
  findConsent,
  hasConsent,
  readConsents,
  recordConsent,
  serializeConsent,
  writeConsents,
  type ScopedConsent
} from "@muse/stores";
export {
  performConsentedAction,
  type ConsentedActionOutcome,
  type ConsentedActionRequest,
  type PerformConsentedActionOptions
} from "@muse/proactivity";
export {
  ACTION_LOG_GENESIS_HASH,
  appendActionLog,
  computeEntryHash,
  decryptActionLogAtRest,
  encryptActionLogAtRest,
  isActionLogEncrypted,
  queryActionLog,
  readActionLog,
  serializeActionLogEntry,
  verifyActionLogChain,
  verifyActionLogChainFile,
  type ActionLogChainVerification,
  type ActionLogEntry,
  type ActionResult
} from "@muse/stores";
export {
  hasVeto,
  queryVetoes,
  readVetoes,
  recordVeto,
  removeVeto,
  serializeVeto,
  writeVetoes,
  type ActionVeto
} from "@muse/stores";
export {
  adjustPlaybookReward,
  bumpPlaybookObservation,
  decayStalePlaybookRewards,
  decryptPlaybookAtRest,
  encryptPlaybookAtRest,
  isPlaybookEncrypted,
  MAX_PLAYBOOK_ENTRIES,
  PLAYBOOK_DECAY_STALE_DAYS,
  PLAYBOOK_REWARD_MAX,
  PLAYBOOK_REWARD_MIN,
  queryPlaybook,
  readPlaybook,
  recordPlaybookStrategy,
  removePlaybookStrategy,
  retainPlaybookEntries,
  writePlaybook,
  type PlaybookEntry
} from "@muse/stores";
export {
  isLearningPaused,
  readLearningPauseState,
  setLearningPaused,
  type LearningPauseState
} from "@muse/stores";
export {
  incrementSuppressionBlocked,
  MAX_SUPPRESSED_LESSONS,
  querySuppressedLessons,
  readSuppressedLessons,
  recordSuppressedLesson,
  writeSuppressedLessons,
  type SuppressedLesson
} from "@muse/stores";
export {
  adjustSkillReward,
  isSkillAvoided,
  readSkillRewards,
  SKILL_AVOID_BELOW,
  SKILL_REWARD_MAX,
  SKILL_REWARD_MIN
} from "@muse/stores";
export {
  MAX_PLAN_CACHE_ENTRIES,
  queryPlanCache,
  readPlanCache,
  recordPlanTemplate,
  writePlanCache,
  type PlanCacheEntry,
  type PlanCacheStep
} from "@muse/stores";
export {
  composeSituationalBriefing,
  resolveDayShapeLine,
  type BriefingImminent,
  type SituationalBriefingInput
} from "@muse/proactivity";
export {
  deriveBriefingImminent,
  deriveCalendarBriefingImminent,
  type BriefingCalendarEvent,
  type BriefingCalendarLister
} from "@muse/proactivity";
export {
  fetchWithRetry,
  isRetriableStatus,
  parseRetryAfterMs,
  type RetryOptions
} from "@muse/mcp-shared";
export {
  addContact,
  contactIdentifier,
  decryptContactsAtRest,
  encryptContactsAtRest,
  formatBirthdayBriefLine,
  isContactsEncrypted,
  linkContacts,
  queryContacts,
  readContacts,
  removeContact,
  resolveContact,
  resolveUpcomingBirthdays,
  serializeContact,
  writeContacts,
  type Contact,
  type ContactResolution,
  type UpcomingBirthday
} from "@muse/stores";
export {
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  createProposingObjectiveActuator,
  parseObjectiveVerdict,
  type MessagingObjectiveActuatorOptions,
  type ModelObjectiveEvaluatorOptions
} from "@muse/proactivity";
export {
  undoLoggedAction,
  type UndoLoggedActionOptions,
  type UndoLoggedActionResult
} from "@muse/proactivity";

// LLM-fallback budget tracker — step 5 of agent-self-followup.md.
// Per-day counter so MUSE_FOLLOWUP_LLM_FALLBACK=true can't
// silently burn the user's quota.
export {
  formatLocalDay as formatFollowupLlmBudgetDay,
  incrementFollowupLlmBudget,
  isFollowupLlmBudgetExhausted,
  readFollowupLlmBudget,
  writeFollowupLlmBudget,
  type FollowupLlmBudgetRecord
} from "@muse/stores";

// Pattern-detection cooldown sidecar — step 4 of
// docs/design/pattern-detection.md. Tracks the last firing time
// per detector-assigned pattern id so a fired suggestion does not
// re-spam the user within MUSE_PROACTIVE_PATTERN_COOLDOWN_MS.
export {
  dismissPattern,
  isPatternDismissed,
  isPatternOnCooldown,
  readPatternsFired,
  recordPatternFired,
  writePatternsFired,
  type PatternFiredRecord
} from "@muse/stores";

export {
  readFadedMemoryKeys,
  readRecallHits,
  recordRecallHits,
  writeFadedMemoryKeys,
  writeRecallHits,
  type RecallHitInput,
  type RecallHitRecord
} from "@muse/stores";

// Pattern-detection firing engine — wiring half of step 4. The
// `apps/api/src/pattern-tick.ts` setInterval rider drives this on
// MUSE_PROACTIVE_PATTERN_TICK_MS; the engine itself is pure data
// over the messaging registry + cooldown sidecar so tests skip the
// daemon entirely.
export {
  runDuePatternNotices,
  type RunDuePatternNoticesOptions,
  type RunDuePatternNoticesSummary
} from "@muse/proactivity";
export { type AgentInitiatedNoticeBrokerLike } from "@muse/proactivity";

export {
  appendSurfaced,
  avoidedSourceKeys,
  computeTrustScore,
  isSourceAvoided,
  readTrustLedger,
  recordOutcome,
  sourceKey,
  withinDailyCap,
  type ProactiveOutcome,
  type TrustLedgerEntry,
  type TrustScore
} from "@muse/stores";

export {
  addToQuarantine,
  listPending,
  readQuarantine,
  setQuarantineStatus,
  type AddToQuarantineInput,
  type QuarantineStatus,
  type SwarmQuarantineEntry
} from "@muse/stores";

export {
  addReflections,
  listReflections,
  readReflections,
  scoreReflectionRetention,
  selectReflectionsForRecall,
  selectRetainedReflections,
  type NewReflection,
  type ReflectionRetentionOptions,
  type StoredReflection
} from "@muse/stores";

// Episodic memory store — step 1 of docs/design/episodic-memory.md.
// Pure CRUD over `~/.muse/episodes.json`; later steps add the
// session-boundary sentinel, end-of-session summariser hook,
// persona surfacing, and `muse episode` CLI.
export {
  clearEpisodes,
  computeEpisodeRetention,
  decryptEpisodesAtRest,
  detectTopicAbsence,
  encryptEpisodesAtRest,
  isEpisodesEncrypted,
  planEpisodeConsolidation,
  readEpisodes,
  recurringThemes,
  removeEpisode,
  selectRetainedEpisodes,
  serializeEpisode,
  upsertEpisode,
  vacuumEpisodes,
  writeEpisodes,
  type EpisodeConsolidation,
  type EpisodeRetentionOptions,
  type EpisodeTheme,
  type PersistedEpisode,
  type TopicAbsence
} from "@muse/stores";

// Note-family absence — the filesystem counterpart to topic-absence: a folder
// of notes the user used to update regularly that has gone silent vs its own
// cadence. Surfaced in the evening recap's "gone quiet" section.
export {
  detectNoteFamilyAbsence,
  type NoteActivityEvent,
  type NoteFamilyAbsence
} from "@muse/proactivity";

// Reusable encryption-at-rest for the function-based JSON stores — AES-256-GCM
// envelope + the user-memory key, cross-process locked, fail-closed migration.
export {
  decryptFileAtRest,
  encryptFileAtRest,
  isFileEncryptedAtRest,
  readMaybeEncrypted,
  withFileLock,
  writeMaybeEncrypted,
  type EncryptAtRestOptions
} from "@muse/stores";

// Self-followup firing engine — step 4 of agent-self-followup.md.
// Re-enters the model to compose the delivery message, sends via
// the messaging registry, marks the entry fired.
export {
  runDueFollowups,
  type RunDueFollowupsOptions,
  type RunDueFollowupsSummary
} from "@muse/proactivity";

// Personal reminders store — passive reminder list shared between
// the REST routes, the CLI, and `muse today` (both surfaces).
export {
  compareRemindersByDueAt,
  filterReminders,
  fireReminder,
  nextReminderOccurrence,
  normalizeReminderRecurrence,
  parseReminderDueAt,
  parseReminderVia,
  resolveReminderRef,
  type ReminderRefResolution,
  readReminders,
  readReminderStatusFilter,
  serializeReminder,
  writeReminders,
  type PersistedReminder,
  type ReminderRecurrence,
  type ReminderStatusFilter,
  type ReminderVia
} from "@muse/stores";

export {
  BKT_GUESS,
  BKT_LEARN,
  BKT_PRIOR,
  BKT_SLIP,
  WEAKNESS_MASTERED_AT,
  WEAKNESS_MASTERY_RETENTION_DAYS,
  bktUpdate,
  askTimeWeaknessNudge,
  isMasteredWeakness,
  readWeaknesses,
  recordTimeParseWeakness,
  recordWeakness,
  recordWeaknessResolved,
  remediationHint,
  renderAskTimeNudge,
  selectDevFixableWeaknesses,
  selectRemediableWeaknesses,
  topicKeyFromMessage,
  upsertWeakness,
  writeWeaknesses,
  type AskTimeNudge,
  type DevFixableWeakness,
  type RemediableWeakness,
  type WeaknessAxis,
  type WeaknessEntry
} from "@muse/stores";
export {
  analyzeRunOutcomes,
  type RunOutcomeEntry,
  type RunOutcomeSummary,
  type RunOutcomeTopic
} from "@muse/proactivity";

export {
  appendReminderHistory,
  readReminderHistory,
  type AppendReminderHistoryOptions,
  type ReminderHistoryEntry
} from "@muse/stores";

// Phase B firing engine — see docs/design/reminder-firing.md. The
// CLI's `muse remind run` and a future scheduler hook share this.
export {
  runDueReminders,
  type RunDueRemindersOptions,
  type RunDueRemindersSummary
} from "@muse/proactivity";

// Proactive surfacing (Phase A — calendar imminence, Phase B —
// tasks due-soon). See docs/design/proactive-surfacing.md.
export {
  readProactiveFired,
  readSessionLock,
  runDueProactiveNotices,
  selectProactiveSink,
  sortImminentByStart,
  writeProactiveFired,
  writeSessionLock,
  type ProactiveActivitySource,
  type ProactiveAgentRuntimeLike,
  type ProactiveFiredEntry,
  type ProactiveFiredKind,
  type ProactiveModelProviderLike,
  type ProactiveNoticeSink,
  type ProactiveSinkChoice,
  type RunDueProactiveNoticesOptions,
  type RunDueProactiveNoticesSummary,
  type SessionLockPayload
} from "@muse/proactivity";
export {
  appendProactiveHistory,
  readProactiveHistory,
  rotateProactiveHistoryFiles,
  type AppendProactiveHistoryOptions,
  type ProactiveHistoryEntry
} from "@muse/stores";

// Outbound messaging loopback (Phase 3 of docs/design/messaging.md):
// the LLM can call `muse.messaging.{providers, send}` once the user
// has wired any provider via env tokens.

// Reminders loopback — the LLM can add/list/clear reminders against
// the same `~/.muse/reminders.json` the CLI / REST surface uses.
// Read-only at fire time; passive surfacing through `muse today`.

// Followup loopback — agent introspection + control over its own
// self-captured follow-up promises. List/cancel/snooze only; capture
// is automatic via the runtime hook, firing is daemon-only.

// Episode loopback — agent introspection over prior-session
// summaries. List / search / show / remove / clear; capture is
// automatic via the REPL exit hook, never agent-issued.

// Pattern loopback — agent-driven audit + cooldown reset. The
// daemon stays the sole firer (no `fire`/`record` tool here).

// Proactive surfacing audit loopback — `muse.proactive.history`
// over ~/.muse/proactive-history.json.

// JARVIS self-observability loopback — `muse.status.snapshot` for
// external clients (Codex / Claude Desktop) to read persona +
// tasks + last notice + trust in one structured call.

// Unified activity-feed loopback — `muse.history.recent` merges
// the five personal audit stores so an agent can answer
// "what did you do for me?" in one call instead of fanning out
// across muse.reminders.history / muse.proactive.history / etc.

// Underlying helper, exported so the CLI's `muse history` command
// shares the merge logic instead of duplicating it.

// Dashboard summarizers shared between the `muse.status.snapshot`
// MCP tool and the `muse status` CLI command — keeps the two
// surfaces' coverage from drifting.

// Context reference MCP server (Context Engineering 1.d
// foundation). `muse.context.fetch` / `muse.context.list` against an
// in-process ContextReferenceStore.

// Tasks provider abstraction. Mirrors the notes-providers
// pattern.

export {
  DEFAULT_LEASE_STALE_MS,
  acquireOllamaLease,
  isOllamaLeaseHeldByOther,
  releaseOllamaLease,
  resolveOllamaLeaseFile
} from "@muse/stores";

export {
  MAX_LEARN_QUEUE_EVENTS,
  enqueueLearnEvent,
  markLearnEventsDone,
  readPendingLearnEvents,
  resolveLearnQueueFile,
  type LearnCorrectionEvent
} from "@muse/stores";
