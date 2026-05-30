export type {
  AgentContextWindowReport,
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentSpecResolver,
  AgentSpecRunReport,
  Awaitable,
  GuardDecision,
  GuardStage,
  HookStage,
  LlmClassificationInputGuardOptions,
  OutputGuardContext,
  OutputGuardDecision,
  OutputGuardStage,
  ResponseFilterContext,
  ResponseFilterStage,
  UserMemoryInjectionOptions,
  UserMemoryProvider,
  UserMemorySnapshot,
  VerifiedSource
} from "./types.js";

// Context Engineering surfaces (Phases 1–4)
export {
  DefaultActiveContextProvider,
  renderActiveContextSection,
  type ActiveContextProvider,
  type ActiveContextResolveOptions,
  type ActiveContextSnapshot,
  type ActiveTaskHint,
  type ActiveTaskResolver,
  type CalendarEventHint,
  type CalendarEventsResolver,
  type DefaultActiveContextProviderOptions,
  type ReminderHint,
  type RemindersResolver
} from "./active-context.js";
export {
  InMemoryAgentInitiatedNoticeBroker,
  type AgentInitiatedNotice,
  type AgentInitiatedNoticeBroker,
  type InMemoryAgentInitiatedNoticeBrokerOptions
} from "./agent-initiated-notice.js";
export {
  extractFollowupPromises,
  type ExtractFollowupPromisesOptions,
  type FollowupPromise
} from "./followup-detector.js";
export {
  detectUserCommitments,
  type CommitmentKind,
  type DetectUserCommitmentsOptions,
  type UserCommitment
} from "./commitment-detector.js";
export {
  createFollowupCaptureHook,
  sanitizeFollowupSummary,
  type CapturedFollowup,
  type FollowupCaptureHookOptions
} from "./followup-capture-hook.js";
export {
  BACKGROUND_REVIEW_HOOK_ID,
  createBackgroundReviewHook,
  createInMemoryReviewCounterStore,
  evaluateReviewTriggers,
  type BackgroundReviewHookOptions,
  type BackgroundReviewInput,
  type ReviewCounters,
  type ReviewCounterStore,
  type ReviewDecision,
  type ReviewTriggerConfig
} from "./background-review.js";
export {
  extractFollowupPromisesLlm,
  type ExtractFollowupPromisesLlmOptions
} from "./followup-llm-detector.js";
export {
  formatCurrentTime,
  humanizeRelativeFromIso,
  humanizeRelativeMs,
  isWorkingHours,
  parseWorkingHoursString,
  resolveTimezone,
  type FormattedTime
} from "./time-helpers.js";
export {
  renderInboxSection,
  type InboundSummary,
  type InboxContextProvider,
  type InboxSnapshot
} from "./inbox-context.js";
export { applyClarifyDirective, detectUnderspecifiedRequest } from "./clarify-directive.js";
export {
  applyAmbientContext,
  renderAmbientContextSection,
  resolveAmbientSnapshot
} from "./ambient-context.js";
export type { AmbientSnapshot, AmbientSnapshotProvider } from "./ambient-context.js";
export { applyVetoAvoidance, renderVetoAvoidanceSection } from "./veto-avoidance.js";
export type { LearnedVeto, VetoAvoidanceProvider } from "./veto-avoidance.js";
export { applyPlaybook, rankPlaybookStrategies, renderPlaybookSection, strategyTextSimilarity } from "./playbook.js";
export type { PlaybookStrategy, PlaybookProvider, RankPlaybookOptions } from "./playbook.js";
export { detectCorrections, distillStrategyFromCorrection } from "./correction-distiller.js";
export { synthesizePatternSuggestion, type PatternSuggestionInput, type SynthesizePatternSuggestionOptions } from "./pattern-suggestion.js";
export { inferPreferenceFromCorrection, parseInferredPreference, type InferredPreference, type InferPreferenceOptions } from "./preference-inference.js";
export type {
  CorrectionExchange,
  DetectCorrectionsOptions,
  DistilledStrategy,
  DistillStrategyOptions
} from "./correction-distiller.js";

export { detectSkillCandidates, draftSkillFromSignal, parseConstrainedSkillDraft, reviewSkillsFromTurns, skillDraftConstraintViolations } from "./skill-review.js";
export { mergeSkillsIntoUmbrella, type MergeSkillsOptions } from "./skill-merge.js";
export { clusterByTextSimilarity, mergePlaybookStrategies, type MergePlaybookOptions } from "./playbook-merge.js";
export type { SkillReviewSignal, SkillDraft, DetectSkillCandidatesOptions, DraftSkillOptions, ReviewSkillsOptions, ReviewSkillsResult } from "./skill-review.js";

