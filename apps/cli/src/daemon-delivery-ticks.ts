/**
 * Delivery/schedule tick cluster — factored out of
 * `commands-daemon-register.ts`'s `muse daemon` action so the handler stays
 * readable. Each `make*Tick` factory takes only the values its tick actually
 * captured (env, resolved file paths, shared assembly pieces, the logger)
 * and returns the same `() => Promise<void>` closure the daemon's `runTick`
 * sequence calls — behavior is unchanged, only the location of the code
 * moved. These are the user-facing DELIVERY ticks (proactive imminent items,
 * background-exit, reminders, follow-ups, check-ins, recurring-pattern
 * nudges, the situational briefing, dreaming reflections) plus the
 * retention-prune housekeeping tick that shares their throttle shape.
 *
 * `TickRunState` (defined in `daemon-selflearn-ticks.ts`, re-exported there)
 * is the `{ current }` holder that carries each tick's own last-run
 * timestamp across calls, mirroring the scheduler-handle pattern in
 * `packages/autoconfigure/src/runtime-assembly.ts`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { adjustConfidenceFloor, sdtCriterion, summarizeNoticeResponses, synthesizePatternSuggestion } from "@muse/agent-core";
import {
  createGateEmbedder,
  parseBoolean,
  resolveContactsFile,
  resolveEpisodesFile,
  resolvePatternsFiredFile,
  resolveProactiveHistoryFile
} from "@muse/autoconfigure";
import type { CalendarProviderRegistry } from "@muse/calendar";
import { runDueSituationalBriefing } from "@muse/domain-tools";
import type { PatternMatch } from "@muse/memory";
import type { MessagingProviderRegistry } from "@muse/messaging";
import {
  deriveBriefingImminent,
  deriveCalendarBriefingImminent,
  isQuietHour,
  resolveQuietHoursOption,
  runDueBackgroundExitNotices,
  runDueCheckins,
  runDueFollowups,
  runDuePatternNotices,
  runDueProactiveNotices,
  runDueReminders,
  type BriefingCalendarLister,
  type InterruptionBudgetWiring,
  type QuietHoursOption
} from "@muse/proactivity";
import {
  defaultExecutionTimeoutMs,
  FileScheduledJobStore,
  InMemoryScheduledJobExecutionStore,
  parseNotificationChannel,
  ScheduledJobExecutionRecorder,
  type ScheduledJob,
  type ScheduledJobExecutionStore,
  type ScheduledJobStore
} from "@muse/scheduler";
import { formatBirthdayBriefLine, isSchedulerPaused, queryContacts, readEpisodes, readProactiveHistory, resolveUpcomingBirthdays } from "@muse/stores";
import { isRecord } from "@muse/shared";

import { backgroundStoreFile } from "./commands-background.js";
import { checkinsFile } from "./commands-checkins.js";
import type { FollowupModel } from "./commands-daemon-connections.js";
import { readDaemonConfig } from "./commands-daemon-config.js";
import { resolveReflectionsFile, runReflectionPass, shouldRunReflection } from "./commands-reflections.js";
import { parseDailyBriefTime, shouldFireDailyBrief } from "./daily-brief.js";
import { maybeAutoPrune } from "./local-state-retention.js";
import { runSchedulerJobAndWait, type SchedulerJobOutcome } from "./scheduler-job-runner.js";
import { isScheduledJobDue } from "./scheduler-tick-due.js";
import { createIndexedProactiveInvestigator } from "./proactive-notes-recall.js";
import { buildLocalTodayText } from "./today-local-sources.js";

import type { TickRunState } from "./daemon-selflearn-ticks.js";

export interface MakeProactiveTickDeps {
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly destination: string;
  readonly historyFile: string;
  readonly leadMinutes: number;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly quietHours: QuietHoursOption | undefined;
  readonly sidecarFile: string;
  readonly tasksFile: string;
  readonly trustLedgerFile: string;
  readonly dailyCap: number;
  readonly stdout: (message: string) => void;
}

/**
 * The core proactive-notice tick — imminent tasks/calendar events within the
 * lead window. One investigator instance is created here (not per tick call)
 * so a recurring item's identical finding isn't re-shown every tick.
 */
