/**
 * `@muse/autoconfigure` public export surface. This barrel is a curated
 * re-export index only — the runtime-assembly composition root lives in
 * `./runtime-assembly.js`, and every other symbol is re-exported from its
 * owning sibling module. Keep implementation OUT of this file.
 */

// Re-export the auto-extract helpers so downstream packages
// (apps/cli) can run user-memory extraction on chat turns without
// pulling @muse/memory directly.
export {
  extractJsonObject,
  pickAutoExtractSystemPrompt,
  type ExtractionPayload
} from "@muse/memory";

export {
  ConfigurationError,
  createLoopbackMcpToolsFromEnv,
  createMuseRuntimeAssembly,
  requireEnv,
  type ApiServerAssemblyOptions,
  type MuseEnvironment,
  type MuseRuntimeAssembly
} from "./runtime-assembly.js";

export {
  buildActiveContextProvider,
  buildCalendarRegistry,
  buildSkillRegistry,
  buildEpisodicRecallProvider,
  buildInboxContextProvider,
  buildMessagingRegistry,
  buildTelemetryAggregator,
  buildToolFilter,
  buildVoiceRegistry,
  mergeModelKeysFromFile,
  resolveBrowsingFile,
  resolveContactsFile,
  resolveEpisodesFile,
  resolveNoteProvenanceFile,
  resolveFadedMemoriesFile,
  resolveFollowupsFile,
  resolvePatternsFiredFile,
  resolveRecallHitsFile,
  resolveCheckinsFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMatrixInboxFile,
  resolveMatrixSinceFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveNotesDir,
  resolveNotesIndexFile,
  resolveActionLogFile,
  resolvePendingApprovalsFile,
  resolveObjectivesFile,
  resolveRemindersFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveProactiveHistoryFile,
  resolveReminderHistoryFile,
  resolveWeaknessesFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTokenUsageFile,
  resolveCheckpointsDir,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveSuppressedLessonsFile,
  resolveLearningPauseFile,
  resolvePlanCacheFile,
  resolveAuthoredSkillsDir,
  resolveReflectionsFile,
  resolveSkillRewardsFile
} from "./personal-providers.js";

export {
  collectSetupStatusJson,
  countNotes,
  evaluateLocalOnlyPosture,
  evaluateWebEgressStatus,
  readMcpEntryCount,
  readMessagingProviderState,
  readModelKeyState,
  readTaskCount,
  statBytes,
  type LocalOnlyStatusSnapshot,
  type SetupStatusSnapshot,
  type WebEgressStatusSnapshot
} from "./setup-status.js";

export {
  diagnoseExternalMcpConfig,
  diagnoseExternalMcpConfigFile,
  loadExternalMcpConfig,
  parseExternalMcpConfig,
  resolveExternalMcpConfigFile,
  seedExternalMcpServers
} from "./external-mcp-config.js";
export type { ExternalMcpEntryDiagnosis, ExternalMcpEntryStatus } from "./external-mcp-config.js";

export { buildRuntimeToolRegistry, type RuntimeToolRegistryDeps } from "./runtime-tool-registry.js";
export {
  createBudgetedLlmDetector,
  createReviewCommitmentsArm,
  createReviewPreferencesArm,
  createReviewSkillArm,
  type ReviewArmDeps
} from "./background-review-arms.js";

export { createApiServerOptions } from "./api-server-options.js";

export { createGateEmbedder, createOllamaEmbedder } from "./context-engineering-builders.js";

export { distillQueuedCorrections, type DistillQueuedDeps } from "./distill-queue.js";
export { decayContradictedStrategies, type CorrectionSignal, type DecayContradictedDeps, type DecayedStrategy } from "./decay-contradicted.js";

export { createMessagingPollDispatchers, type MessagingPollDispatchers } from "./messaging-poll-dispatchers.js";

export {
  assembleKnowledgeCorpus,
  createKnowledgeEnricher,
  createNotesKnowledgeSearchTool,
  type AssembleKnowledgeCorpusOptions,
  type FeedEntryLike,
  type FeedsKnowledgeSource,
  type KnowledgeEnricherOptions,
  type NotesKnowledgeSearchToolOptions
} from "./knowledge-corpus.js";

export { createOverdueContactsTool, interactionsFromEvents, type EventMentionLike, type OverdueContactsToolDeps } from "./relationship-tool.js";
export { createWeekAgendaTool, groupWeekAgenda, type WeekAgendaInput, type WeekAgendaToolDeps, type WeekDay } from "./week-agenda-tool.js";
export { createTodayBriefTool, composeTodayBrief, type TodayBrief, type TodayBriefInput, type TodayBriefToolDeps } from "./today-brief-tool.js";
export { createDayRecapTool, composeDayRecap, type DayRecap, type DayRecapInput, type DayRecapToolDeps } from "./day-recap-tool.js";
export { createFindItemsTool, findAcrossDomains, type FindDomain, type FindHit, type FindItemsToolDeps, type FindSources } from "./find-items-tool.js";
export { readFeedKnowledgeEntries } from "./feeds-knowledge-source.js";
export { resolveDefaultUserId } from "./user-id.js";

export { resolveFeedsFile } from "./personal-providers.js";
export { aggregateTokenUsage, readLocalTokenUsage, type TokenUsageGroup, type TokenUsageSummary } from "@muse/observability";
export { createUsageRecordingProvider } from "./usage-recording-provider.js";
export { FileCheckpointStore } from "@muse/runtime-state";

export { describeOfficialMcpPosture, type OfficialMcpPresetPosture } from "./official-mcp-posture.js";

/**
 * Resolve the default model identifier the runtime should use. Honors
 * `MUSE_MODEL` / `MUSE_DEFAULT_MODEL` first; when neither is set,
 * falls back to a sensible default inferred from whichever provider
 * API key is present in the environment. Returns undefined only when
 * no signal at all is available.
 *
 * Personal-JARVIS UX: a user who exports `GEMINI_API_KEY` once and
 * runs `node apps/api/dist/index.js` should get a working chat
 * endpoint without having to also set `MUSE_MODEL`.
 */
export { createModelProvider, createModelProviderFor, LOCAL_FIRST_DEFAULT_MODEL, LOCAL_FIRST_VISION_MODEL, resolveAnswerTemperature, resolveDefaultModel, resolveVisionModel } from "./autoconfigure-model-provider.js";

export {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseOptionalString
} from "./env-parsers.js";

// The single source of truth for the AgentRuntime's live trim budget, so a
// context-preview surface (e.g. the chat `/compact` command) computes from
// the SAME options the real runtime uses and never drifts out of sync.
export { buildContextWindowOptions } from "./runtime-wiring.js";
