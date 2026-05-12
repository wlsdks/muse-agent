import {
  DefaultActiveContextProvider,
  DefaultToolFilter,
  InMemoryTelemetryAggregator,
  StoreBackedEpisodicRecallProvider,
  type ActiveContextProvider,
  type EpisodicRecallProvider,
  type InboxContextProvider,
  type ReminderHint,
  type RemindersResolver,
  type TelemetryAggregator,
  type ToolFilter
} from "@muse/agent-core";
import { CalendarProviderRegistry, type CalendarEvent } from "@muse/calendar";
import { readReminders } from "@muse/mcp";
import type { ConversationSummaryStore, TaskMemoryStore, UserMemoryStore } from "@muse/memory";
import { FileBackedInboxContextProvider, type InboxSourceConfig } from "@muse/messaging";

import {
  resolveDiscordInboxFile,
  resolveInboxInjectionCursorFile,
  resolveLineInboxFile,
  resolveMessagingCredentialsFile,
  resolveRemindersFile,
  resolveSlackInboxFile,
  resolveTelegramInboxFile
} from "./provider-paths.js";
import { clampPositive, readCredentialsSync, stringField } from "./provider-utils.js";

import type { MuseEnvironment } from "./index.js";

/**
 * Context Engineering Phase 1 — assemble a `DefaultActiveContextProvider`
 * that always carries current time + timezone, and (when user memory is
 * available) reads `working_hours` / `timezone` / `current_focus` from
 * `UserMemoryStore.preferences`. Returns `undefined` when
 * `MUSE_ACTIVE_CONTEXT_ENABLED=false`.
 */
export function buildActiveContextProvider(
  env: MuseEnvironment,
  userMemoryStore: UserMemoryStore | undefined,
  taskMemoryStore?: TaskMemoryStore,
  calendarRegistry?: CalendarProviderRegistry
): ActiveContextProvider | undefined {
  if (env.MUSE_ACTIVE_CONTEXT_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const calendarEventsResolver = calendarRegistry && env.MUSE_ACTIVE_CONTEXT_CALENDAR_ENABLED?.trim().toLowerCase() !== "false"
    ? {
        async resolve(options: { readonly nowIso: string; readonly timezone: string; readonly userId?: string }) {
          try {
            const now = new Date(options.nowIso);
            const dayStart = new Date(now);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(now);
            dayEnd.setHours(23, 59, 59, 999);
            const limit = clampPositive(env.MUSE_ACTIVE_CONTEXT_CALENDAR_LIMIT, 8);
            const events = await calendarRegistry.listEvents({ from: dayStart, to: dayEnd });
            return [...events]
              .sort((a: CalendarEvent, b: CalendarEvent) => a.startsAt.getTime() - b.startsAt.getTime())
              .slice(0, limit)
              .map((event) => ({
                allDay: event.allDay,
                endIso: event.endsAt.toISOString(),
                ...(event.location ? { location: event.location } : {}),
                startIso: event.startsAt.toISOString(),
                title: event.title
              }));
          } catch {
            return undefined;
          }
        }
      }
    : undefined;
  const activeTaskResolver = taskMemoryStore
    ? {
        async resolve(options: { readonly userId?: string; readonly sessionId?: string }) {
          const { sessionId, userId } = options;
          if (!sessionId) {
            return undefined;
          }
          try {
            const state = await taskMemoryStore.findActiveBySession(sessionId, userId);
            if (!state) {
              return undefined;
            }
            return {
              id: state.taskId,
              ...(state.metadata?.dueIso ? { dueIso: state.metadata.dueIso } : {}),
              title: state.goal
            };
          } catch {
            return undefined;
          }
        }
      }
    : undefined;
  // Iter 41: read pending reminders from the local store and feed
  // them into [Active Context] so the agent can say "you asked me
  // to remind you about X at 3 — it's 2:55" without an extra tool
  // call. Opt-out via `MUSE_ACTIVE_CONTEXT_REMINDERS_ENABLED=false`.
  const remindersResolver: RemindersResolver | undefined =
    env.MUSE_ACTIVE_CONTEXT_REMINDERS_ENABLED?.trim().toLowerCase() === "false"
      ? undefined
      : {
        async resolve(): Promise<readonly ReminderHint[] | undefined> {
          try {
            const reminders = await readReminders(resolveRemindersFile(env));
            return reminders
              .filter((reminder) => reminder.status === "pending")
              .map((reminder) => ({ dueIso: reminder.dueAt, text: reminder.text }));
          } catch {
            return undefined;
          }
        }
      };
  return new DefaultActiveContextProvider({
    ...(activeTaskResolver ? { activeTaskResolver } : {}),
    ...(calendarEventsResolver ? { calendarEventsResolver } : {}),
    ...(env.MUSE_DEFAULT_TIMEZONE?.trim() ? { defaultTimezone: env.MUSE_DEFAULT_TIMEZONE.trim() } : {}),
    ...(remindersResolver ? { remindersResolver } : {}),
    ...(userMemoryStore ? { userMemoryProvider: userMemoryStore } : {})
  });
}

/**
 * Context Engineering Phase 2 — build a `FileBackedInboxContextProvider`
 * over every messaging provider that has a registered token. Each
 * provider gets its own cursor file under `~/.muse/{id}-inbox-injection.json`
 * (overrideable via `MUSE_{ID}_INBOX_INJECTION_CURSOR_FILE`). Returns
 * `undefined` when no messaging provider is configured OR when
 * `MUSE_INBOX_CONTEXT_ENABLED=false`.
 */
export function buildInboxContextProvider(env: MuseEnvironment): InboxContextProvider | undefined {
  if (env.MUSE_INBOX_CONTEXT_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const sources: InboxSourceConfig[] = [];
  const credentials = readCredentialsSync(resolveMessagingCredentialsFile(env));
  const hasToken = (envKey: string, providerId: string): boolean => {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv && fromEnv.length > 0) {
      return true;
    }
    const fromFile = stringField(credentials[providerId], "token");
    return Boolean(fromFile && fromFile.length > 0);
  };
  if (hasToken("MUSE_TELEGRAM_BOT_TOKEN", "telegram")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "telegram"),
      inboxFile: resolveTelegramInboxFile(env),
      providerId: "telegram"
    });
  }
  if (hasToken("MUSE_DISCORD_BOT_TOKEN", "discord")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "discord"),
      inboxFile: resolveDiscordInboxFile(env),
      providerId: "discord"
    });
  }
  if (hasToken("MUSE_SLACK_BOT_TOKEN", "slack")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "slack"),
      inboxFile: resolveSlackInboxFile(env),
      providerId: "slack"
    });
  }
  if (hasToken("MUSE_LINE_CHANNEL_ACCESS_TOKEN", "line")) {
    sources.push({
      cursorFile: resolveInboxInjectionCursorFile(env, "line"),
      inboxFile: resolveLineInboxFile(env),
      providerId: "line"
    });
  }
  if (sources.length === 0) {
    return undefined;
  }
  const perProviderLimit = clampPositive(env.MUSE_INBOX_INJECT_LIMIT, 20);
  const totalLimit = clampPositive(env.MUSE_INBOX_INJECT_TOTAL_LIMIT, 80);
  return new FileBackedInboxContextProvider({ perProviderLimit, sources, totalLimit });
}

