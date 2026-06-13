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
  COMMITMENT_DEDUP_COSINE,
  collapseNearDuplicateCommitments,
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
export { inboxGroundingSources } from "./context-transforms.js";
export { applyClarifyDirective, detectUnderspecifiedRequest } from "./clarify-directive.js";
export {
  applyAmbientContext,
  renderAmbientContextSection,
  resolveAmbientSnapshot
} from "./ambient-context.js";
export type { AmbientSnapshot, AmbientSnapshotProvider } from "./ambient-context.js";
export { applyVetoAvoidance, renderVetoAvoidanceSection, selectRelevantVetoes } from "./veto-avoidance.js";
export type { LearnedVeto, VetoAvoidanceProvider } from "./veto-avoidance.js";
export { applyPlaybook, clampReward, effectiveStrategyReward, isAvoidedStrategy, isInjectableStrategy, planStrategyLifecycle, PLAYBOOK_AVOID_BELOW, PLAYBOOK_RECENCY_HALF_LIFE_DAYS, PLAYBOOK_REWARD_MAX, PLAYBOOK_REWARD_MIN, rankPlaybookStrategies, rankPlaybookStrategiesByRelevance, recencyDiscount, renderPlaybookSection, strategyTextSimilarity, wilsonInterval } from "./playbook.js";
export type { PlaybookStrategy, PlaybookProvider, RankPlaybookOptions, StrategyLifecycleAction } from "./playbook.js";
export { classifyCorrectionContradiction, detectApprovals, detectCorrections, distillStrategyFromCorrection } from "./correction-distiller.js";
export { synthesizePatternSuggestion, type PatternSuggestionInput, type SynthesizePatternSuggestionOptions } from "./pattern-suggestion.js";
export { inferPreferenceFromCorrection, parseInferredPreference, type InferredPreference, type InferPreferenceOptions } from "./preference-inference.js";
export type {
  ApprovalExchange,
  ClassifyContradictionOptions,
  CorrectionExchange,
  CorrectionPolarity,
  DetectCorrectionsOptions,
  DistilledStrategy,
  DistillStrategyOptions
} from "./correction-distiller.js";

export { detectSkillCandidates, draftSkillFromSignal, parseConstrainedSkillDraft, reviewSkillsFromTurns, skillDraftConstraintViolations } from "./skill-review.js";
export { mergeSkillsIntoUmbrella, type MergeSkillsOptions } from "./skill-merge.js";
export { validateMergeCoverage, validateUmbrellaCoverage, type CoverageItem, type MergeCoverageVerdict, type UmbrellaCoverageVerdict, type ValidateUmbrellaOptions } from "./skill-merge-gate.js";
export { comparableScript, dominantScriptFamily, type ScriptFamily } from "./script-family.js";
export { clusterByTextSimilarity, deltaMergePlaybookStrategies, mergePlaybookStrategies, type MergePlaybookOptions } from "./playbook-merge.js";
export type { SkillReviewSignal, SkillDraft, DetectSkillCandidatesOptions, DraftSkillOptions, ReviewSkillsOptions, ReviewSkillsResult } from "./skill-review.js";

