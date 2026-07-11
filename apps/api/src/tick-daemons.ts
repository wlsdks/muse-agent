/**
 * Tick-daemon bootstrap. Five setInterval riders share the same
 * "off by default → env-gated start → addHook('onClose', stop)"
 * shape, but each has its own env keys, its own required option
 * fields, and a couple of unique knobs. Inlining them all in
 * `buildServer` produced 200 LOC of near-identical scaffolding;
 * pulling each into its own `*IfConfigured` function keeps that
 * file focused on Fastify wiring + routes.
 *
 * No behaviour change — every env key, default, conditional gate,
 * and option destructure matches the prior inline code line-for-line.
 *
 * Telegram / Slack / Discord polling daemons stay inline in
 * server.ts for now; their wiring has enough unique pre-checks
 * (concrete-provider downcasts, channel parsing) that extracting
 * them too would hide more than it reveals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { createGateEmbedder, createKnowledgeEnricher, createOllamaEmbedder, parseBoolean, resolveActionLogFile, resolveContactsFile, resolveLearningPauseFile, resolvePlaybookFile, resolveSuppressedLessonsFile } from "@muse/autoconfigure";
import { createCachingEmbedder } from "@muse/agent-core";
import type { FastifyInstance } from "fastify";

import type { ServerOptions } from "./server.js";
import { parseQuietHours, startReminderTick } from "./reminder-tick.js";
import {
  createFileBackedActivityTracker,
  createInMemoryActivityTracker,
  startProactiveTick,
  type InMemoryActivityTracker
} from "./proactive-tick.js";
import { startConsolidateTick } from "./consolidate-tick.js";
import { distillQueuedCorrections } from "./distill-queue.js";
import { isModelResidentLive } from "./model-resident.js";
import { osIdleMs } from "./os-idle.js";
import { isOnAcPower } from "./power-state.js";
import { readTasks, readReminders, queryActionLog, resolveTasksDueLine, formatBirthdayBriefLine, queryContacts, resolveUpcomingBirthdays, isOllamaLeaseHeldByOther, resolveOllamaLeaseFile, resolveLearnQueueFile, decayStalePlaybookRewards } from "@muse/stores";
import { createMessagingObjectiveActuator, createModelObjectiveEvaluator, deriveBriefingImminent, deriveCalendarBriefingImminent, FileAmbientSignalSource, MacOsActiveWindowSource, resolveDayShapeLine, parseAmbientNoticeRules, webWatchesFromConfig, type BriefingImminent } from "@muse/proactivity";
import { createNotesInvestigator, extractEmailAddress, GmailEmailProvider, LocalDirNotesProvider, LocalFileTasksProvider, OpenMeteoWeatherProvider, homeWatchesFromConfig, parseHomeAlertChecks, resolveHomeAlertLine } from "@muse/domain-tools";
import { startAmbientTick } from "./ambient-tick.js";
import { startWebWatchTick } from "./web-watch-tick.js";
import { startFollowupTick } from "./followup-tick.js";
import { startObjectivesTick } from "./objectives-tick.js";
import { startPatternTick } from "./pattern-tick.js";
import { startSituationalBriefingTick } from "./situational-briefing-tick.js";

function stopOnClose(server: FastifyInstance, handle: { stop(): void }): void {
  server.addHook("onClose", async () => {
    handle.stop();
  });
}

function optionalNumber(raw: string | undefined): number | undefined {
  return raw ? Number(raw) : undefined;
}

function resolveMessagingTarget(
  providerIdRaw: string | undefined,
  destinationRaw: string | undefined,
  options: ServerOptions
): { readonly providerId: string; readonly destination: string; readonly registry: NonNullable<ServerOptions["messaging"]> } | undefined {
  const providerId = providerIdRaw?.trim();
  const destination = destinationRaw?.trim();
  if (
    !providerId || providerId.length === 0
    || !destination || destination.length === 0
    || !options.messaging
    || !options.messaging.has(providerId)
  ) {
    return undefined;
  }
  return { providerId, destination, registry: options.messaging };
}

export interface PhaseDActivityWiring {
  readonly phaseDReminderOn: boolean;
  readonly phaseDProactiveOn: boolean;
  readonly sharedActivityTracker?: InMemoryActivityTracker;
}

export function startReminderDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions,
  phaseD: PhaseDActivityWiring
): void {
  const target = resolveMessagingTarget(env.MUSE_REMINDER_DEFAULT_PROVIDER, env.MUSE_REMINDER_DEFAULT_DESTINATION, options);
  if (!target || !options.remindersFile) {
    return;
  }
  const { providerId: tickProvider, destination: tickDestination, registry: tickRegistry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_REMINDER_TICK_MS);
  const quietHours = parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const reminderPhaseDWindowRaw = optionalNumber(env.MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS);
  const tickHandle = startReminderTick({
    ...(phaseD.phaseDReminderOn && phaseD.sharedActivityTracker ? { activitySource: phaseD.sharedActivityTracker } : {}),
    ...(phaseD.phaseDReminderOn && options.defaultModel ? { agentModel: options.defaultModel } : {}),
    ...(phaseD.phaseDReminderOn && options.agentRuntime ? { agentRuntime: options.agentRuntime } : {}),
    ...(reminderPhaseDWindowRaw !== undefined ? { activeSessionWindowMs: reminderPhaseDWindowRaw } : {}),
    destination: tickDestination,
    errorLogger: (message) => server.log.warn(message),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(options.reminderHistoryFile ? { historyFile: options.reminderHistoryFile } : {}),
    logger: (message) => server.log.info(message),
    providerId: tickProvider,
    ...(quietHours ? { quietHours } : {}),
    registry: tickRegistry,
    remindersFile: options.remindersFile
  });
  stopOnClose(server, tickHandle);
}

export function startProactiveDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions,
  phaseD: PhaseDActivityWiring
): void {
  const proactiveCalendar = options.calendar && options.calendar.list().length > 0
    ? options.calendar
    : undefined;
  const proactiveHasSignal = Boolean(proactiveCalendar) || Boolean(options.tasksFile);
  const target = resolveMessagingTarget(env.MUSE_PROACTIVE_PROVIDER, env.MUSE_PROACTIVE_DESTINATION, options);
  if (!target || !proactiveHasSignal) {
    return;
  }
  const { providerId: proactiveProvider, destination: proactiveDestination, registry: proactiveRegistry } = target;
  const proactiveTickMsRaw = optionalNumber(env.MUSE_PROACTIVE_TICK_MS);
  const proactiveLeadRaw = optionalNumber(env.MUSE_PROACTIVE_LEAD_MINUTES);
  const proactiveQuietHours = parseQuietHours(env.MUSE_PROACTIVE_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const proactiveSidecarFile = resolveProactiveSidecarFile(env);
  const proactiveDailyCapRaw = env.MUSE_PROACTIVE_DAILY_CAP ? Number(env.MUSE_PROACTIVE_DAILY_CAP) : 0;
  const proactiveDailyCap = Number.isFinite(proactiveDailyCapRaw) && proactiveDailyCapRaw > 0
    ? Math.trunc(proactiveDailyCapRaw)
    : 0;

  // Phase D — agent-initiated turn. Uses the shared activity tracker
  // created by the caller so a single onRequest hook unlocks both
  // this daemon and the reminder daemon when their respective
  // MUSE_*_AGENT_TURN flag is on.
  const phaseDWindowRaw = optionalNumber(env.MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS);

  // A real notes-backed investigator over the primary notes
  // provider so the proactive notice surfaces "📎 Related notes: …"
  // for the imminent item's topic, unasked.
  const proactiveNotesProvider = options.notesProviderRegistry?.primary();
  const proactiveInvestigator = proactiveNotesProvider
    ? createNotesInvestigator((query, limit) => proactiveNotesProvider.search(query, limit))
    : undefined;

  const proactiveHandle = startProactiveTick({
    ...(proactiveInvestigator ? { investigate: proactiveInvestigator } : {}),
    ...(phaseD.phaseDProactiveOn && phaseD.sharedActivityTracker ? { activitySource: phaseD.sharedActivityTracker } : {}),
    ...(phaseD.phaseDProactiveOn && options.defaultModel ? { agentModel: options.defaultModel } : {}),
    // Prefer modelProvider: synthesis is one-shot text gen and the
    // agent runtime's tool registry trips up ≤ 3B local models
    // into emitting tool-call JSON. Fall back to agentRuntime when
    // no provider is available (legacy path).
    ...(phaseD.phaseDProactiveOn && options.modelProvider
      ? { modelProvider: options.modelProvider }
      : phaseD.phaseDProactiveOn && options.agentRuntime
        ? { agentRuntime: options.agentRuntime }
        : {}),
    ...(phaseDWindowRaw !== undefined ? { activeSessionWindowMs: phaseDWindowRaw } : {}),
    ...(options.proactiveHistoryFile ? { historyFile: options.proactiveHistoryFile } : {}),
    ...(proactiveCalendar ? { calendarRegistry: proactiveCalendar } : {}),
    ...(options.tasksFile ? { tasksFile: options.tasksFile } : {}),
    destination: proactiveDestination,
    errorLogger: (message) => server.log.warn(message),
    ...(proactiveTickMsRaw !== undefined ? { intervalMs: proactiveTickMsRaw } : {}),
    ...(proactiveLeadRaw !== undefined ? { leadMinutes: proactiveLeadRaw } : {}),
    logger: (message) => server.log.info(message),
    messagingRegistry: proactiveRegistry,
    providerId: proactiveProvider,
    ...(proactiveQuietHours ? { quietHours: proactiveQuietHours } : {}),
    ...(options.sessionLockFile ? { sessionLockFile: options.sessionLockFile } : {}),
    sidecarFile: proactiveSidecarFile,
    trustLedgerFile: resolveProactiveTrustFile(env),
    ...(proactiveDailyCap > 0 ? { dailyCap: proactiveDailyCap } : {})
  });
  stopOnClose(server, proactiveHandle);
}

export function startFollowupDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const target = resolveMessagingTarget(env.MUSE_FOLLOWUP_DEFAULT_PROVIDER, env.MUSE_FOLLOWUP_DEFAULT_DESTINATION, options);
  if (!target || !options.followupsFile || !options.modelProvider || !options.defaultModel) {
    return;
  }
  const { providerId: followupProvider, destination: followupDestination, registry: followupRegistry } = target;
  const followupTickMsRaw = optionalNumber(env.MUSE_FOLLOWUP_TICK_MS);
  const followupMaxPerTickRaw = optionalNumber(env.MUSE_FOLLOWUP_MAX_PER_TICK);
  const followupQuietHours = parseQuietHours(env.MUSE_FOLLOWUP_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const followupHandle = startFollowupTick({
    destination: followupDestination,
    errorLogger: (message) => server.log.warn(message),
    followupsFile: options.followupsFile,
    ...(followupTickMsRaw !== undefined ? { intervalMs: followupTickMsRaw } : {}),
    logger: (message) => server.log.info(message),
    ...(followupMaxPerTickRaw !== undefined ? { maxPerTick: followupMaxPerTickRaw } : {}),
    model: options.defaultModel,
    modelProvider: options.modelProvider,
    providerId: followupProvider,
    ...(followupQuietHours ? { quietHours: followupQuietHours } : {}),
    registry: followupRegistry
  });
  stopOnClose(server, followupHandle);
}

/**
 * Build the shared knowledge enricher (unified live corpus + cached
 * Ollama embed) used by BOTH proactive channels — the scheduled
 * briefing's `relatedKnowledge` and the real-time ambient notice's
 * `enrich`. Off unless `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED=true`.
 */