export function makeProactiveTick(deps: MakeProactiveTickDeps): () => Promise<void> {
  const { calendarRegistry, destination, historyFile, leadMinutes, messagingRegistry, provider, quietHours, sidecarFile, tasksFile, trustLedgerFile, dailyCap, stdout } = deps;
  const proactiveInvestigator = createIndexedProactiveInvestigator();
  return async (): Promise<void> => {
    const activeQuietHours = resolveQuietHoursOption(quietHours);
    const summary = await runDueProactiveNotices({
      ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
      destination,
      historyFile,
      investigate: proactiveInvestigator,
      leadMinutes,
      messagingRegistry,
      providerId: provider,
      ...(activeQuietHours ? { quietHours: activeQuietHours } : {}),
      sidecarFile,
      tasksFile,
      trustLedgerFile,
      ...(dailyCap > 0 ? { dailyCap } : {})
    });
    const tag = `[${new Date().toISOString()}]`;
    stdout(`${tag} proactive: fired ${summary.fired.toString()}/${summary.imminent.toString()} imminent`);
    if (summary.errors.length > 0) {
      stdout(`, ${summary.errors.length.toString()} error(s)`);
      for (const error of summary.errors) {
        stdout(`\n  ! ${error}`);
      }
    }
    stdout("\n");
  };
}

export interface MakeBackgroundExitNoticeTickDeps {
  readonly destination: string;
  readonly interruptionBudget: InterruptionBudgetWiring;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly stdout: (message: string) => void;
}

export function makeBackgroundExitNoticeTick(deps: MakeBackgroundExitNoticeTickDeps): () => Promise<void> {
  const { destination, interruptionBudget, messagingRegistry, provider, stdout } = deps;
  return async (): Promise<void> => {
    const summary = await runDueBackgroundExitNotices({
      destination,
      interruptionBudget,
      messagingRegistry,
      notifiedFile: join(homedir(), ".muse", "bg-exit-notified.json"),
      providerId: provider,
      storeFile: backgroundStoreFile()
    });
    if (summary.notified > 0 || summary.errors.length > 0) {
      const tag = `[${new Date().toISOString()}]`;
      stdout(`${tag} background-exit: notified ${summary.notified.toString()}/${summary.pending.toString()} pending`);
      if (summary.errors.length > 0) {
        stdout(`, ${summary.errors.length.toString()} error(s)`);
        for (const error of summary.errors) {
          stdout(`\n  ! ${error}`);
        }
      }
      stdout("\n");
    }
  };
}

export interface MakeRemindersTickDeps {
  readonly destination: string;
  readonly remindersFile: string;
  readonly provider: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly stdout: (message: string) => void;
}

