// Curated public surface: named exports only, one block per module,
// limited to symbols actually consumed via "@muse/stores" (or this
// barrel) outside their defining module — internal-only helpers stay
// unexported. See packages/agent-core/src/index.ts for the house style.

export { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";
export {
  readDaemonSettingsSync,
  readQuietHoursSettingSync,
  resolveDaemonSettingsFile,
  UnsupportedDaemonSettingsFormatError,
  writeDaemonSetting,
  writeQuietHoursSetting
} from "./daemon-settings-store.js";
export type { DaemonSettings, PersistedQuietHours } from "./daemon-settings-store.js";
export {
  CHAT_CONTEXT_TURN_LIMIT,
  defaultConversationsFile,
  FileConversationStore,
  InMemoryConversationStore,
  MAX_TURNS_PER_CONVERSATION,
  newConversationId,
  recentChatTurns,
  resolveConversationRef
} from "./conversation-store.js";
export type { Conversation, ConversationRefResolution, ConversationSummary, ConversationTurn } from "./conversation-store.js";
export { defaultActiveConversationFile, readActiveConversationId, writeActiveConversationId } from "./conversation-active-pointer.js";
export { appendDigestItem, drainDigestQueue, readDigestQueue } from "./digest-queue.js";
export type { DigestQueueItem } from "./digest-queue.js";
export { digestAlreadySentToday, localDateKey, markDigestSent, readDigestSentDate } from "./digest-sent-store.js";
export type { DigestSentState } from "./digest-sent-store.js";
export { DIGEST_LOCK_STALE_MS, withDigestLock, withProcessLock } from "./digest-lock.js";
export type { DigestLockOutcome, ProcessLockOutcome } from "./digest-lock.js";
export { decryptFileAtRest, encryptFileAtRest, isFileEncryptedAtRest } from "./encrypted-file.js";
export { withFileLock } from "./encrypted-file.js";
export {
  credentialPath,
  defaultCredentialPath,
  deleteEmailImapCredential,
  deleteGmailCredential,
  deleteStoredToken,
  hasStoredEmailImapCredentialSync,
  hasStoredGmailCredentialSync,
  readEmailImapCredential,
  readEmailImapCredentialSync,
  readGmailCredential,
  readStoredToken,
  writeEmailImapCredential,
  writeGmailCredential,
  writeStoredToken
} from "./encrypted-credentials.js";
export type { CredentialStoreIO, GmailOAuthCredential, ImapEmailCredential } from "./encrypted-credentials.js";
export { quarantineCorruptStore } from "./store-quarantine.js";
export { ageCutoffMs, pruneByAge } from "./retention.js";
export type { PruneByAgeOptions, PruneByAgeResult } from "./retention.js";
export { appendInterruptionDelivery, readInterruptionLedger, withinInterruptionBudget } from "./interruption-budget.js";
export type { InterruptionBudgetCaps, InterruptionDeliveryEntry } from "./interruption-budget.js";
export { appendLastProactiveDelivery, readLastProactiveDeliveries } from "./last-proactive-delivery-store.js";
export type { LastProactiveDeliveryEntry, LastProactiveDeliveryOutcome } from "./last-proactive-delivery-store.js";
export { DEFAULT_JOURNEY_LIMIT, factRecordsFromProvenance, mergeJourneyEvents, resolveJourneyForgetTarget } from "./journey-timeline.js";
export type { JourneyEvent, JourneyEventKind, JourneyFactRecord, JourneyFactValueStep, JourneyForgetTarget, JourneySkillRecord, JourneyStoreKind, JourneyStrategyRecord, MergeJourneyEventsInput } from "./journey-timeline.js";
export { enqueueLearnEvent, markLearnEventsDone, pruneLearnQueueByAge, readPendingLearnEvents, resolveLearnQueueFile } from "./learn-queue.js";
export type { LearnCorrectionEvent } from "./learn-queue.js";
export { isLearningPaused, setLearningPaused } from "./learning-pause-store.js";
export { defaultSchedulerPauseFile, isSchedulerPaused, readSchedulerPauseState, setSchedulerPaused } from "./scheduler-pause-store.js";
export { acquireOllamaLease, isOllamaLeaseHeldByOther, releaseOllamaLease, resolveOllamaLeaseFile } from "./ollama-lease.js";
export { detectUncleanShutdown, markSessionCleanExit, markSessionStart } from "./session-crash-marker.js";
export type { SessionStartInfo } from "./session-crash-marker.js";
export { capBackgroundProcesses, defaultBackgroundProcessesFile, getBackgroundProcess, pruneTerminalBackgroundProcesses, readBackgroundProcesses, registerBackgroundProcess, removeBackgroundProcess, updateBackgroundProcess } from "./background-process-store.js";
export type { BackgroundProcessRecord } from "./background-process-store.js";
export { pidIdentityMatches, reconcileBackgroundProcesses, spawnBackgroundProcess, stopBackgroundProcess } from "./background-process-spawn.js";
export type { BackgroundSpawner, SpawnedChild, StopBackgroundResult } from "./background-process-spawn.js";
export { createNodeBackgroundSpawner } from "./node-background-spawner.js";
export { classifyDaemonLoopHeartbeat, classifyProactiveHeartbeat, defaultProactiveHeartbeatDir, readProactiveHeartbeat, recordProactiveHeartbeat } from "./proactive-heartbeat.js";
export type { DaemonLoopHeartbeatStatus, DaemonLoopHeartbeatThresholds, DaemonLoopHeartbeatVerdict, ProactiveHeartbeat, ProactiveHeartbeatMark, ProactiveHeartbeatSignal, ProactiveHeartbeatStatus, ProactiveHeartbeatThresholds, ProactiveHeartbeatVerdict } from "./proactive-heartbeat.js";
export { appendActionLog, decryptActionLogAtRest, encryptActionLogAtRest, isActionLogEncrypted, pruneActionLogByAge, queryActionLog, readActionLog, serializeActionLogEntry, verifyActionLogChainFile } from "./personal-action-log-store.js";
export type { ActionLogEntry, ActionLogPruneResult, ActionResult } from "./personal-action-log-store.js";
export { findConsent, hasConsent, readConsents, recordConsent } from "./personal-consent-store.js";
export type { ScopedConsent } from "./personal-consent-store.js";
export { addContact, contactIdentifier, decryptContactsAtRest, encryptContactsAtRest, formatBirthdayBriefLine, isContactsEncrypted, linkContacts, mutateContactsWithResult, queryContacts, readContacts, removeContact, resolveContact, resolveUpcomingBirthdays, serializeContact, writeContacts } from "./personal-contacts-store.js";
export type { Contact, ContactMutation } from "./personal-contacts-store.js";
export { clearEpisodes, computeEpisodeRetention, decryptEpisodesAtRest, detectTopicAbsence, encryptEpisodesAtRest, isEpisodesEncrypted, planEpisodeConsolidation, readEpisodes, recurringThemes, removeEpisode, selectRetainedEpisodes, serializeEpisode, upsertEpisode, vacuumEpisodes, writeEpisodes } from "./personal-episodes-store.js";
export type { PersistedEpisode } from "./personal-episodes-store.js";
export { formatLocalDay, incrementFollowupLlmBudget, isFollowupLlmBudgetExhausted, readFollowupLlmBudget } from "./personal-followup-llm-budget-store.js";
export { cancelFollowup, cleanupFollowupTempFiles, compareFollowupsByScheduledFor, markFollowupFired, readFollowups, readFollowupStatusFilter, resolveFollowupRef, serializeFollowup, snoozeFollowup, upsertFollowup, writeFollowups } from "./personal-followups-store.js";
export type { FollowupStatusFilter, PersistedFollowup } from "./personal-followups-store.js";
export { addObjective, patchObjective, readObjectives, serializeObjective, writeObjectives } from "./personal-objectives-store.js";
export type { ObjectiveKind, ObjectiveStatus, StandingObjective } from "./personal-objectives-store.js";
export { dismissPattern, isPatternDismissed, isPatternOnCooldown, readPatternsFired, recordPatternFired, writePatternsFired } from "./personal-patterns-fired-store.js";
export type { PatternFiredRecord } from "./personal-patterns-fired-store.js";
export { queryPlanCache, recordPlanTemplate } from "./personal-plan-cache-store.js";
export { adjustPlaybookReward, bumpPlaybookObservation, decayStalePlaybookRewards, decryptPlaybookAtRest, encryptPlaybookAtRest, isPlaybookEncrypted, queryPlaybook, readPlaybook, recordPlaybookStrategy, removePlaybookStrategy, writePlaybook } from "./personal-playbook-store.js";
export type { PlaybookEntry } from "./personal-playbook-store.js";
export { appendProactiveHistory, readProactiveHistory } from "./personal-proactive-history-store.js";
export type { ProactiveHistoryEntry } from "./personal-proactive-history-store.js";
export { isProposalActionable, patchProposedActionStatus, proposeMessageAction, readProposedActions } from "./personal-proposed-action-store.js";
export { readFadedMemoryKeys, readRecallHits, recordRecallHits, writeFadedMemoryKeys } from "./personal-recall-hits-store.js";
export type { RecallHitRecord } from "./personal-recall-hits-store.js";
export { appendReminderHistory, readReminderHistory } from "./personal-reminder-history-store.js";
export type { ReminderHistoryEntry } from "./personal-reminder-history-store.js";
export { compareRemindersByDueAt, filterReminders, fireReminder, mutateReminders, nextReminderOccurrence, normalizeReminderRecurrence, parseReminderDueAt, parseReminderVia, readReminders, readReminderStatusFilter, resolveReminderRef, serializeReminder, serializeReminderForModel, snoozeReminder, writeReminders } from "./personal-reminders-store.js";
export type { PersistedReminder, ReminderRecurrence } from "./personal-reminders-store.js";
export { compareTasksByDueDate, mutateTasks, parseTaskDueAt, readTaskById, readTaskByIdStrict, readTasks, readTaskStatusFilter, resolveTaskRef, resolveTasksDueLine, selectTasksDueWithin, serializeTask, serializeTaskForModel, TaskStoreUnavailableError, writeTasks } from "./personal-tasks-store.js";
export type { PersistedTask } from "./personal-tasks-store.js";
export { hasVeto, queryVetoes, readVetoes, recordVeto, removeVeto, serializeVeto } from "./personal-veto-store.js";
export type { ActionVeto } from "./personal-veto-store.js";
export {
  readRejectedProposals,
  recordRejectedProposal,
  rejectedProposalIds,
  serializeRejectedProposal,
  writeRejectedProposals
} from "./automation-rejected-proposals-store.js";
export type { RejectedProposal } from "./automation-rejected-proposals-store.js";
export { firedKey, readProactiveFired, readSessionLock, writeProactiveFired, writeSessionLock } from "./proactive-notice-store.js";
export type { ProactiveFiredEntry, ProactiveFiredKind, SessionLockPayload } from "./proactive-notice-store.js";
export { appendSurfaced, avoidedSourceKeys, computeTrustScore, isSourceAvoided, readTrustLedger, recordOutcome, sourceKey, withinDailyCap } from "./proactive-trust-ledger.js";
export type { ProactiveOutcome, TrustLedgerEntry } from "./proactive-trust-ledger.js";
export { addReflections, listReflections, readReflections, selectReflectionsForRecall } from "./reflections-store.js";
export type { NewReflection, StoredReflection } from "./reflections-store.js";
export { adjustSkillReward, isSkillAvoided, readSkillRewards, SKILL_AVOID_BELOW } from "./skill-rewards-store.js";
export { incrementSuppressionBlocked, querySuppressedLessons, readSuppressedLessons, recordSuppressedLesson } from "./suppressed-lessons-store.js";
export { addToQuarantine, buildSwarmSkillDraft, listPending, readQuarantine, setQuarantineStatus } from "./swarm-quarantine-store.js";
export type { SwarmQuarantineEntry } from "./swarm-quarantine-store.js";
export { askTimeWeaknessNudge, isMasteredWeakness, readWeaknesses, recordTimeParseWeakness, recordWeakness, recordWeaknessResolved, remediationHint, renderAskTimeNudge, selectDevFixableWeaknesses, selectRemediableWeaknesses, topicKeyFromMessage } from "./weakness-ledger.js";
export type { AskTimeNudge, DevFixableWeakness, WeaknessEntry } from "./weakness-ledger.js";
export {
  addWorkOutcome,
  createWork,
  decryptWorksAtRest,
  deleteWork,
  encryptWorksAtRest,
  getWork,
  isWorksEncrypted,
  linkWorkBoardTask,
  linkWorkFlow,
  listWorks,
  markWorkDone,
  mutateWorks,
  pruneDeletedFlowRefs,
  readWorks,
  resolveWorkId,
  serializeWork,
  setWorkThread,
  syncWorksOnFlowDelete,
  unlinkWorkBoardTask,
  unlinkWorkFlow,
  unlinkWorkThread,
  updateWork,
  WorksStoreError,
  writeWorks
} from "./works-store.js";
export type {
  AddWorkOutcomeInput,
  CreateWorkInput,
  LinkValidator,
  PersistedWork,
  UpdateWorkInput,
  WorkOutcome,
  WorkOutcomeKind,
  WorkStatus
} from "./works-store.js";
