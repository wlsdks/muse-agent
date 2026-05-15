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

import { parseBoolean } from "@muse/autoconfigure";
import type { FastifyInstance } from "fastify";

import type { ServerOptions } from "./server.js";
import { parseQuietHours, startReminderTick } from "./reminder-tick.js";
import { startProactiveTick, type InMemoryActivityTracker } from "./proactive-tick.js";
import { startFollowupTick } from "./followup-tick.js";
import { startPatternTick } from "./pattern-tick.js";

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
  const proactiveSidecarFile = env.MUSE_PROACTIVE_SIDECAR_FILE?.trim()
    || `${process.env.HOME ?? ""}/.muse/proactive-fired.json`;

  // Phase D — agent-initiated turn. Uses the shared activity tracker
  // created by the caller so a single onRequest hook unlocks both
  // this daemon and the reminder daemon when their respective
  // MUSE_*_AGENT_TURN flag is on.
  const phaseDWindowRaw = env.MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS
    ? Number(env.MUSE_PROACTIVE_ACTIVE_SESSION_WINDOW_MS)
    : undefined;

  const proactiveHandle = startProactiveTick({
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
    sidecarFile: proactiveSidecarFile
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

export function startPatternDaemonIfConfigured(
  env: NodeJS.ProcessEnv,
  server: FastifyInstance,
  options: ServerOptions
): void {
  // Goal 130 — route through the goal-128 parseBoolean so common
  // admin spellings (`1`, `yes`, `on`) work uniformly.
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