export function makeRemindersTick(deps: MakeRemindersTickDeps): () => Promise<void> {
  const { destination, remindersFile, provider, messagingRegistry, stdout } = deps;
  return async (): Promise<void> => {
    const summary = await runDueReminders({
      destination,
      file: remindersFile,
      providerId: provider,
      registry: messagingRegistry
    });
    const tag = `[${new Date().toISOString()}]`;
    stdout(`${tag} reminders: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
    if (summary.errors.length > 0) {
      stdout(`, ${summary.errors.length.toString()} error(s)`);
      for (const error of summary.errors) {
        stdout(`\n  ! ${error}`);
      }
    }
    stdout("\n");
  };
}

export interface MakeDailyBriefTickDeps {
  readonly env: NodeJS.ProcessEnv;
  /** The daemon config file `muse setup briefing` writes — read LIVE every tick. */
  readonly configFile: string;
  readonly sidecarFile: string;
  readonly destination: string;
  readonly provider: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly stdout: (message: string) => void;
  readonly now?: () => Date;
  /**
   * Test seam — inject the composer instead of the real on-disk `muse today`
   * sources. Absent → `buildLocalTodayText`, the SAME deterministic composer
   * `muse today --local` uses (no model provider anywhere in this path).
   */
  readonly composeBrief?: (env: NodeJS.ProcessEnv) => Promise<string>;
}

/**
 * `muse setup briefing` — a fixed-time daily brief, distinct from
 * `makeBriefingTick`'s SITUATIONAL digest above (imminent/lead-minutes
 * driven). Fires ONCE at the user's chosen local HH:MM, deduped by
 * calendar day via its own sidecar — restart-safe, same shape as
 * `makeRecapTick` (daemon-selflearn-ticks.ts) at minute instead of hour
 * granularity. Quiet hours + the interruption budget are EXEMPT: the user
 * explicitly asked for this (the reminders/scheduler precedent — see
 * `makeRemindersTick` / `makeSchedulerTick` above).
 */
export function makeDailyBriefTick(deps: MakeDailyBriefTickDeps): () => Promise<void> {
  const { env: e, configFile, sidecarFile, destination, provider, messagingRegistry, stdout } = deps;
  const now = deps.now ?? (() => new Date());
  const compose = deps.composeBrief ?? ((env: NodeJS.ProcessEnv) => buildLocalTodayText(env as Record<string, string | undefined>, 24));
  return async (): Promise<void> => {
    const config = readDaemonConfig(configFile).dailyBrief;
    if (!config?.enabled) {
      return; // cheap no-op — no compose, no send, no sidecar touch
    }
    let parsedTime: { readonly hour: number; readonly minute: number };
    try {
      parsedTime = parseDailyBriefTime(config.time);
    } catch {
      stdout(`[${new Date().toISOString()}] daily-brief: invalid time '${config.time}' in config — run \`muse setup briefing\` to fix\n`);
      return;
    }
    const nowDate = now();
    let lastFiredISO: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(sidecarFile, "utf8"));
      const parsed = isRecord(raw) ? raw : undefined;
      lastFiredISO = typeof parsed?.lastFired === "string" ? parsed.lastFired : undefined;
    } catch { /* no sidecar yet ⇒ never fired */ }
    if (!shouldFireDailyBrief(nowDate, lastFiredISO, parsedTime.hour, parsedTime.minute)) {
      return;
    }
    try {
      const text = await compose(e);
      await messagingRegistry.send(provider, { destination, text });
      // Mark sent ONLY after a successful send — a failed send is retried
      // next tick, never marked (see AC3: no partial "sent but not delivered").
      mkdirSync(dirname(sidecarFile), { recursive: true });
      writeFileSync(sidecarFile, JSON.stringify({ lastFired: nowDate.toISOString() }), "utf8");
      stdout(`[${nowDate.toISOString()}] daily-brief: delivered\n`);
    } catch (cause) {
      // Fail-soft — a send blip must never break the daemon; next tick retries.
      stdout(`[${nowDate.toISOString()}] daily-brief: send failed (will retry next tick): ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  };
}

export interface MakeSchedulerTickDeps {
  readonly destination: string;
  readonly provider: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly schedulerFile: string;
  readonly pauseFile: string;
  readonly executionTimeoutMs?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (message: string) => void;
  /** Test seam — inject a store instead of a real FileScheduledJobStore. */
  readonly store?: ScheduledJobStore;
  /** Test seam — inject an execution-record store instead of a fresh in-memory one. */
  readonly executionStore?: ScheduledJobExecutionStore;
  /** Test seam — inject the job-execution primitive instead of a real detached spawn. */
  readonly runJob?: typeof runSchedulerJobAndWait;
  readonly now?: () => Date;
}

/**
 * User-scheduled recurring agent prompts ("매일 아침 9시에 오늘 일정
 * 요약해서 보내줘"). Poll model, NOT an in-process cron timer — each tick
 * reads the enabled `agent`-type jobs from the file store and computes
 * due-ness deterministically (`isScheduledJobDue`/`computeNextRunAt`), so a
 * daemon restart never loses an armed job. Execution reuses the DETACHED
 * job-worker path from `commands-jobs.ts` (`runSchedulerJobAndWait`) — this
 * tick never assembles a second in-daemon agent runtime. Quiet hours do NOT
 * suppress this tick (the user explicitly scheduled it — reminders
 * precedent). The scheduler pause file (`muse scheduler pause`) does.
 */
export function makeSchedulerTick(deps: MakeSchedulerTickDeps): () => Promise<void> {
  const { destination, provider, messagingRegistry, schedulerFile, pauseFile, env, stdout } = deps;
  const store: ScheduledJobStore = deps.store ?? new FileScheduledJobStore({ file: schedulerFile });
  const executionRecorder = new ScheduledJobExecutionRecorder(deps.executionStore ?? new InMemoryScheduledJobExecutionStore());
  const runJob = deps.runJob ?? runSchedulerJobAndWait;
  const now = deps.now ?? (() => new Date());
  const fallbackTimeoutMs = deps.executionTimeoutMs ?? defaultExecutionTimeoutMs;
  // In-process overlap guard: a job whose previous run is still in flight
  // when the NEXT tick fires is skipped rather than double-run — mirrors
  // `DynamicScheduler.runningJobIds`. Scoped to this daemon process's
  // lifetime (a restart naturally clears it, which is correct — nothing is
  // actually still running after a restart).
  const runningJobIds = new Set<string>();

  return async (): Promise<void> => {
    const tag = `[${new Date().toISOString()}]`;

    if (await isSchedulerPaused(pauseFile)) {
      stdout(`${tag} scheduler: paused\n`);
      return;
    }

    let jobs: readonly ScheduledJob[];
    try {
      jobs = await store.list();
    } catch (cause) {
      stdout(`${tag} scheduler: failed to read the job store: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return;
    }

    const nowDate = now();
    const due = jobs.filter((job) => job.enabled && job.jobType === "agent" && isScheduledJobDue(job, nowDate));

    let fired = 0;
    const errors: string[] = [];

    for (const job of due) {
      if (runningJobIds.has(job.id)) {
        await store.updateExecutionResult(job.id, "skipped", "skipped: previous run still in progress");
        continue;
      }
      runningJobIds.add(job.id);
      const startedAt = now();
      try {
        await store.updateExecutionResult(job.id, "running");
        const outcome: SchedulerJobOutcome = await runJob(
          job.agentPrompt ?? "",
          { model: job.agentModel },
          { timeoutMs: job.executionTimeoutMs ?? fallbackTimeoutMs },
          { env }
        );

        if (outcome.status === "success") {
          await store.updateExecutionResult(job.id, "success", outcome.text);
          const target = job.notificationChannelId
            ? parseNotificationChannel(job.notificationChannelId, provider)
            : { destination, providerId: provider };
          await messagingRegistry.send(target.providerId, { destination: target.destination, text: outcome.text });
          fired += 1;
          await executionRecorder.recordExecution({
            durationMs: now().getTime() - startedAt.getTime(),
            dryRun: false,
            job,
            result: outcome.text,
            startedAt,
            status: "success"
          });
        } else {
          // "capacity" (concurrency cap reached — nothing spawned) and
          // "timeout"/"failed" both land here: no delivery of partial text,
          // only lastStatus/lastResult + the execution record change.
          const status = outcome.status === "capacity" ? "skipped" : "failed";
          await store.updateExecutionResult(job.id, status, outcome.error);
          errors.push(`${job.name}: ${outcome.error}`);
          await executionRecorder.recordExecution({
            durationMs: now().getTime() - startedAt.getTime(),
            dryRun: false,
            job,
            result: outcome.error,
            startedAt,
            status
          });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await store.updateExecutionResult(job.id, "failed", message);
        errors.push(`${job.name}: ${message}`);
      } finally {
        runningJobIds.delete(job.id);
      }
    }

    stdout(`${tag} scheduler: fired ${fired.toString()}/${due.length.toString()} due`);
    if (errors.length > 0) {
      stdout(`, ${errors.length.toString()} error(s)`);
      for (const error of errors) {
        stdout(`\n  ! ${error}`);
      }
    }
    stdout("\n");
  };
}