function buildKnowledgeEnricherIfEnabled(
  env: NodeJS.ProcessEnv,
  options: ServerOptions,
  enrichOptions: { readonly excludeSourcePrefixes?: readonly string[] } = {}
): ((query: string) => Promise<string | undefined>) | undefined {
  if (!parseBoolean(env.MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED, false)) {
    return undefined;
  }
  return createKnowledgeEnricher({
    embed: createCachingEmbedder(createOllamaEmbedder(env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() || "nomic-embed-text")),
    ...(options.notesDir ? { notesProvider: new LocalDirNotesProvider({ notesDir: options.notesDir }) } : {}),
    ...(options.tasksFile ? { tasksProvider: new LocalFileTasksProvider({ file: options.tasksFile }) } : {}),
    ...(options.calendar ? { calendarSource: options.calendar } : {}),
    contactsSource: { list: () => queryContacts(resolveContactsFile(env)) },
    ...(enrichOptions.excludeSourcePrefixes ? { excludeSourcePrefixes: enrichOptions.excludeSourcePrefixes } : {})
  });
}

export function startSituationalBriefingDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const target = resolveMessagingTarget(env.MUSE_BRIEFING_PROVIDER, env.MUSE_BRIEFING_DESTINATION, options);
  if (!target || !options.objectivesFile || !options.briefingSidecarFile) {
    return;
  }
  const { providerId: briefingProvider, destination: briefingDestination, registry: briefingRegistry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_BRIEFING_TICK_MS);
  const windowMsRaw = optionalNumber(env.MUSE_BRIEFING_WINDOW_MS);
  const briefingQuietHours = parseQuietHours(env.MUSE_BRIEFING_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const leadRaw = optionalNumber(env.MUSE_BRIEFING_LEAD_MINUTES);
  const tasksFile = options.tasksFile;
  const briefingCalendar = options.calendar;
  const leadOpt = leadRaw !== undefined ? { leadMinutes: leadRaw } : {};
  const imminentProvider =
    tasksFile || briefingCalendar
      ? async (briefingNow: Date): Promise<readonly BriefingImminent[]> => {
          const out: BriefingImminent[] = [];
          if (tasksFile) {
            out.push(...(await deriveBriefingImminent(tasksFile, { now: briefingNow, ...leadOpt })));
          }
          if (briefingCalendar) {
            out.push(
              ...(await deriveCalendarBriefingImminent(
                (range) => briefingCalendar.listEvents(range),
                { now: briefingNow, ...leadOpt }
              ))
            );
          }
          return out;
        }
      : undefined;
  const weatherLocation = env.MUSE_WEATHER_LOCATION?.trim();
  const weatherOpt = weatherLocation && weatherLocation.length > 0
    ? { weatherLocation, weatherProvider: new OpenMeteoWeatherProvider() }
    : {};
  const gmailToken = env.MUSE_GMAIL_TOKEN?.trim();
  const emailOpt = gmailToken && gmailToken.length > 0
    ? { emailProvider: new GmailEmailProvider(gmailToken) }
    : {};
  // Snapshot the contacts' addresses once at daemon start so the inbox
  // brief surfaces mail from people you know first. A predicate that
  // re-read the file per sender would hammer disk; a daemon restart
  // refreshes the snapshot.
  let knownContactEmails = new Set<string>();
  if (gmailToken && gmailToken.length > 0) {
    void queryContacts(resolveContactsFile(env))
      .then((contacts) => {
        knownContactEmails = new Set(contacts.flatMap((c) => (c.email ? [c.email.toLowerCase()] : [])));
      })
      .catch(() => undefined);
  }
  const inboxKnownSenderOpt = gmailToken && gmailToken.length > 0
    ? {
        inboxKnownSender: (from: string): boolean => {
          const email = extractEmailAddress(from);
          return email !== undefined && knownContactEmails.has(email);
        }
      }
    : {};
  // The brief already lists the imminent calendar/task under Upcoming —
  // exclude those source types so "Related" adds genuine context
  // (notes / contacts), not an echo of what's already shown.
  const briefingEnricher = buildKnowledgeEnricherIfEnabled(env, options, { excludeSourcePrefixes: ["event/", "task/"] });
  const relatedOpt = briefingEnricher ? { relatedKnowledge: briefingEnricher } : {};
  const haBaseUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
  const haToken = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
  const homeChecks = parseHomeAlertChecks(env.MUSE_BRIEFING_HOME_ALERTS ?? "");
  const homeAlertOpt = haBaseUrl && haToken && homeChecks.length > 0
    ? { homeAlert: () => resolveHomeAlertLine({ baseUrl: haBaseUrl, token: haToken }, homeChecks) }
    : {};
  const birthdayDaysRaw = optionalNumber(env.MUSE_BRIEFING_BIRTHDAY_DAYS);
  const birthdayDays = Number.isFinite(birthdayDaysRaw) ? (birthdayDaysRaw as number) : 7;
  const birthdayOpt = {
    birthdayLine: async () =>
      formatBirthdayBriefLine(resolveUpcomingBirthdays(await queryContacts(resolveContactsFile(env)), { withinDays: birthdayDays }))
  };
  const taskDueDaysRaw = optionalNumber(env.MUSE_BRIEFING_TASK_DUE_DAYS);
  const taskDueDays = Number.isFinite(taskDueDaysRaw) ? (taskDueDaysRaw as number) : 1;
  const tasksDueOpt = tasksFile
    ? { tasksDueLine: async () => resolveTasksDueLine(await readTasks(tasksFile), { withinDays: taskDueDays }) }
    : {};
  const availabilityOpt = briefingCalendar
    ? {
        availabilityLine: async () => {
          const briefNow = new Date();
          const dayEnd = new Date(briefNow.getFullYear(), briefNow.getMonth(), briefNow.getDate(), 23, 59, 59, 999);
          return resolveDayShapeLine(await briefingCalendar.listEvents({ from: briefNow, to: dayEnd }), { now: briefNow });
        }
      }
    : {};
  const briefingHandle = startSituationalBriefingTick({
    destination: briefingDestination,
    errorLogger: (message) => server.log.warn(message),
    ...(imminentProvider ? { imminentProvider } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    logger: (message) => server.log.info(message),
    objectivesFile: options.objectivesFile,
    providerId: briefingProvider,
    ...(briefingQuietHours ? { quietHours: briefingQuietHours } : {}),
    registry: briefingRegistry,
    sidecarFile: options.briefingSidecarFile,
    ...weatherOpt,
    ...emailOpt,
    ...inboxKnownSenderOpt,
    ...relatedOpt,
    ...homeAlertOpt,
    ...birthdayOpt,
    ...tasksDueOpt,
    ...availabilityOpt,
    ...(windowMsRaw !== undefined ? { windowMs: windowMsRaw } : {})
  });
  stopOnClose(server, briefingHandle);
}

export function startObjectivesDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const target = resolveMessagingTarget(env.MUSE_OBJECTIVES_PROVIDER, env.MUSE_OBJECTIVES_DESTINATION, options);
  if (!target || !options.objectivesFile || !options.modelProvider || !options.defaultModel) {
    return;
  }
  const { providerId: objectivesProvider, destination: objectivesDestination, registry: objectivesRegistry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_OBJECTIVES_TICK_MS);
  const maxPerTickRaw = optionalNumber(env.MUSE_OBJECTIVES_MAX_PER_TICK);
  const objectivesQuietHours = parseQuietHours(env.MUSE_OBJECTIVES_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const objectivesActionLogFile = options.actionLogFile ?? resolveActionLogFile(env);
  const evaluate = createModelObjectiveEvaluator({
    evidenceDeps: {
      ...(options.tasksFile ? { readTasks: () => readTasks(options.tasksFile!) } : {}),
      ...(options.remindersFile ? { readReminders: () => readReminders(options.remindersFile!) } : {}),
      // `notes` has no synchronous, keyword-searchable local store wired to
      // this call site (notes search is embedding-index-backed in
      // @muse/recall) — resolving to [] fails closed to "unmet" rather than
      // wiring a heavier async path here.
      ...(options.calendar
        ? { listCalendarEvents: (range: { readonly from: Date; readonly to: Date }) => options.calendar!.listEvents(range) }
        : {}),
      queryActionLog: () => queryActionLog(objectivesActionLogFile, {})
    },
    model: options.defaultModel,
    modelProvider: options.modelProvider
  });
  const { act, escalate } = createMessagingObjectiveActuator({
    ...(options.actionLogFile ? { actionLogFile: options.actionLogFile } : {}),
    destination: objectivesDestination,
    providerId: objectivesProvider,
    registry: objectivesRegistry
  });
  const objectivesHandle = startObjectivesTick({
    act,
    errorLogger: (message) => server.log.warn(message),
    escalate,
    evaluate,
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    logger: (message) => server.log.info(message),
    ...(maxPerTickRaw !== undefined ? { maxPerTick: maxPerTickRaw } : {}),
    objectivesFile: options.objectivesFile,
    ...(objectivesQuietHours ? { quietHours: objectivesQuietHours } : {})
  });
  stopOnClose(server, objectivesHandle);
}

export function startPatternDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const patternEnabled = parseBoolean(env.MUSE_PROACTIVE_PATTERN_ENABLED, false);
  const target = resolveMessagingTarget(env.MUSE_PROACTIVE_PATTERN_PROVIDER, env.MUSE_PROACTIVE_PATTERN_DESTINATION, options);
  if (!patternEnabled || !target || !options.patternsFiredFile) {
    return;
  }
  const { providerId: patternProvider, destination: patternDestination, registry: patternRegistry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_PROACTIVE_PATTERN_TICK_MS);
  const cooldownMsRaw = optionalNumber(env.MUSE_PROACTIVE_PATTERN_COOLDOWN_MS);
  const minConfidenceRaw = optionalNumber(env.MUSE_PROACTIVE_PATTERN_MIN_CONFIDENCE);
  const maxPerTickRaw = optionalNumber(env.MUSE_PROACTIVE_PATTERN_MAX_PER_TICK);
  const patternQuietHours = parseQuietHours(env.MUSE_PROACTIVE_PATTERN_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const patternHandle = startPatternTick({
    destination: patternDestination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    ...(options.tasksFile ? { tasksFile: options.tasksFile } : {}),
    ...(options.notesDir ? { notesDir: options.notesDir } : {}),
    ...(cooldownMsRaw !== undefined ? { cooldownMs: cooldownMsRaw } : {}),
    ...(maxPerTickRaw !== undefined ? { maxPerTick: maxPerTickRaw } : {}),
    ...(minConfidenceRaw !== undefined ? { minConfidence: minConfidenceRaw } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    patternsFiredFile: options.patternsFiredFile,
    providerId: patternProvider,
    ...(patternQuietHours ? { quietHours: patternQuietHours } : {}),
    registry: patternRegistry
  });
  stopOnClose(server, patternHandle);
}

/**
 * N1c — idle-gated curator daemon. Off by default; activates when
 * `MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED=true` AND a model provider + default
 * model are wired (the umbrella merge is a local-Qwen call). Folds overlapping
 * authored skills into umbrellas autonomously while the user is idle, instead
 * of only at chat session-end. The idle signal reuses the shared activity
 * tracker when phaseD already runs one; otherwise it stands up its own (+ an
 * onRequest hook) so "idle" reflects real /api/chat traffic regardless.
 */
export function startConsolidateDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions,
  phaseD: PhaseDActivityWiring
): void {
  if (
    !parseBoolean(env.MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED, false)
    || !options.modelProvider
    || !options.defaultModel
  ) {
    return;
  }
  let source = phaseD.sharedActivityTracker;
  if (!source) {
    const presenceFile = env.MUSE_PROACTIVE_PRESENCE_FILE?.trim();
    const tracker = presenceFile && presenceFile.length > 0
      ? createFileBackedActivityTracker({ file: presenceFile })
      : createInMemoryActivityTracker();
    server.addHook("onRequest", async (request) => {
      const path = (request as { readonly url?: string }).url ?? "";
      if (path.startsWith("/api/chat") || path === "/chat" || path === "/chat/stream") {
        tracker.record();
      }
    });
    source = tracker;
  }
  const activitySource = source;
  const authoredSkillsDir = env.MUSE_AUTHORED_SKILLS_DIR?.trim()
    || join(homedir(), ".muse", "skills", "authored");
  const idleMsRaw = optionalNumber(env.MUSE_SKILL_CONSOLIDATE_IDLE_MS);
  const tickMsRaw = optionalNumber(env.MUSE_SKILL_CONSOLIDATE_TICK_MS);
  const consolidateQuietHours = parseQuietHours(env.MUSE_SKILL_CONSOLIDATE_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const consolidateModel = options.defaultModel;
  const consolidateProvider = options.modelProvider;
  // Deterministic curate cadence: auto-archive authored skills idle this many
  // days so the local model isn't choosing among stale skills. Default 90d
  // (recoverable archive); MUSE_SKILL_CURATE_IDLE_DAYS=0 disables.
  const curateIdleDays = Number(env.MUSE_SKILL_CURATE_IDLE_DAYS ?? "90");
  const consolidateHandle = startConsolidateTick({
    authoredSkillsDir,
    ...(Number.isFinite(curateIdleDays) && curateIdleDays > 0 ? { curateMaxIdleDays: curateIdleDays } : {}),
    errorLogger: (message) => server.log.warn(message),
    lastActivityMs: () => activitySource.lastActivityMs(),
    logger: (message) => server.log.info(message),
    model: options.defaultModel,
    modelProvider: options.modelProvider,
    // SkillOpt held-out coverage gate: verify a proposed umbrella semantically
    // covers every clustered skill before committing (shared gate embedder).
    embed: createGateEmbedder(env),
    // Cross-tick reject cooldown ledger — stop re-proposing a cluster the gate
    // keeps rejecting (beside the authored skills, env-overridable).
    rejectLedgerFile: env.MUSE_SKILL_COOLDOWN_FILE?.trim() || join(authoredSkillsDir, ".reject-cooldown.json"),
    // Real OS-idle brake: the LLM merge only fires when the MACHINE is quiet
    // (system-wide HID idle), not merely when Muse's /api is — fail-closed.
    osIdleMs: () => osIdleMs(),
    // Model-resident brake: never cold-load the multi-GB model unattended —
    // merge only when it's already loaded in Ollama (fail-closed).
    ...(consolidateModel ? { isModelResident: () => isModelResidentLive(consolidateModel) } : {}),
    // Idle REM phase: distill queued corrections into learned
    // strategies while idle, behind the brakes (the felt grows-with-you path).
    ...(consolidateModel && consolidateProvider ? { distillQueued: () => distillQueuedCorrections({ model: consolidateModel, modelProvider: consolidateProvider, embed: createGateEmbedder(env), playbookFile: resolvePlaybookFile(env), queueFile: resolveLearnQueueFile(env), suppressedLessonsFile: resolveSuppressedLessonsFile(env), pauseFile: resolveLearningPauseFile(env) }) } : {}),
    // Idle RL phase: fade positive-reward strategies the user has
    // stopped reinforcing back toward neutral, so a stale thumbs-up doesn't
    // steer the agent forever. Cheap + local (no model needed), behind the brakes.
    decayStale: () => decayStalePlaybookRewards(resolvePlaybookFile(env), { nowMs: Date.now() }),
    // AC-power brake: a heavy LLM merge runs on wall power only, never on
    // battery — so background learning can't drain the laptop (fail-closed).
    isOnAcPower: () => isOnAcPower(),
    // Contention brake: defer while a foreground chat/ask holds the Ollama
    // lease, so the daemon never competes with a live foreground call.
    isForegroundBusy: () => isOllamaLeaseHeldByOther(resolveOllamaLeaseFile(env), process.pid, { nowMs: Date.now() }),
    ...(idleMsRaw !== undefined ? { idleThresholdMs: idleMsRaw } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(consolidateQuietHours ? { quietHours: consolidateQuietHours } : {})
  });
  stopOnClose(server, consolidateHandle);
}

/**
 * P20 / SB-3 perception daemon. Off by default; activates when
 * `MUSE_AMBIENT_ENABLED=true`, a messaging provider + destination are
 * set + registered, AND there is something to fire from: either
 * `MUSE_AMBIENT_RULES` parses to ≥1 rule, OR the knowledge trigger is on
 * (`MUSE_AMBIENT_KNOWLEDGE_TRIGGER=true` with the shared enricher
 * enabled). Reads the ambient signal each tick (live macOS window or the
 * `MUSE_AMBIENT_FILE` JSON) and edge-fires proactive notices.
 */
export function startAmbientDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const enabled = parseBoolean(env.MUSE_AMBIENT_ENABLED, false);
  const rules = parseAmbientNoticeRules(env.MUSE_AMBIENT_RULES ?? "");
  const enrich = buildKnowledgeEnricherIfEnabled(env, options);
  // SB-3 knowledge trigger: the active window title alone surfaces a
  // recall notice with NO pre-authored rule. Needs the shared enricher
  // (gated by MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED), so absent that it
  // stays off even when the flag is set.
  const knowledgeTrigger = parseBoolean(env.MUSE_AMBIENT_KNOWLEDGE_TRIGGER, false) && enrich
    ? { enrich }
    : undefined;
  const target = resolveMessagingTarget(env.MUSE_AMBIENT_PROVIDER, env.MUSE_AMBIENT_DESTINATION, options);
  if (
    !enabled
    || !target
    || (rules.length === 0 && !knowledgeTrigger)
  ) {
    return;
  }
  const { providerId, destination, registry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_AMBIENT_TICK_MS);
  const quietHours = parseQuietHours(env.MUSE_AMBIENT_QUIET_HOURS) ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  // Live macOS active-window perception (no helper writing the file)
  // when opted in on darwin; otherwise the file source.
  const source = env.MUSE_AMBIENT_SOURCE?.trim() === "macos" && process.platform === "darwin"
    ? new MacOsActiveWindowSource({ includeClipboard: parseBoolean(env.MUSE_AMBIENT_CLIPBOARD, false) })
    : new FileAmbientSignalSource(resolveAmbientSignalFile(env));
  const handle = startAmbientTick({
    destination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    providerId,
    registry,
    rules,
    source,
    ...(enrich ? { enrich } : {}),
    ...(knowledgeTrigger ? { knowledgeTrigger } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  stopOnClose(server, handle);
}

export function startWebWatchDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const enabled = parseBoolean(env.MUSE_WEB_WATCH_ENABLED, false);
  const watches = webWatchesFromConfig(env.MUSE_WEB_WATCH_CONFIG ?? "");
  const target = resolveMessagingTarget(env.MUSE_WEB_WATCH_PROVIDER, env.MUSE_WEB_WATCH_DESTINATION, options);
  if (!enabled || !target || watches.length === 0) {
    return;
  }
  const { providerId, destination, registry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_WEB_WATCH_TICK_MS);
  const quietHours = parseQuietHours(env.MUSE_WEB_WATCH_QUIET_HOURS) ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const handle = startWebWatchTick({
    destination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    providerId,
    registry,
    watches,
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  stopOnClose(server, handle);
}

export function startHomeWatchDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const enabled = parseBoolean(env.MUSE_HOME_WATCH_ENABLED, false);
  const baseUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
  const token = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
  const watches = baseUrl && token
    ? homeWatchesFromConfig(env.MUSE_HOME_WATCH_CONFIG ?? "", { baseUrl, token })
    : [];
  const target = resolveMessagingTarget(env.MUSE_HOME_WATCH_PROVIDER, env.MUSE_HOME_WATCH_DESTINATION, options);
  if (!enabled || !target || watches.length === 0) {
    return;
  }
  const { providerId, destination, registry } = target;
  const tickMsRaw = optionalNumber(env.MUSE_HOME_WATCH_TICK_MS);
  const quietHours = parseQuietHours(env.MUSE_HOME_WATCH_QUIET_HOURS) ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const handle = startWebWatchTick({
    destination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    providerId,
    registry,
    watches,
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  stopOnClose(server, handle);
}

export function resolveAmbientSignalFile(env: NodeJS.ProcessEnv): string {
  const overridden = env.MUSE_AMBIENT_FILE?.trim();
  if (overridden && overridden.length > 0) return overridden;
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return `${envHome}/.muse/ambient.json`;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return `${sysHome}/.muse/ambient.json`;
  throw new Error("Cannot resolve home directory for ambient signal file — set MUSE_AMBIENT_FILE or HOME (refusing to default to filesystem root)");
}

export function resolveProactiveSidecarFile(env: NodeJS.ProcessEnv): string {
  const overridden = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim();
  if (overridden && overridden.length > 0) return overridden;
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return `${envHome}/.muse/proactive-fired.json`;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return `${sysHome}/.muse/proactive-fired.json`;
  throw new Error("Cannot resolve home directory for proactive sidecar file — set MUSE_PROACTIVE_SIDECAR_FILE or HOME (refusing to default to filesystem root)");
}

export function resolveProactiveTrustFile(env: NodeJS.ProcessEnv): string {
  const overridden = env.MUSE_PROACTIVE_TRUST_FILE?.trim();
  if (overridden && overridden.length > 0) return overridden;
  const envHome = process.env.HOME?.trim();
  if (envHome && envHome.length > 0) return `${envHome}/.muse/proactive-trust.json`;
  const sysHome = homedir().trim();
  if (sysHome.length > 0) return `${sysHome}/.muse/proactive-trust.json`;
  throw new Error("Cannot resolve home directory for proactive trust file — set MUSE_PROACTIVE_TRUST_FILE or HOME (refusing to default to filesystem root)");
}