/**
 * Context Engineering Phase 3 — build a `StoreBackedEpisodicRecallProvider`
 * over the persisted conversation-summary store. Returns `undefined`
 * when `MUSE_EPISODIC_RECALL_ENABLED=false` or when no store is
 * available. Jaccard token-overlap recall — no embeddings, no
 * pgvector. Default on so newly-shipped users get cross-session
 * memory the moment their first session compacts.
 */
export function buildEpisodicRecallProvider(
  env: MuseEnvironment,
  summaryStore: ConversationSummaryStore | undefined
): EpisodicRecallProvider | undefined {
  if (env.MUSE_EPISODIC_RECALL_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  if (!summaryStore || typeof summaryStore.listAll !== "function") {
    return undefined;
  }
  const topK = clampPositive(env.MUSE_EPISODIC_RECALL_TOPK, 3);
  const maxFetched = clampPositive(env.MUSE_EPISODIC_RECALL_MAX_FETCHED, 200);
  const minScoreRaw = env.MUSE_EPISODIC_RECALL_MIN_SCORE?.trim();
  const minScoreParsed = minScoreRaw ? Number.parseFloat(minScoreRaw) : Number.NaN;
  const minScore = Number.isFinite(minScoreParsed) && minScoreParsed >= 0
    ? minScoreParsed
    : 0.15;
  return new StoreBackedEpisodicRecallProvider({
    maxFetched,
    minScore,
    store: summaryStore,
    topK
  });
}

/**
 * Context Engineering Phase 4 — opt-in `DefaultToolFilter` controlled
 * by `MUSE_TOOL_FILTER_ENABLED=true`. Default off so existing setups
 * see no behavioural change.
 */
export function buildToolFilter(env: MuseEnvironment): ToolFilter | undefined {
  if (env.MUSE_TOOL_FILTER_ENABLED?.trim().toLowerCase() !== "true") {
    return undefined;
  }
  return new DefaultToolFilter();
}

/**
 * In-process telemetry aggregator (iter 38 — wiring the surface
 * iters 8 / 17 / 26 / 37 built but never instantiated in
 * production). Default ON; `MUSE_TELEMETRY_AGGREGATOR_ENABLED=false`
 * skips construction (returns undefined → AgentRuntime no-ops the
 * `recordTelemetry` call so per-run telemetry is free of overhead).
 *
 * The aggregator is in-process and bounded by `capacity` (default
 * 10k events ~= a week of moderate use); restart wipes state. A
 * durable Kysely-backed sink can layer on later — every consumer
 * accesses the same `TelemetryAggregator` interface.
 */
export function buildTelemetryAggregator(env: MuseEnvironment): TelemetryAggregator | undefined {
  if (env.MUSE_TELEMETRY_AGGREGATOR_ENABLED?.trim().toLowerCase() === "false") {
    return undefined;
  }
  const capacityRaw = env.MUSE_TELEMETRY_AGGREGATOR_CAPACITY?.trim();
  const capacity = capacityRaw && /^\d+$/u.test(capacityRaw)
    ? Number.parseInt(capacityRaw, 10)
    : undefined;
  return new InMemoryTelemetryAggregator(capacity !== undefined ? { capacity } : {});
}
