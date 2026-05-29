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

import { createKnowledgeEnricher, createOllamaEmbedder, parseBoolean, resolveContactsFile } from "@muse/autoconfigure";
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
import {
  createMessagingObjectiveActuator,
  createModelObjectiveEvaluator,
  createNotesInvestigator,
  deriveBriefingImminent,
  deriveCalendarBriefingImminent,
  FileAmbientSignalSource,
  MacOsActiveWindowSource,
  extractEmailAddress,
  GmailEmailProvider,
  LocalDirNotesProvider,
  LocalFileTasksProvider,
  OpenMeteoWeatherProvider,
  homeWatchesFromConfig,
  parseHomeAlertChecks,
  readTasks,
  resolveDayShapeLine,
  resolveHomeAlertLine,
  resolveTasksDueLine,
  parseAmbientNoticeRules,
  formatBirthdayBriefLine,
  queryContacts,
  resolveUpcomingBirthdays,
  webWatchesFromConfig,
  type BriefingImminent
} from "@muse/mcp";
import { startAmbientTick } from "./ambient-tick.js";
import { startWebWatchTick } from "./web-watch-tick.js";
import { startFollowupTick } from "./followup-tick.js";
import { startObjectivesTick } from "./objectives-tick.js";
import { startPatternTick } from "./pattern-tick.js";
import { startSituationalBriefingTick } from "./situational-briefing-tick.js";

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
  const tickProvider = env.MUSE_REMINDER_DEFAULT_PROVIDER?.trim();
  const tickDestination = env.MUSE_REMINDER_DEFAULT_DESTINATION?.trim();
  if (
    !tickProvider || tickProvider.length === 0
    || !tickDestination || tickDestination.length === 0
    || !options.remindersFile
    || !options.messaging
    || !options.messaging.has(tickProvider)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_REMINDER_TICK_MS ? Number(env.MUSE_REMINDER_TICK_MS) : undefined;
  const quietHours = parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const reminderPhaseDWindowRaw = env.MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS
    ? Number(env.MUSE_REMINDER_ACTIVE_SESSION_WINDOW_MS)
    : undefined;
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
    registry: options.messaging,
    remindersFile: options.remindersFile
  });
  server.addHook("onClose", async () => {
    tickHandle.stop();
  });
}

export function startProactiveDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions,
  phaseD: PhaseDActivityWiring
): void {
  const proactiveProvider = env.MUSE_PROACTIVE_PROVIDER?.trim();
  const proactiveDestination = env.MUSE_PROACTIVE_DESTINATION?.trim();
  const proactiveCalendar = options.calendar && options.calendar.list().length > 0
    ? options.calendar
    : undefined;
  const proactiveHasSignal = Boolean(proactiveCalendar) || Boolean(options.tasksFile);
  if (
    !proactiveProvider || proactiveProvider.length === 0
    || !proactiveDestination || proactiveDestination.length === 0
    || !options.messaging
    || !options.messaging.has(proactiveProvider)
    || !proactiveHasSignal
  ) {
    return;
  }
  const proactiveTickMsRaw = env.MUSE_PROACTIVE_TICK_MS ? Number(env.MUSE_PROACTIVE_TICK_MS) : undefined;
  const proactiveLeadRaw = env.MUSE_PROACTIVE_LEAD_MINUTES ? Number(env.MUSE_PROACTIVE_LEAD_MINUTES) : undefined;
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
  const phaseDWindowRaw = env.MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS
    ? Number(env.MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS)
    : undefined;

  // P0-b3: a real notes-backed investigator over the primary notes
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
    messagingRegistry: options.messaging,
    providerId: proactiveProvider,
    ...(proactiveQuietHours ? { quietHours: proactiveQuietHours } : {}),
    ...(options.sessionLockFile ? { sessionLockFile: options.sessionLockFile } : {}),
    sidecarFile: proactiveSidecarFile,
    trustLedgerFile: resolveProactiveTrustFile(env),
    ...(proactiveDailyCap > 0 ? { dailyCap: proactiveDailyCap } : {})
  });
  server.addHook("onClose", async () => {
    proactiveHandle.stop();
  });
}

