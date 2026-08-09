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
  continuityRuntimeSourceId,
  createConfiguredContinuityAttuneGraphProjector,
  projectConfiguredContinuityAttuneGraphCurrentState,
  readConfiguredContinuityShadowReturns,
  type ProjectConfiguredContinuityAttuneGraphInput,
  type ReadConfiguredContinuityShadowReturnsInput
} from "./continuity-attunegraph-composition.js";

export type { ShadowReturnInspectionReport } from "@muse/attunegraph/continuity-shadow-returns";

export {
  createContinuityCapsulePreparationService,
  CONTINUITY_CAPSULE_PREPARATION_SERVICE_LIMITS,
  type ContinuityCapsulePreparationRequest,
  type ContinuityCapsulePreparationService,
  type ContinuityCapsulePreparationServiceResult,
  type CreateContinuityCapsulePreparationServiceOptions
} from "./continuity-capsule-preparation-service.js";

export {
  createContinuityLearningPreparationService,
  type ContinuityLearningEvaluator,
  type ContinuityLearningEvaluatorInput,
  type ContinuityLearningHeldOutCase,
  type ContinuityLearningPreparationRequest,
  type ContinuityLearningPreparationResult,
  type ContinuityLearningPreparationService,
  type CreateContinuityLearningPreparationServiceOptions
} from "./continuity-learning-preparation-service.js";

export {
  createContinuityLearningPolicyCardPreviewService,
  type ContinuityLearningPolicyCardPreviewInput,
  type ContinuityLearningPolicyCardPreviewService,
  type CreateContinuityLearningPolicyCardPreviewServiceOptions
} from "./continuity-learning-policy-card-preview-service.js";

export {
  createOwnerTaughtPolicyCardPreviewService,
  type CreateOwnerTaughtPolicyCardPreviewServiceOptions,
  type OwnerTaughtPolicyCardPreviewInput,
  type OwnerTaughtPolicyCardPreviewResult,
  type OwnerTaughtPolicyCardPreviewService
} from "./owner-taught-policy-card-preview-service.js";

export {
  ContinuityResumeBaselineFileStore,
  ContinuityResumeBaselineFileStoreUnavailableError
} from "./continuity-resume-baseline-file-store.js";

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
  resolveAttunementFile,
  resolveBrowsingFile,
  resolveContactsFile,
  resolveContinuityResumeBaselinesFile,
  resolveEpisodesFile,
  resolveNoteProvenanceFile,
  resolveFadedMemoriesFile,
  resolveFollowupTriageFile,
  resolveFollowupsFile,
  resolveInterruptionLedgerFile,
  resolveDigestQueueFile,
  resolveDigestSentFile,
  resolveLastProactiveDeliveryFile,
  resolvePatternsFiredFile,
  resolveRejectedProposalsFile,
  resolveRecallHitsFile,
  resolveFactRecallHitsFile,
  resolveCheckinsFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveLocalCalendarFile,
  resolveMatrixInboxFile,
  resolveMatrixSinceFile,
  resolveMessagingCredentialsFile,
  resolveModelKeysFile,
  resolveMuseCliConfigFilePath,
  resolveOAuthStoreDir,
  resolveNotesDir,
  resolveNotesIndexFile,
  resolveActionLogFile,
  resolvePendingApprovalsFile,
  resolveObjectivesFile,
  resolveBriefingSidecarFile,
  resolveRemindersFile,
  resolveDiscordAfterFile,
  resolveDiscordInboxFile,
  resolveProactiveHistoryFile,
  resolveProgressiveAutonomyFile,
  resolveProgressiveAutonomyOpportunitiesFile,
  resolveReconfirmCardAnsweredFile,
  resolveReconfirmCardDeliveryFile,
  resolveReminderHistoryFile,
  resolveReminderTriageFile,
  resolveWeaknessesFile,
  resolveSessionLockFile,
  resolveSlackAfterFile,
  resolveSlackInboxFile,
  resolveTasksFile,
  resolveTokenUsageFile,
  resolveUserMemoryAutoExtractOutcomesFile,
  resolveCheckpointsDir,
  resolveTelegramInboxFile,
  resolveTelegramOffsetFile,
  resolveVetoesFile,
  resolvePlaybookFile,
  resolveSuppressedLessonsFile,
  resolveLearningPauseFile,
  resolveQualificationLearningHoldFile,
  resolvePlanCacheFile,
  resolveAuthoredSkillsDir,
  resolveReflectionsFile,
  resolveSkillRewardsFile,
  resolveSkillUsageFile,
  resolveWorksFile
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
  createQualificationLearningActiveSkillWriteGate,
  createQualificationLearningWriteGate,
  QualificationLearningWriteBlockedError
} from "./qualification-learning-active-skill-write-gate.js";
export type {
  QualificationLearningWriteBlockReason,
  QualificationLearningWriteGate
} from "./qualification-learning-active-skill-write-gate.js";

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
  toTriggerSchedulerTerminalReceipt
} from "./trigger-lineage-execution-adapter.js";