export interface MakeFollowupTickDeps {
  readonly followupModel: FollowupModel | undefined;
  readonly destination: string;
  readonly followupsFile: string;
  readonly interruptionBudget: InterruptionBudgetWiring;
  readonly provider: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly stdout: (message: string) => void;
}

export function makeFollowupTick(deps: MakeFollowupTickDeps): () => Promise<void> {
  const { followupModel, destination, followupsFile, interruptionBudget, provider, messagingRegistry, stdout } = deps;
  return async (): Promise<void> => {
    if (!followupModel) {
      stdout(`[${new Date().toISOString()}] followup: skipped (no model resolved)\n`);
      return;
    }
    const summary = await runDueFollowups({
      destination,
      file: followupsFile,
      interruptionBudget,
      model: followupModel.model,
      modelProvider: followupModel.modelProvider,
      providerId: provider,
      registry: messagingRegistry
    });
    const tag = `[${new Date().toISOString()}]`;
    stdout(`${tag} followup: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
    if (summary.errors.length > 0) {
      stdout(`, ${summary.errors.length.toString()} error(s)`);
      for (const error of summary.errors) {
        stdout(`\n  ! ${error}`);
      }
    }
    stdout("\n");
  };
}

export interface MakeCheckinsTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly destination: string;
  readonly interruptionBudget: InterruptionBudgetWiring;
  readonly provider: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly quietHours: QuietHoursOption | undefined;
  readonly stdout: (message: string) => void;
}

export function makeCheckinsTick(deps: MakeCheckinsTickDeps): () => Promise<void> {
  const { env: e, destination, interruptionBudget, provider, messagingRegistry, quietHours, stdout } = deps;
  return async (): Promise<void> => {
    const activeQuietHours = resolveQuietHoursOption(quietHours);
    const summary = await runDueCheckins({
      destination,
      file: checkinsFile(e),
      interruptionBudget,
      providerId: provider,
      registry: messagingRegistry,
      ...(activeQuietHours ? { quietHours: activeQuietHours } : {})
    });
    const tag = `[${new Date().toISOString()}]`;
    stdout(`${tag} checkins: fired ${summary.delivered.toString()}/${summary.due.toString()} due`);
    if (summary.errors.length > 0) {
      stdout(`, ${summary.errors.length.toString()} error(s)`);
      for (const error of summary.errors) stdout(`\n  ! ${error}`);
    }
    stdout("\n");
  };
}

function renderPatternFacts(match: PatternMatch): string {
  return match.category === "weekly-task"
    ? `weekly recurring task on ${match.bucket.weekday}; recent: ${match.relatedTitles.slice(0, 3).join("; ")}; ${match.bucket.matches.toString()}× over ${match.bucket.distinctWeeks.toString()} weeks`
    : `recurring action: ${match.bucket.weekday} ${match.bucket.hourBand}, area "${match.bucket.pathFamily}"; ${match.bucket.matches.toString()}× over ${match.bucket.distinctDays.toString()} days`;
}

export interface MakePatternTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly quietHours: QuietHoursOption | undefined;
  readonly destination: string;
  readonly interruptionBudget: InterruptionBudgetWiring;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly followupModel: FollowupModel | undefined;
  readonly stdout: (message: string) => void;
}

export function makePatternTick(deps: MakePatternTickDeps): () => Promise<void> {
  const { env: e, quietHours, destination, interruptionBudget, messagingRegistry, provider, followupModel, stdout } = deps;
  return async (): Promise<void> => {
    const activeQuietHours = resolveQuietHoursOption(quietHours);
    if (activeQuietHours && isQuietHour(new Date().getHours(), activeQuietHours)) {
      stdout(`[${new Date().toISOString()}] pattern: held (quiet hours)\n`);
      return;
    }
    // SDT criterion (Green & Swets): the pattern category's firing floor
    // adapts to the user's OWN response history — dismiss-heavy raises it,
    // acted-on lowers it. Fail-soft to the default floor on any error.
    let minConfidence: number | undefined;
    try {
      const history = await readProactiveHistory(resolveProactiveHistoryFile(e));
      const stats = summarizeNoticeResponses(history.map((entry) => ({ kind: entry.kind, text: entry.text })));
      const patternStats = stats.get("pattern");
      if (patternStats && patternStats.acted + patternStats.dismissed >= 3) {
        minConfidence = adjustConfidenceFloor(0.7, sdtCriterion(patternStats));
      }
    } catch { /* default floor */ }
    const summary = await runDuePatternNotices({
      destination,
      interruptionBudget,
      patternsFiredFile: resolvePatternsFiredFile(e),
      ...(minConfidence !== undefined ? { select: { minConfidence } } : {}),
      providerId: provider,
      registry: messagingRegistry,
      ...(followupModel
        ? {
            composeSuggestion: (match: PatternMatch): Promise<string | undefined> =>
              synthesizePatternSuggestion(
                {
                  category: match.category,
                  confidence: match.confidence,
                  fallbackSuggestion: match.suggestion,
                  groundedFacts: renderPatternFacts(match)
                },
                {
                  model: followupModel.model,
                  modelProvider: followupModel.modelProvider as Parameters<typeof synthesizePatternSuggestion>[1]["modelProvider"]
                }
              )
          }
        : {})
    });
    stdout(`[${new Date().toISOString()}] pattern: delivered ${summary.delivered.toString()}/${summary.fireable.toString()} fireable\n`);
  };
}

export interface MakeBriefingTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly tasksFile: string;
  readonly leadMinutes: number;
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly briefingCalendarLister: BriefingCalendarLister | undefined;
  readonly knowledgeEnrich: ((query: string) => Promise<string | undefined> | string | undefined) | undefined;
  readonly destination: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly objectivesFile: string;
  readonly provider: string;
  readonly stdout: (message: string) => void;
}

/**
 * Situational briefing — a periodic digest (objective status + imminent
 * tasks + a related note), self-deduped by its sidecar (default 4h window).
 * Opt-in via MUSE_BRIEFING_ENABLED.
 */
export function makeBriefingTick(deps: MakeBriefingTickDeps): () => Promise<void> {
  const { env: e, tasksFile, leadMinutes, calendarRegistry, briefingCalendarLister, knowledgeEnrich, destination, messagingRegistry, objectivesFile, provider, stdout } = deps;
  return async (): Promise<void> => {
    if (!parseBoolean(e.MUSE_BRIEFING_ENABLED, false)) {
      stdout(`[${new Date().toISOString()}] briefing: skipped (set MUSE_BRIEFING_ENABLED)\n`);
      return;
    }
    const now = new Date();
    let imminent: Awaited<ReturnType<typeof deriveBriefingImminent>> = [];
    try {
      imminent = await deriveBriefingImminent(tasksFile, { leadMinutes, now });
    } catch { /* fail-soft — brief objective status only */ }
    const calendarLister = briefingCalendarLister
      ?? (calendarRegistry.list().length > 0 ? (range: Parameters<BriefingCalendarLister>[0]) => calendarRegistry.listEvents(range) : undefined);
    if (calendarLister) {
      try {
        imminent = [...imminent, ...(await deriveCalendarBriefingImminent(calendarLister, { leadMinutes, now }))];
      } catch { /* fail-soft — calendar unavailable */ }
    }
    const summary = await runDueSituationalBriefing({
      birthdayLine: async () => {
        try {
          const contacts = await queryContacts(resolveContactsFile(e));
          return formatBirthdayBriefLine(resolveUpcomingBirthdays(contacts, { now, withinDays: 7 }));
        } catch {
          return undefined;
        }
      },
      destination,
      imminent,
      messagingRegistry,
      now: () => now,
      objectivesFile,
      providerId: provider,
      sidecarFile: e.MUSE_BRIEFING_SIDECAR_FILE?.trim()?.length
        ? e.MUSE_BRIEFING_SIDECAR_FILE.trim()
        : join(homedir(), ".muse", "briefing-fired.json"),
      ...(knowledgeEnrich ? { relatedKnowledge: knowledgeEnrich } : {})
    });
    stdout(`[${now.toISOString()}] briefing: ${summary.delivered > 0 ? "delivered" : "quiet (deduped or nothing to say)"}\n`);
  };
}

export interface MakeReflectionTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly followupModel: FollowupModel | undefined;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly stdout: (message: string) => void;
}

/**
 * Grounded "dreaming" — the daemon synthesises reflections from recent
 * episodes while idle. Off by default; throttled to a slow cadence (default
 * 6h) so it isn't a model call every tick. Silent unless it adds.
 */
export function makeReflectionTick(deps: MakeReflectionTickDeps): () => Promise<void> {
  const { env: e, followupModel, intervalMs, lastRunMs, stdout } = deps;
  return async (): Promise<void> => {
    if (!parseBoolean(e.MUSE_REFLECTION_ENABLED, false) || !followupModel) return;
    const nowMs = Date.now();
    if (!shouldRunReflection(lastRunMs.current, nowMs, intervalMs)) return;
    lastRunMs.current = nowMs;
    try {
      const episodes = (await readEpisodes(resolveEpisodesFile(e))).slice(-30);
      const inputs = episodes.map((ep) => ({ id: ep.id, text: ep.summary }));
      const added = await runReflectionPass(inputs, {
        model: followupModel.model,
        modelProvider: followupModel.modelProvider as Parameters<typeof runReflectionPass>[1]["modelProvider"],
        reflectionsFile: resolveReflectionsFile(e),
        embed: createGateEmbedder(e)
      });
      if (added > 0) stdout(`[${new Date(nowMs).toISOString()}] reflections: +${added.toString()} (see \`muse reflections\`)\n`);
    } catch { /* fail-soft — dreaming is a background nicety */ }
  };
}

export interface MakeRetentionPruneTickDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly workspaceDir: string;
  readonly print: boolean;
  readonly intervalMs: number;
  readonly lastRunMs: TickRunState;
  readonly stdout: (message: string) => void;
}

/**
 * Age-based retention for unbounded append-only local state (.muse/runs,
 * .muse/checkpoints, ~/.muse/action-log.json, ~/.muse/learn-queue.jsonl).
 * `maybeAutoPrune` already self-gates via a persisted ~/.muse/prune-meta.json
 * marker (default 24h) so it survives daemon restarts; this in-memory
 * throttle just avoids re-checking that marker file on every short tick
 * within one daemon's uptime, mirroring the other ticks' `last*Ms` pattern.
 * Never throws (log-and-continue is baked into maybeAutoPrune itself — each
 * of the four targets prunes independently).
 */
export function makeRetentionPruneTick(deps: MakeRetentionPruneTickDeps): () => Promise<void> {
  const { env: e, workspaceDir, print, intervalMs, lastRunMs, stdout } = deps;
  return async (): Promise<void> => {
    const nowMs = Date.now();
    if (lastRunMs.current !== undefined && nowMs - lastRunMs.current < intervalMs) return;
    lastRunMs.current = nowMs;
    try {
      const summary = await maybeAutoPrune({ env: e, workspaceDir });
      if (summary.ran && print) {
        stdout(`[${new Date(nowMs).toISOString()}] retention-prune: ${summary.reason}\n`);
      }
    } catch { /* maybeAutoPrune already never throws — this is a final backstop */ }
  };
}