export function startFollowupDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const followupProvider = env.MUSE_FOLLOWUP_DEFAULT_PROVIDER?.trim();
  const followupDestination = env.MUSE_FOLLOWUP_DEFAULT_DESTINATION?.trim();
  if (
    !followupProvider || followupProvider.length === 0
    || !followupDestination || followupDestination.length === 0
    || !options.followupsFile
    || !options.messaging
    || !options.messaging.has(followupProvider)
    || !options.modelProvider
    || !options.defaultModel
  ) {
    return;
  }
  const followupTickMsRaw = env.MUSE_FOLLOWUP_TICK_MS ? Number(env.MUSE_FOLLOWUP_TICK_MS) : undefined;
  const followupMaxPerTickRaw = env.MUSE_FOLLOWUP_MAX_PER_TICK ? Number(env.MUSE_FOLLOWUP_MAX_PER_TICK) : undefined;
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
    registry: options.messaging
  });
  server.addHook("onClose", async () => {
    followupHandle.stop();
  });
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
  const briefingProvider = env.MUSE_BRIEFING_PROVIDER?.trim();
  const briefingDestination = env.MUSE_BRIEFING_DESTINATION?.trim();
  if (
    !briefingProvider || briefingProvider.length === 0
    || !briefingDestination || briefingDestination.length === 0
    || !options.objectivesFile
    || !options.briefingSidecarFile
    || !options.messaging
    || !options.messaging.has(briefingProvider)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_BRIEFING_TICK_MS ? Number(env.MUSE_BRIEFING_TICK_MS) : undefined;
  const windowMsRaw = env.MUSE_BRIEFING_WINDOW_MS ? Number(env.MUSE_BRIEFING_WINDOW_MS) : undefined;
  const briefingQuietHours = parseQuietHours(env.MUSE_BRIEFING_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const leadRaw = env.MUSE_BRIEFING_LEAD_MINUTES ? Number(env.MUSE_BRIEFING_LEAD_MINUTES) : undefined;
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
  const birthdayDaysRaw = env.MUSE_BRIEFING_BIRTHDAY_DAYS ? Number(env.MUSE_BRIEFING_BIRTHDAY_DAYS) : undefined;
  const birthdayDays = Number.isFinite(birthdayDaysRaw) ? (birthdayDaysRaw as number) : 7;
  const birthdayOpt = {
    birthdayLine: async () =>
      formatBirthdayBriefLine(resolveUpcomingBirthdays(await queryContacts(resolveContactsFile(env)), { withinDays: birthdayDays }))
  };
  const taskDueDaysRaw = env.MUSE_BRIEFING_TASK_DUE_DAYS ? Number(env.MUSE_BRIEFING_TASK_DUE_DAYS) : undefined;
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
    registry: options.messaging,
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
  server.addHook("onClose", async () => {
    briefingHandle.stop();
  });
}

export function startObjectivesDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const objectivesProvider = env.MUSE_OBJECTIVES_PROVIDER?.trim();
  const objectivesDestination = env.MUSE_OBJECTIVES_DESTINATION?.trim();
  if (
    !objectivesProvider || objectivesProvider.length === 0
    || !objectivesDestination || objectivesDestination.length === 0
    || !options.objectivesFile
    || !options.messaging
    || !options.messaging.has(objectivesProvider)
    || !options.modelProvider
    || !options.defaultModel
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_OBJECTIVES_TICK_MS ? Number(env.MUSE_OBJECTIVES_TICK_MS) : undefined;
  const maxPerTickRaw = env.MUSE_OBJECTIVES_MAX_PER_TICK ? Number(env.MUSE_OBJECTIVES_MAX_PER_TICK) : undefined;
  const objectivesQuietHours = parseQuietHours(env.MUSE_OBJECTIVES_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const evaluate = createModelObjectiveEvaluator({
    model: options.defaultModel,
    modelProvider: options.modelProvider
  });
  const { act, escalate } = createMessagingObjectiveActuator({
    ...(options.actionLogFile ? { actionLogFile: options.actionLogFile } : {}),
    destination: objectivesDestination,
    providerId: objectivesProvider,
    registry: options.messaging
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
  server.addHook("onClose", async () => {
    objectivesHandle.stop();
  });
}

export function startPatternDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const patternEnabled = parseBoolean(env.MUSE_PROACTIVE_PATTERN_ENABLED, false);
  const patternProvider = env.MUSE_PROACTIVE_PATTERN_PROVIDER?.trim();
  const patternDestination = env.MUSE_PROACTIVE_PATTERN_DESTINATION?.trim();
  if (
    !patternEnabled
    || !patternProvider || patternProvider.length === 0
    || !patternDestination || patternDestination.length === 0
    || !options.patternsFiredFile
    || !options.messaging
    || !options.messaging.has(patternProvider)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_PROACTIVE_PATTERN_TICK_MS ? Number(env.MUSE_PROACTIVE_PATTERN_TICK_MS) : undefined;
  const cooldownMsRaw = env.MUSE_PROACTIVE_PATTERN_COOLDOWN_MS ? Number(env.MUSE_PROACTIVE_PATTERN_COOLDOWN_MS) : undefined;
  const minConfidenceRaw = env.MUSE_PROACTIVE_PATTERN_MIN_CONFIDENCE ? Number(env.MUSE_PROACTIVE_PATTERN_MIN_CONFIDENCE) : undefined;
  const maxPerTickRaw = env.MUSE_PROACTIVE_PATTERN_MAX_PER_TICK ? Number(env.MUSE_PROACTIVE_PATTERN_MAX_PER_TICK) : undefined;
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
    registry: options.messaging
  });
  server.addHook("onClose", async () => {
    patternHandle.stop();
  });
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
  const idleMsRaw = env.MUSE_SKILL_CONSOLIDATE_IDLE_MS ? Number(env.MUSE_SKILL_CONSOLIDATE_IDLE_MS) : undefined;
  const tickMsRaw = env.MUSE_SKILL_CONSOLIDATE_TICK_MS ? Number(env.MUSE_SKILL_CONSOLIDATE_TICK_MS) : undefined;
  const consolidateQuietHours = parseQuietHours(env.MUSE_SKILL_CONSOLIDATE_QUIET_HOURS)
    ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const consolidateHandle = startConsolidateTick({
    authoredSkillsDir,
    errorLogger: (message) => server.log.warn(message),
    lastActivityMs: () => activitySource.lastActivityMs(),
    logger: (message) => server.log.info(message),
    model: options.defaultModel,
    modelProvider: options.modelProvider,
    ...(idleMsRaw !== undefined ? { idleThresholdMs: idleMsRaw } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(consolidateQuietHours ? { quietHours: consolidateQuietHours } : {})
  });
  server.addHook("onClose", async () => {
    consolidateHandle.stop();
  });
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
  const providerId = env.MUSE_AMBIENT_PROVIDER?.trim();
  const destination = env.MUSE_AMBIENT_DESTINATION?.trim();
  const rules = parseAmbientNoticeRules(env.MUSE_AMBIENT_RULES ?? "");
  const enrich = buildKnowledgeEnricherIfEnabled(env, options);
  // SB-3 knowledge trigger: the active window title alone surfaces a
  // recall notice with NO pre-authored rule. Needs the shared enricher
  // (gated by MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED), so absent that it
  // stays off even when the flag is set.
  const knowledgeTrigger = parseBoolean(env.MUSE_AMBIENT_KNOWLEDGE_TRIGGER, false) && enrich
    ? { enrich }
    : undefined;
  if (
    !enabled
    || !providerId || providerId.length === 0
    || !destination || destination.length === 0
    || (rules.length === 0 && !knowledgeTrigger)
    || !options.messaging
    || !options.messaging.has(providerId)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_AMBIENT_TICK_MS ? Number(env.MUSE_AMBIENT_TICK_MS) : undefined;
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
    registry: options.messaging,
    rules,
    source,
    ...(enrich ? { enrich } : {}),
    ...(knowledgeTrigger ? { knowledgeTrigger } : {}),
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  server.addHook("onClose", async () => {
    handle.stop();
  });
}

export function startWebWatchDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const enabled = parseBoolean(env.MUSE_WEB_WATCH_ENABLED, false);
  const providerId = env.MUSE_WEB_WATCH_PROVIDER?.trim();
  const destination = env.MUSE_WEB_WATCH_DESTINATION?.trim();
  const watches = webWatchesFromConfig(env.MUSE_WEB_WATCH_CONFIG ?? "");
  if (
    !enabled
    || !providerId || providerId.length === 0
    || !destination || destination.length === 0
    || watches.length === 0
    || !options.messaging
    || !options.messaging.has(providerId)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_WEB_WATCH_TICK_MS ? Number(env.MUSE_WEB_WATCH_TICK_MS) : undefined;
  const quietHours = parseQuietHours(env.MUSE_WEB_WATCH_QUIET_HOURS) ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const handle = startWebWatchTick({
    destination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    providerId,
    registry: options.messaging,
    watches,
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  server.addHook("onClose", async () => {
    handle.stop();
  });
}

export function startHomeWatchDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  const enabled = parseBoolean(env.MUSE_HOME_WATCH_ENABLED, false);
  const providerId = env.MUSE_HOME_WATCH_PROVIDER?.trim();
  const destination = env.MUSE_HOME_WATCH_DESTINATION?.trim();
  const baseUrl = env.MUSE_HOMEASSISTANT_URL?.trim();
  const token = env.MUSE_HOMEASSISTANT_TOKEN?.trim();
  const watches = baseUrl && token
    ? homeWatchesFromConfig(env.MUSE_HOME_WATCH_CONFIG ?? "", { baseUrl, token })
    : [];
  if (
    !enabled
    || !providerId || providerId.length === 0
    || !destination || destination.length === 0
    || watches.length === 0
    || !options.messaging
    || !options.messaging.has(providerId)
  ) {
    return;
  }
  const tickMsRaw = env.MUSE_HOME_WATCH_TICK_MS ? Number(env.MUSE_HOME_WATCH_TICK_MS) : undefined;
  const quietHours = parseQuietHours(env.MUSE_HOME_WATCH_QUIET_HOURS) ?? parseQuietHours(env.MUSE_REMINDER_QUIET_HOURS);
  const handle = startWebWatchTick({
    destination,
    errorLogger: (message) => server.log.warn(message),
    logger: (message) => server.log.info(message),
    providerId,
    registry: options.messaging,
    watches,
    ...(tickMsRaw !== undefined ? { intervalMs: tickMsRaw } : {}),
    ...(quietHours ? { quietHours } : {})
  });
  server.addHook("onClose", async () => {
    handle.stop();
  });
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