export {
  buildNoteLinkGraph,
  personalizedPageRank,
  type NoteLinkGraph,
  type PageRankOptions
} from "./associative-recall.js";
export {
  applyLateralInhibition,
  cosineSimilarity,
  EPISODIC_INHIBITION_STRENGTH,
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
  citedSourcesIn,
  groundedOnUntrustedOnly,
  decideRecallClarification,
  bm25Scores,
  createKnowledgeSearchTool,
  detectEvidenceContradictions,
  edgeLoadByRelevance,
  enforceAnswerCitations,
  explainGroundingVerdict,
  fuseByReciprocalRank,
  lexicalOverlap,
  lexicalTokens,
  normalizeContactCitations,
  normalizeFromPrefixedCitations,
  normalizeMemoryCitations,
  normalizeSlotCitations,
  annotateNoteChunks,
  nearestHeading,
  rankKnowledgeChunks,
  rankKnowledgeChunksWithHop,
  renderKnowledgeMatches,
  reorderForLongContext,
  buildGroundingReverifyPrompt,
  parseGroundingReverifyJson,
  parseGroundingReverifyVerdict,
  REVERIFY_RESPONSE_FORMAT,
  REVERIFY_SYSTEM_PROMPT,
  segmentClaims,
  selectBestGroundedDraft,
  selectByMarginalValue,
  selectByScoreGap,
  selectByMmr,
  verifyGrounding,
  verifyGroundingPerClaim,
  verifyGroundingWithReverify,
  type AllowedCitations,
  type BestGroundedDraft,
  type CitationEnforcement,
  type GroundingExplanationOptions,
  judgeConsensus,
  type GroundingReverify,
  type GroundingReverifyInput,
  type JudgeConsensusMode,
  type GroundingRubric,
  type GroundingVerdict,
  type GroundingVerification,
  type ContradictionPair,
  type KnowledgeChunk,
  type PerClaimRefinement,
  type PerClaimVerdict,
  type KnowledgeMatch,
  type KnowledgeSearchToolOptions,
  type RankKnowledgeOptions,
  type RecallClarification,
  type RetrievalConfidence,
  type VerifyGroundingOptions,
  assessContextSufficiency,
  type SufficiencyVerdict
} from "./knowledge-recall.js";
export {
  reportCitationPrecision,
  DEFAULT_CITATION_PRECISION_FLOOR,
  type CitationPrecisionPair,
  type CitationPrecisionReport
} from "./citation-precision.js";
export {
  reportCitationRecall,
  DEFAULT_CITATION_RECALL_FLOOR,
  type CitationRecallReport
} from "./citation-recall.js";
export {
  scoreGroundingEval,
  type GroundingCaseOutcome,
  type GroundingEvalCase,
  type GroundingEvalCorpus,
  type GroundingEvalDeps,
  type GroundingEvalKind,
  type GroundingEvalResult,
  type GroundingGroupTally
} from "./grounding-eval.js";
export {
  buildAttributedRepairPrompt,
  repairToEvidence,
  REPAIR_SYSTEM_PROMPT,
  type AttributedRepairDeps,
  type AttributedRepairPromptInput,
  type AttributedRepairResult
} from "./attributed-repair.js";
export { actionToolRan, answerClaimsAction, answerPromisesAction, classifyActionRequest, classifyCasualPrompt, classifyContactLookup, classifyCorpusOverview, classifyMetaPrompt, classifyReminderListQuery, classifyTaskListQuery, requestsToolAction, type CasualPromptKind } from "./casual-prompt.js";
export { calibrateAbstention, calibrateAbstentionByGroup, conformalThreshold, empiricalCoverage, type CalibrationResult, type GroupCalibrationResult, type GroupedScore } from "./conformal.js";
export { DEFAULT_QUORUM, independentWitnessCount, quorumVerdict, type QuorumVerdict } from "./quorum.js";
export { overdueContacts, type ContactInteractions, type OverdueContact, type OverdueOptions } from "./relationship-decay.js";
export { selectEarnedThemes, type EarnedProactivityOptions, type EarnedTheme, type ThemeOccurrence, type ThemeSignal } from "./earned-proactivity.js";
export { dailyCounts, mostAnomalousDays, type AnomalyOptions, type DayAnomaly, type DayCount } from "./activity-anomaly.js";
export { openLoops, type OpenLoop, type OpenLoopOptions, type TaskLike } from "./open-loops.js";
export { detectChangePoint, type ChangePoint, type ChangePointOptions } from "./change-point.js";
export { peakEndDigest, type DigestTurn } from "./peak-end.js";
export {
  createConfidenceGatedInvestigator,
  decideProactiveRecall,
  type ConfidenceGatedInvestigatorDeps,
  type ProactiveRecallDecision
} from "./proactive-recall-gate.js";
export {
  buildReflectionUserMessage,
  parseReflections,
  REFLECTION_GROUNDING_QUERY,
  synthesizeReflections,
  verifyReflectionsGrounding,
  type Reflection,
  type ReflectionInput,
  type SynthesizeReflectionsOptions
} from "./reflection-synthesis.js";
export {
  abstainIfUngrounded,
  buildCouncilPrompt,
  buildDebateQuestion,
  COSINE_ABS_FLOOR,
  councilMemberSupports,
  councilMemberSupportsSemantic,
  dedupeUtterancesByPeer,
  DEFAULT_COUNCIL_AGREE_AT,
  DEFAULT_COUNCIL_AGREE_AT_COSINE,
  hasCouncilConsensus,
  hasCouncilConsensusSemantic,
  parseCouncilAnswer,
  produceCouncilReasoning,
  produceGroundedCouncilReasoning,
  QUESTION_RELEVANCE_FLOOR,
  rankUtterancesBySupport,
  screenCouncilOutliers,
  screenOffTopicUtterancesSemantic,
  synthesizeCouncilAnswer,
  verifyCouncilGrounding,
  type CouncilAbstentionOptions,
  type CouncilAnswer,
  type CouncilModelOptions,
  type CouncilScreenResult,
  type CouncilUtterance,
  type OutlierScreenOptions,
  type RelevanceScreenOptions,
  type RelevanceScreenResult
} from "./council.js";
export {
  DEFAULT_ROLES,
  defaultShouldOrchestrate,
  orchestrateAnswer,
  type OrchestratedAnswer,
  type OrchestrateOptions,
  type OrchestrationProposal,
  type OrchestrationRole
} from "./orchestrate.js";
export {
  aggregateVerifierVotes,
  DEFAULT_ASPECT_VERIFIERS,
  type AspectVerifier,
  type ScoredCandidate
} from "./verifier-vote.js";
export {
  A2A_MAX_CONTENT_CHARS,
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
  DEFAULT_EPISODE_GROUNDING_FLOOR,
  extractCurrentSessionTurns,
  redactSecrets,
  summariseSession,
  summaryGroundedInTranscript,
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
  selectRelevantSkills,
  type SkillCatalogEntry,
  type SkillCatalogProvider
} from "./skills-context.js";
export {
  measureSystemPromptBudget,
  measureSystemPromptText,
  promptBudgetSpanAttributes,
  enforceSystemPromptBudget,
  type PromptBudgetEnforcement,
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
  DEFAULT_CLAIM_SUPPORT_FLOOR,
  screenClaimsBySemanticSupport,
  type ClaimSupportScreen
} from "./claim-support-screen.js";

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

