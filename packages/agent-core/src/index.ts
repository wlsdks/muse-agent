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
  createFollowupCaptureHook,
  sanitizeFollowupSummary,
  type CapturedFollowup,
  type FollowupCaptureHookOptions
} from "./followup-capture-hook.js";
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
export { applyPlaybook, renderPlaybookSection } from "./playbook.js";
export type { PlaybookStrategy, PlaybookProvider } from "./playbook.js";

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
  chunkText,
  createCachingEmbedder,
  createKnowledgeSearchTool,
  rankKnowledgeChunks,
  renderKnowledgeMatches,
  type KnowledgeChunk,
  type KnowledgeMatch,
  type KnowledgeSearchToolOptions,
  type RankKnowledgeOptions
} from "./knowledge-recall.js";
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