export {
  cosineSimilarity,
  EmbeddingEpisodicRecallProvider,
  InMemoryEpisodicRecallProvider,
  renderEpisodicSection,
  StoreBackedEpisodicRecallProvider,
  type EmbeddingEpisodicRecallProviderOptions,
  type EpisodicMatch,
  type EpisodicRecallProvider,
  type EpisodicRecallSnapshot,
  type InMemoryEpisodicRecallProviderOptions,
  type StoreBackedEpisodicRecallProviderOptions,
  type StoredEpisode,
  type SummaryListSource
} from "./episodic-recall.js";
export {
  applyOverlap,
  chunkText,
  classifyRetrievalConfidence,
  createCachingEmbedder,
  createKnowledgeSearchTool,
  edgeLoadByRelevance,
  rankKnowledgeChunks,
  renderKnowledgeMatches,
  reorderForLongContext,
  selectByMmr,
  type KnowledgeChunk,
  type KnowledgeMatch,
  type KnowledgeSearchToolOptions,
  type RankKnowledgeOptions,
  type RetrievalConfidence
} from "./knowledge-recall.js";
export {
  createConfidenceGatedInvestigator,
  decideProactiveRecall,
  type ConfidenceGatedInvestigatorDeps,
  type ProactiveRecallDecision
} from "./proactive-recall-gate.js";
export {
  buildReflectionUserMessage,
  parseReflections,
  synthesizeReflections,
  type Reflection,
  type ReflectionInput,
  type SynthesizeReflectionsOptions
} from "./reflection-synthesis.js";
export {
  buildCouncilPrompt,
  buildDebateQuestion,
  parseCouncilAnswer,
  produceCouncilReasoning,
  synthesizeCouncilAnswer,
  type CouncilAnswer,
  type CouncilModelOptions,
  type CouncilUtterance
} from "./council.js";
export {
  A2ASafetyError,
  classifyInbound,
  isA2AEnabled,
  prepareOutbound,
  type A2AEnvelope,
  type A2AOutbound,
  type A2APayloadKind,
  type InboundDecision,
  type InboundDisposition
} from "./a2a-safety.js";
export {
  extractCurrentSessionTurns,
  redactSecrets,
  summariseSession,
  type CurrentSessionRange,
  type SessionBoundaryRef,
  type SessionSummary,
  type SessionTurnLine,
  type SummariseSessionOptions
} from "./episodic-summariser.js";
export {
  DefaultToolFilter,
  DEFAULT_DOMAIN_KEYWORDS,
  inferDomain,
  type ToolFilter,
  type ToolFilterContext
} from "./tool-filter.js";
export {
  applyAttachmentContext,
  parseAttachmentsFromMetadata,
  renderAttachmentSection,
  type AttachmentHint
} from "./attachment-context.js";
export {
  applySkillsContext,
  renderSkillsCatalogSection,
  type SkillCatalogEntry,
  type SkillCatalogProvider
} from "./skills-context.js";
export {
  measureSystemPromptBudget,
  measureSystemPromptText,
  promptBudgetSpanAttributes,
  type PromptBudgetReport,
  type PromptBudgetSection
} from "./prompt-budget.js";
export {
  InMemoryTelemetryAggregator,
  type InMemoryTelemetryAggregatorOptions,
  type RunTelemetryEvent,
  type TelemetryAggregator,
  type TelemetryRecentOptions,
  type TelemetrySummary,
  type TelemetrySummaryOptions
} from "./telemetry-aggregator.js";

export {
  StepBudgetTracker,
  type BudgetStatus,
  type StepBudgetRecord,
  type StepBudgetTrackerOptions
} from "./step-budget.js";

export {
  ToolCallDeduplicator,
  stableJson,
  type ToolCallDeduplicationDecision,
  type ToolCallDuplicate,
  type ToolCallNotDuplicate
} from "./tool-call-deduplicator.js";

export {
  createAgentCheckpointState,
  decodeCheckpointMessages,
  encodeCheckpointMessages,
  resumeRunInputFromCheckpoint
} from "./checkpoint.js";
export type { AgentCheckpointState } from "./checkpoint.js";

export { GuardBlockedError, ModelRoutingError, OutputGuardBlockedError } from "./errors.js";

export {
  MAX_PLAN_STEPS,
  PlanExecutionError,
  PlanValidationFailedError,
  extractJsonArray,
  parsePlan,
  validatePlan,
  type PlanExecutionErrorCode,
  type PlanStep,
  type PlanValidationError,
  type PlanValidationInput,
  type PlanValidationResult,
  type StepExecutionResult
} from "./plan-execute.js";
export { renderPlanExemplar, selectPlanExemplar } from "./plan-cache.js";
export type { CachedPlan, PlanCacheProvider, SelectPlanExemplarOptions } from "./plan-cache.js";

export { HookRegistry } from "./hook-registry.js";

export {
  AgentRuntime,
  createAgentRuntime,
  type AgentRuntimeOptions,
  type AgentRuntimeStreamEvent,
  type ToolApprovalGate,
  type ToolApprovalGateDecision,
  type ToolApprovalGateInput,
  type ToolRiskLevel
} from "./agent-runtime.js";

export {
  createInjectionInputGuard,
  createLlmClassificationInputGuard,
  createPiiInputGuard,
  createPiiMaskingOutputGuard,
  createSystemPromptLeakageOutputGuard,
  createTopicDriftInputGuard
} from "./guards.js";

export {
  createCasualLureStripResponseFilter,
  createEnglishCasualLureStripResponseFilter,
  createEnglishGreetingStripResponseFilter,
  createFabricationRequestRefusalFilter,
  createGreetingStripResponseFilter,
  createMarkdownStripResponseFilter,
  createMaxLengthResponseFilter,
  createResponseCountConsistencyFilter,
  createResponseCountInjectionFilter,
  createSanitizedTextResponseFilter,
  createSourceBlockResponseFilter,
  createStructuredOutputResponseFilter,
  createToolResultQualityAuditFilter,
  createVerifiedSourcesResponseFilter,
  createZeroResultOverclaimResponseFilter
} from "./response-filters.js";

export { sanitiseCitations, type SanitiseCitationsResult } from "./citation-sanitiser.js";
export { applyCitationSanitisation, buildModelRequestWithWebSearch } from "./model-invocation.js";