export { groundToolArguments, type ToolArgumentGrounding } from "./tool-argument-grounding.js";

export { describeImage, extractStructuredFromImage, type VisionDescribeInput, type VisionDescribeResult, type VisionExtractInput, type VisionExtractResult } from "./vision-extract.js";

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
  dedupeNearDuplicateSteps,
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
export { renderPlanExemplar, selectPlanExemplar, selectPlanExemplarByRelevance, selectSuccessfulPlanSteps } from "./plan-cache.js";
export type { CachedPlan, PlanCacheProvider, SelectPlanExemplarOptions } from "./plan-cache.js";

export {
  DEFAULT_SENTENCE_GROUNDING_FLOOR,
  reportSentenceGroundedness,
  worstUnsupportedSentence,
  type GroundednessReport,
  type SentenceGroundedness,
  type SentenceGroundednessLabel
} from "./sentence-groundedness.js";

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
export { renderToolExemplarSection, selectToolExemplars, type ToolExemplar } from "./tool-exemplars.js";
export { summarizeTokenConfidence, type TokenConfidenceSummary } from "./token-confidence.js";
export { baseLevelActivation, computeActivationBoost } from "./actr-activation.js";
export { adjustConfidenceFloor, sdtCriterion, summarizeNoticeResponses, type NoticeResponseStats } from "./sdt-criterion.js";
export { splitCompoundQuery } from "./compound-query.js";