export {
  createProgressiveAutonomyToolOpportunityObserver,
  observeProgressiveAutonomyToolOpportunity,
  type ProgressiveAutonomyToolOpportunityObserverOptions
} from "./progressive-autonomy-runtime-observer.js";

export {
  createProgressiveAutonomyRuntimeDecisionRecorder,
  type ProgressiveAutonomyRuntimeDecisionRecorder
} from "./progressive-autonomy-runtime-decision-recorder.js";

export {
  ProgressiveAutonomyOpportunityReviewService,
  type ProgressiveAutonomyCurrentSource,
  type ProgressiveAutonomyOpportunityReviewPresentation,
  type ProgressiveAutonomyOpportunityReviewServiceOptions
} from "./progressive-autonomy-opportunity-review.js";

export {
  activeModelEnvOverride,
  fetchInstalledOllamaModels,
  readMuseCliConfigFile,
  resolveModelSwitchTarget,
  resolveOllamaBaseUrl,
  writeMuseCliDefaultModel,
  type InstalledOllamaModel,
  type ModelEnvOverride,
  type ModelSwitchResolution,
  type MuseCliDefaultModelConfig,
  type OllamaModelsResult
} from "./model-registry.js";
export {
  createBudgetedLlmDetector,
  createReviewCommitmentsArm,
  createReviewPreferencesArm,
  createReviewSkillArm,
  type ReviewArmDeps
} from "./background-review-arms.js";

export {
  BackgroundModelExecutionBudgetError,
  DEFAULT_BACKGROUND_MODEL_MAX_CONCURRENCY,
  DEFAULT_BACKGROUND_MODEL_MAX_INPUT_BYTES,
  DEFAULT_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_BACKGROUND_MODEL_MAX_QUEUE,
  DEFAULT_FOREGROUND_MODEL_MAX_CONCURRENCY,
  DEFAULT_FOREGROUND_MODEL_MAX_QUEUE,
  DEFAULT_FOREGROUND_MODEL_QUEUE_TIMEOUT_MS,
  backgroundModelExecutionBudgetEnvironment,
  createBackgroundModelExecutionBudgetProviders,
  resolveBackgroundModelExecutionBudgetOptions,
  type BackgroundModelExecutionBudgetErrorCode,
  type BackgroundModelExecutionBudgetOptions,
  type BackgroundModelExecutionBudgetProviders,
  type BackgroundModelExecutionBudgetSnapshot,
  type ResolvedBackgroundModelExecutionBudgetOptions
} from "./background-model-execution-budget.js";

export {
  CrossProcessModelExecutionLeaseError,
  crossProcessModelExecutionLeaseEnvironment,
  createCrossProcessModelExecutionLeaseProviders,
  resolveCrossProcessModelExecutionLeaseOptions,
  type CrossProcessModelExecutionLeaseErrorCode,
  type CrossProcessModelExecutionLeaseProviders,
  type CrossProcessModelExecutionLeaseSnapshot,
  type ResolvedCrossProcessModelExecutionLeaseOptions
} from "./cross-process-model-execution-lease.js";

export {
  ACTUATOR_MODES,
  DEFAULT_ACTUATOR_MODE,
  isActuatorMode,
  normalizeActuatorConfig,
  readActuatorConfig,
  readActuatorConfigSafe,
  resolveActuatorMode,
  writeActuatorConfig,
  type ActuatorConfig,
  type ActuatorMode
} from "./actuator-mode.js";

