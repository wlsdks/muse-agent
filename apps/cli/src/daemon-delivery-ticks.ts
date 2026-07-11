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

import { homedir } from "node:os";
import { join } from "node:path";

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
  runDueBackgroundExitNotices,
  runDueCheckins,
  runDueFollowups,
  runDuePatternNotices,
  runDueProactiveNotices,
  runDueReminders,
  type BriefingCalendarLister,
  type InterruptionBudgetWiring,
  type QuietHourRange
} from "@muse/proactivity";
import { formatBirthdayBriefLine, queryContacts, readEpisodes, readProactiveHistory, resolveUpcomingBirthdays } from "@muse/stores";

import { backgroundStoreFile } from "./commands-background.js";
import { checkinsFile } from "./commands-checkins.js";
import type { FollowupModel } from "./commands-daemon-connections.js";
import { resolveReflectionsFile, runReflectionPass, shouldRunReflection } from "./commands-reflections.js";
import { maybeAutoPrune } from "./local-state-retention.js";
import { createIndexedProactiveInvestigator } from "./proactive-notes-recall.js";

import type { TickRunState } from "./daemon-selflearn-ticks.js";

export interface MakeProactiveTickDeps {
  readonly calendarRegistry: CalendarProviderRegistry;
  readonly destination: string;
  readonly historyFile: string;
  readonly leadMinutes: number;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly provider: string;
  readonly quietHours: QuietHourRange | undefined;
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
    const summary = await runDueProactiveNotices({
      ...(calendarRegistry.list().length > 0 ? { calendarRegistry } : {}),
      destination,
      historyFile,
      investigate: proactiveInvestigator,
      leadMinutes,
      messagingRegistry,
      providerId: provider,
      ...(quietHours ? { quietHours } : {}),
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
  readonly quietHours: QuietHourRange | undefined;
  readonly stdout: (message: string) => void;
}

export function makeCheckinsTick(deps: MakeCheckinsTickDeps): () => Promise<void> {
  const { env: e, destination, interruptionBudget, provider, messagingRegistry, quietHours, stdout } = deps;
  return async (): Promise<void> => {
    const summary = await runDueCheckins({
      destination,
      file: checkinsFile(e),
      interruptionBudget,
      providerId: provider,
      registry: messagingRegistry,
      ...(quietHours ? { quietHours } : {})
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
  readonly quietHours: QuietHourRange | undefined;
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
    if (quietHours && isQuietHour(new Date().getHours(), quietHours)) {
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