export {
  DAY_RHYTHM_DEFAULT_EVENING_HOUR,
  DAY_RHYTHM_DEFAULT_MORNING_HOUR,
  normalizeDayRhythmConfig,
  readDayRhythmConfig,
  readDayRhythmConfigSafe,
  writeDayRhythmConfig,
  type DayRhythmConfig
} from "./day-rhythm-config.js";

export {
  PAIRABLE_MESSAGING_PROVIDER_IDS,
  inspectPairedChannels,
  readChannelOwner,
  resolveProactiveMessagingRoute,
  resolveSinglePairedChannel,
  type PairedChannel,
  type PairedChannelInspection,
  type MessagingRouteRegistry,
  type MessagingRouteResolution,
  type ResolveProactiveMessagingRouteOptions
} from "./paired-channel.js";

export {
  createApiServerOptions,
  type CreateApiServerOptionsOptions
} from "./api-server-options.js";

export {
  collectDeliveryQueueSnapshot,
  collectDeliverySafety,
  collectDeliverySafetyDiagnostic,
  inspectDeliverySafetyBacklog,
  type DeliveryQueueAgeBucket,
  type DeliveryQueueAgeObservation,
  type DeliveryQueueSnapshot,
  type DeliveryQueueSnapshotDependencies,
  type DeliverySafetyCollectorDependencies,
  type DeliverySafetyDiagnostic,
  type DeliverySafetyProviderLockDiagnostic,
  type DeliverySafetyProviderResolutionSource,
  type DeliverySafetyTextInspection
} from "./delivery-safety.js";

export {
  resolveIntegrationEnvironment,
  type IntegrationMessagingProviderId,
  type ResolvedIntegrationEnvironment,
  type ResolvedMessagingProviderEnvironment
} from "./integration-environment.js";

export {
  resolveHomeAssistantEnvironment,
  type ResolvedHomeAssistantEnvironment,
  type ResolveHomeAssistantEnvironmentOptions
} from "./home-assistant-environment.js";

export { createGateEmbedder, createOllamaEmbedder, recordFactRecallHits } from "./context-engineering-builders.js";

export { distillQueuedCorrections, type DistillQueuedDeps } from "./distill-queue.js";
export { decayContradictedStrategies, type CorrectionSignal, type DecayContradictedDeps, type DecayedStrategy } from "./decay-contradicted.js";

export { createMessagingPollDispatchers, type MessagingPollDispatchers } from "./messaging-poll-dispatchers.js";

export {
  assembleKnowledgeCorpus,
  createKnowledgeEnricher,
  createNotesKnowledgeSearchTool,
  parseMemoryFactKey,
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
export {
  createLocalModelContextAdmissionProviders,
  localModelContextAdmissionEnvironment,
  LocalModelContextAdmissionError,
  resolveLocalModelContextAdmissionOptions,
  resolveOllamaContextWindowTokens,
  type LocalModelContextAdmissionOptions,
  type LocalModelContextAdmissionProviders,
  type LocalModelContextAdmissionSnapshot
} from "./local-model-context-admission.js";
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
export {
  createModelProvider,
  createModelProviderFor,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_LOCAL_VISION_MODEL,
  resolveAnswerTemperature,
  admitAuxiliaryModel,
  resolveAuxiliaryModel,
  resolveDefaultModel,
  resolveModelFallbackChain,
  resolveModelProvider,
  resolveVisionModel,
  type AuxiliaryModelAdmission,
  type AuxiliaryModelResolution,
  type AuxiliaryTask,
  type ModelFallbackChainResolution,
  type ModelProviderResolution
} from "./autoconfigure-model-provider.js";

export {
  parseBoolean,
  parseCsv,
  parseInteger,
  parseNonNegativeInteger,
  parseOptionalString
} from "./env-parsers.js";

// The single source of truth for the AgentRuntime's live trim budget, so a
// context-preview surface (e.g. the chat `/compact` command) computes from
// the SAME options the real runtime uses and never drifts out of sync.
export { buildContextWindowOptions } from "./runtime-wiring.js";
