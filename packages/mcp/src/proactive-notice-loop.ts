/**
 * Proactive surfacing Phase A + B — calendar imminence + task due-soon push.
 *
 * Companion to `runDueReminders` for events and tasks the user
 * *didn't* set up a reminder for. Scans the calendar registry for
 * events starting within `leadMinutes` AND (when wired) the
 * personal-tasks store for open tasks whose `dueAt` falls in the
 * same window. Delivers a one-line notice per imminent item via
 * the messaging registry, deduped through a shared sidecar so a
 * single item fires at most once per `{kind, id, startIso}` tuple.
 *
 * A rescheduled item (same id, new startsAt / dueAt) re-fires.
 *
 * The function is data-only — registries, files and `now` are
 * injected so tests can fake the upstream without touching real
 * provider APIs.
 */


import type { CalendarEvent, CalendarProviderRegistry } from "@muse/calendar";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { redactSecretsInText } from "@muse/shared";

import { sendWithRetry } from "./messaging-retry.js";
import { isQuietHour, type QuietHourRange } from "./quiet-hours.js";

/**
 * Structural shape of the Phase D broker (defined in
 * `@muse/agent-core/AgentInitiatedNoticeBroker`). We avoid the
 * import to keep `@muse/mcp` from depending on `@muse/agent-core`
 * — the only call site here is the optional `publish` fan-out.
 */
export interface AgentInitiatedNoticeBrokerLike {
  publish(userId: string, notice: {
    readonly kind: string;
    readonly text: string;
    readonly generatedAt: string;
    readonly sourceId?: string;
  }): void;
}

import { appendProactiveHistory } from "./personal-proactive-history-store.js";
import { readTasks, type PersistedTask } from "./personal-tasks-store.js";
import { appendSurfaced, avoidedSourceKeys, readTrustLedger, sourceKey, withinDailyCap, type TrustLedgerEntry } from "./proactive-trust-ledger.js";
import { firedKey, readProactiveFired, readSessionLock, writeProactiveFired, type ProactiveFiredEntry, type ProactiveFiredKind } from "./proactive-notice-store.js";
export { firedKey, readProactiveFired, readSessionLock, writeProactiveFired, writeSessionLock, type ProactiveFiredEntry, type ProactiveFiredKind, type SessionLockPayload } from "./proactive-notice-store.js";

/**
 * Order imminent items soonest-first so the most time-critical one
 * interrupts first (Proactive Agent, arXiv 2410.12361: prioritise WHAT to
 * surface). Items are collected per-source (calendar, then tasks), so without
 * this a task due in 2 min could fire after a calendar event 9 min out purely
 * by insertion order. Stable: equal start times keep their collection order.
 * Non-finite / missing start times sort last (deterministic, never NaN-poison).
 */
export function sortImminentByStart<T extends { readonly startsAt: Date }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const aMs = a.startsAt instanceof Date ? a.startsAt.getTime() : Number.NaN;
    const bMs = b.startsAt instanceof Date ? b.startsAt.getTime() : Number.NaN;
    const aOk = Number.isFinite(aMs);
    const bOk = Number.isFinite(bMs);
    if (aOk && bOk) return aMs - bMs;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}

interface ImminentItem {
  readonly kind: ProactiveFiredKind;
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly text: string;
  /**
   * Short factual description fed to the agent-synthesis prompt
   * when Phase D is active. The flat `text` already contains it,
   * but `factSheet` strips emoji + redundant suffix so the LLM
   * has a clean input.
   */
  readonly factSheet: string;
}

/**
 * Phase D — track when the user was last seen on a Muse surface
 * (REST /api/chat, /api/chat/stream, or any future presence pub/sub
 * client). The proactive loop reads this to decide whether to
 * compose a one-shot agent-synthesized heads-up or fall back to
 * the flat Phase A/B notice string.
 */
export interface ProactiveActivitySource {
  /**
   * Wall-clock ms (Date.now() shape) of the most recent activity,
   * or undefined when the user has never been seen.
   */
  lastActivityMs(): number | undefined;
}

/**
 * A delivery target for a proactive notice that is not the
 * messaging registry — e.g. the terminal session the user is
 * currently looking at. This seam only wires the routing; the
 * concrete REPL renderer is supplied separately.
 */
export interface ProactiveNoticeSink {
  deliver(notice: {
    readonly text: string;
    readonly title: string;
    readonly kind: string;
  }): Promise<void> | void;
}

export type ProactiveSinkChoice = "terminal" | "messaging";

/**
 * Route a proactive notice to the surface the user is looking at:
 * the terminal sink when one is wired AND the activity source has
 * seen the user on a local surface, messaging otherwise. Staleness
 * of that presence (a backgrounded terminal) is handled elsewhere;
 * here "recorded at all" is sufficient.
 */
export function selectProactiveSink(
  activitySource: ProactiveActivitySource | undefined,
  hasTerminalSink: boolean,
  freshness?: { readonly nowMs: number; readonly maxAgeMs: number }
): ProactiveSinkChoice {
  if (!hasTerminalSink) {
    return "messaging";
  }
  const last = activitySource?.lastActivityMs();
  if (last === undefined) {
    return "messaging";
  }
  // A backgrounded / abandoned terminal still reports a (now stale)
  // lastActivityMs; routing to it would render the notice into a
  // surface nobody is watching and the user never gets the ping.
  // Presence older than the window is treated as absent → messaging.
  if (freshness && freshness.nowMs - last > freshness.maxAgeMs) {
    return "messaging";
  }
  return "terminal";
}

/**
 * Structural duck-type of `@muse/agent-core`'s `AgentRuntime.run`.
 * Avoids a cross-package dep (@muse/mcp doesn't import agent-core
 * to dodge the circular path that auto-extract had to dodge too).
 * Consumers (apps/api) pass the real AgentRuntime — TS structural
 * typing makes that work without a runtime type tag.
 *
 * @deprecated Phase D synthesis is one-shot text generation; the
 * tool registry the AgentRuntime wires in causes small models
 * (≤ 3B params) to emit raw `tool_calls` JSON instead of prose.
 * Prefer `ProactiveModelProviderLike` (set `modelProvider` in
 * the options).
 */
export interface ProactiveAgentRuntimeLike {
  run(input: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
  }): Promise<{ readonly response: { readonly output: string } }>;
}

/**
 * Structural duck-type of `@muse/model`'s `ModelProvider.generate`.
 * Phase D synthesis only needs raw text generation — no tools, no
 * agent loop. Calling `generate({ tools: undefined })` keeps the
 * model from seeing the (otherwise distracting) `muse.tasks.*` /
 * `muse.calendar.*` registry and emitting tool-call JSON instead
 * of plain prose. Discovered via local-LLM dogfood with qwen2.5
 * 1.5B; cloud models silently accepted the system instruction
 * but small local models followed the tools instead.
 */
export interface ProactiveModelProviderLike {
  generate(request: {
    readonly model: string;
    readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
  }): Promise<{ readonly output: string }>;
}

export interface RunDueProactiveNoticesOptions {
  readonly calendarRegistry?: CalendarProviderRegistry;
  /**
   * Optional autonomous investigator. Given the imminent item's
   * context it returns a one-line finding (a notes / tool / web
   * lookup of the likely UNSTATED need) appended to the proactive
   * notice — so Muse doesn't just announce "X in 30 min" but also
   * surfaces "…and here's the related doc," unasked. Fail-open: a
   * thrown / empty result just omits the finding.
   */
  readonly investigate?: (item: {
    readonly title: string;
    readonly kind: string;
    readonly factSheet: string;
  }) => Promise<string | undefined>;
  /**
   * Personal-tasks store path (`~/.muse/tasks.json` by default).
   * When set, open tasks whose `dueAt` falls in
   * `[now, now + leadMinutes]` are surfaced alongside calendar
   * events.
   */
  readonly tasksFile?: string;
  readonly messagingRegistry: MessagingProviderRegistry;
  /** Messaging provider id (e.g. "telegram"). */
  readonly providerId: string;
  /** Messaging destination (chat id, channel id, etc). */
  readonly destination: string;
  /**
   * How far in advance to fire. Events / tasks within
   * `[now, now + leadMinutes]` are candidates. Default 10 min.
   */
  readonly leadMinutes?: number;
  /** Dedupe sidecar path. Required — without it, every tick re-fires. */
  readonly sidecarFile: string;
  /**
   * Quiet-hours window during which a "nice to know" notice is suppressed on
   * EITHER sink. The terminal sink is already gated by `gateProactiveNoticeSink`,
   * but the messaging sink delivers directly — without this, a notice would still
   * message the user at night. Gating here closes that bypass uniformly.
   */
  readonly quietHours?: QuietHourRange;
  /** Injectable clock for tests. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Phase D — agent-initiated turn. When `agentModel` is set AND the
   * activity source reports recent activity (within
   * `activeSessionWindowMs`), the daemon emits a one-shot text
   * generation with a synthesis prompt to compose a JARVIS-style
   * heads-up instead of the flat "⏰ {title} in {N} min" string.
   * On error / timeout / missing window, falls back to the flat text.
   *
   * Pass either `modelProvider` (preferred — raw text gen, no tools)
   * OR `agentRuntime` (legacy — full agent pipeline including tools,
   * which can cause ≤ 3B local models to emit tool-call JSON).
   */
  readonly modelProvider?: ProactiveModelProviderLike;
  readonly agentRuntime?: ProactiveAgentRuntimeLike;
  readonly agentModel?: string;
  /**
   * Optional persona preamble — caller-built persona snapshot that
   * names the user, their language, reply preferences. Prepended to
   * the Phase D system prompt so the synthesized notice addresses
   * the user by name and respects their preferences ("Stark님,
   * Q3 메모가 5분 후 마감입니다" instead of the generic
   * "Send Q3 budget memo due in 5 min"). Empty / undefined → no
   * personalisation, the daemon falls back to the generic prompt.
   */
  readonly personaPreamble?: string;
  /**
   * Faithfulness gate for the Phase D synthesized notice. A proactive notice is an
   * UNASKED, push-delivered claim (often to a messaging channel) — higher-trust than
   * a Q&A answer because the user didn't prompt it, so a confabulated detail ("standup
   * moved to 3pm in Room B") is maximally damaging. When supplied, the synthesized
   * prose is re-checked against the item's factSheet; a NO / throw / empty-evidence
   * verdict FAILS CLOSE to the verbatim, store-grounded `item.text` (never silence,
   * never the unverified synthesis). Absent → the prose is delivered unverified
   * (back-compat; the daemon caller supplies it).
   */
  readonly reverify?: NoticeGroundingReverify;
  readonly activitySource?: ProactiveActivitySource;
  /** Default 5 minutes (300_000 ms). */
  readonly activeSessionWindowMs?: number;
  /**
   * Mirrors reminder firing's history sidecar. When set, every
   * delivery attempt (success or failure) is appended to this file
   * via `appendProactiveHistory` so the user / agent can audit
   * "did the 3pm meeting notice land?" weeks later — even if the
   * underlying calendar event has since been edited or removed.
   */
  readonly historyFile?: string;
  /**
   * Phase D broker. When set, every successfully synthesised /
   * delivered notice is ALSO published here so live
   * `/api/agent-notices/stream` subscribers see it inline. The
   * `userId` lets the broker fan to the right subscriber bucket;
   * the messaging-sink delivery is unchanged either way.
   *
   * Fail-soft: a broker publish never throws (the in-memory
   * implementation is non-blocking), but the try/catch around
   * the messaging send also guards this call.
   */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBrokerLike;
  readonly agentInitiatedNoticeUserId?: string;
  /**
   * Path to the session-lock marker file. When the file
   * exists and its payload's `until` timestamp is still in the
   * future, the proactive loop skips firing for this tick and
   * surfaces the marker via `sessionLockedUntil` in the summary so
   * the caller can log it. Independent of agent-active-window
   * gating: a session lock blocks both flat and Phase-D notices.
   */
  readonly sessionLockFile?: string;
  /**
   * When set AND the activity source reports a recorded local
   * presence, the notice is delivered through this sink instead of
   * the messaging registry. Messaging stays the fallback when no
   * presence is recorded.
   */
  readonly terminalSink?: ProactiveNoticeSink;
  /**
   * Trust-instrumentation sidecar (`~/.muse/proactive-trust.json`).
   * When set, every delivered notice is recorded here for the precision
   * scoreboard, and a source the user has vetoed (`muse trust veto …`)
   * is silenced — learned avoidance, so proactivity earns its place.
   * Fail-open: a ledger read/write error never blocks a delivery.
   */
  readonly trustLedgerFile?: string;
  /**
   * Cap on how many notices may surface in a trailing 24h window
   * (counted from the trust ledger). Opt-in — unset / non-positive
   * leaves surfacing uncapped (legacy behaviour). Requires
   * `trustLedgerFile`.
   */
  readonly dailyCap?: number;
}

export interface RunDueProactiveNoticesSummary {
  /** Count of imminent items found (whether or not they were fired). */
  readonly imminent: number;
  /** Count of notices actually delivered this run. */
  readonly fired: number;
  /** Human-readable error strings, one per failed delivery. */
  readonly errors: readonly string[];
  /**
   * When a session lock was active for this tick, the
   * ISO timestamp the lock expires at. Otherwise undefined. Callers
   * use this to log "skipped tick — locked until …" lines so the
   * user understands why nothing fired during a focus window.
   */
  readonly sessionLockedUntil?: string;
}

export async function runDueProactiveNotices(
  options: RunDueProactiveNoticesOptions
): Promise<RunDueProactiveNoticesSummary> {
  const now = options.now ?? (() => new Date());
  // `??` does NOT catch NaN/Infinity: an env-derived
  // (Number("")) leadMinutes would make `now + NaN*60_000` an
  // Invalid Date cutoff, so every `startsAt <= cutoff` is false
  // and the daemon silently surfaces nothing. Non-finite → default.
  const leadMinutes = typeof options.leadMinutes === "number" && Number.isFinite(options.leadMinutes)
    ? options.leadMinutes
    : 10;
  const nowDate = now();

  // Fail-open DND: a read/parse error treats the session as
  // unlocked so a corrupted marker can't permanently gag the
  // daemon. sessionLockedUntil is surfaced so it can be logged.
  if (options.sessionLockFile) {
    const lock = await readSessionLock(options.sessionLockFile, nowDate);
    if (lock) {
      return { errors: [], fired: 0, imminent: 0, sessionLockedUntil: lock };
    }
  }

  const cutoff = new Date(nowDate.getTime() + leadMinutes * 60_000);

  const errors: string[] = [];
  const imminent: ImminentItem[] = [];

  if (options.calendarRegistry) {
    try {
      const events = await options.calendarRegistry.listEvents({ from: nowDate, to: cutoff });
      for (const event of events) {
        if (event.allDay) continue;
        // A malformed feed / hand-edited ~/.muse/calendar.json yields
        // an Invalid Date here. NaN range comparisons are all false,
        // so without this it slips through and `.toISOString()` below
        // throws — aborting the whole tick (every later imminent item
        // silently lost). Mirrors the task path's dueAt NaN guard.
        if (Number.isNaN(event.startsAt.getTime())) continue;
        if (event.startsAt < nowDate || event.startsAt > cutoff) continue;
        if (isCalendarOptedOut(event)) continue;
        imminent.push({
          factSheet: calendarFactSheet(event, nowDate),
          id: event.id,
          kind: "calendar",
          startsAt: event.startsAt,
          text: calendarNoticeText(event, nowDate),
          title: event.title
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`calendar.listEvents failed: ${message}`);
    }
  }

  if (options.tasksFile) {
    try {
      const tasks = await readTasks(options.tasksFile);
      for (const task of tasks) {
        if (task.status !== "open") continue;
        if (!task.dueAt) continue;
        if (task.proactive === false) continue;
        const dueAt = new Date(task.dueAt);
        if (Number.isNaN(dueAt.getTime())) continue;
        if (dueAt < nowDate || dueAt > cutoff) continue;
        imminent.push({
          factSheet: taskFactSheet(task, dueAt, nowDate),
          id: task.id,
          kind: "task",
          startsAt: dueAt,
          text: taskNoticeText(task, dueAt, nowDate),
          title: task.title
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`tasks.readTasks failed: ${message}`);
    }
  }

  if (imminent.length === 0) {
    return { errors, fired: 0, imminent: 0 };
  }

  const fired = await readProactiveFired(options.sidecarFile);
  const seen = new Set(fired.map((entry) => firedKey(entry)));
  let firedThisRun = 0;
  let nextFired: readonly ProactiveFiredEntry[] = fired;

  // Trust instrumentation (Phase 2): learned avoidance + daily cap.
  // Fail-open — a corrupt/unreadable ledger never gags the daemon.
  const trustLedger = options.trustLedgerFile
    ? await readTrustLedger(options.trustLedgerFile).catch(() => [])
    : [];
  const avoided = avoidedSourceKeys(trustLedger);
  const capEnabled = options.trustLedgerFile !== undefined
    && typeof options.dailyCap === "number"
    && Number.isFinite(options.dailyCap)
    && options.dailyCap > 0;
  const ledgerForCap: TrustLedgerEntry[] = [...trustLedger];

  // Phase D — decide once whether the active-session window allows
  // agent-synthesized notices for this tick. All three pieces must
  // be wired AND the activity tracker must report something within
  // the window. Re-checking per-item would let the window expire
  // mid-tick.
  const phaseDActive = isActiveSessionWindow(nowDate, options);
  const terminalPresenceMaxAgeMs =
    typeof options.activeSessionWindowMs === "number" && Number.isFinite(options.activeSessionWindowMs)
      ? options.activeSessionWindowMs
      : DEFAULT_ACTIVE_WINDOW_MS;
  const sinkChoice = selectProactiveSink(
    options.activitySource,
    options.terminalSink !== undefined,
    { maxAgeMs: terminalPresenceMaxAgeMs, nowMs: nowDate.getTime() }
  );

  for (const item of sortImminentByStart(imminent)) {
    const candidate: ProactiveFiredEntry = {
      firedAt: now().toISOString(),
      id: item.id,
      kind: item.kind,
      startIso: item.startsAt.toISOString()
    };
    const key = firedKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    // Learned avoidance — the user vetoed this source; never re-surface it.
    if (avoided.has(sourceKey(item.kind, item.id))) {
      continue;
    }
    // Daily cap — once the trailing-24h budget is spent, stop surfacing
    // for this tick so a burst of triggers can't flood the user.
    if (capEnabled && !withinDailyCap(ledgerForCap, nowDate.getTime(), options.dailyCap!)) {
      break;
    }

    let rawNoticeText = phaseDActive
      ? await synthesizeNoticeText(item, options).catch((cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          errors.push(`${item.kind}:${item.id} synthesis: ${message}`);
          return item.text;
        })
      : item.text;
    // Anticipation: autonomously investigate the likely unstated
    // need behind this item and surface the finding unasked. Fail-
    // open — a failed/empty investigation just omits the finding;
    // the notice still fires.
    if (options.investigate) {
      try {
        const finding = await options.investigate({
          factSheet: item.factSheet,
          kind: item.kind,
          title: item.title
        });
        if (finding && finding.trim().length > 0) {
          rawNoticeText = `${rawNoticeText}\n${finding.trim()}`;
        }
      } catch {
        // investigation failed — keep the base notice
      }
    }
    // Scrub before any downstream sink — the synthesised notice
    // saw persona facts + task summaries that may quote a secret.
    const noticeText = redactSecretsInText(rawNoticeText);

    const firedAtIso = now().toISOString();
    // Quiet-hours suppression applied to BOTH sinks (the messaging sink would
    // otherwise bypass the terminal-only `gateProactiveNoticeSink` and nag at
    // night). Matches the terminal gate's drop semantics: the notice is skipped,
    // not deferred — these are "nice to know" ambient notices.
    const quietNow = options.quietHours !== undefined && isQuietHour(now().getHours(), options.quietHours);
    try {
      if (quietNow) {
        // suppressed — deliver nothing on either sink
      } else if (sinkChoice === "terminal" && options.terminalSink) {
        await options.terminalSink.deliver({ kind: item.kind, text: noticeText, title: item.title });
      } else {
        await sendWithRetry(
          options.messagingRegistry,
          options.providerId,
          { destination: options.destination, text: noticeText }
        );
      }
      firedThisRun += 1;
      nextFired = [...nextFired, candidate];
      seen.add(key);
      // Trust ledger (Phase 2): record the delivered surface for the
      // precision scoreboard + count it against the daily cap. Fail-open.
      if (options.trustLedgerFile) {
        const surfacedAtMs = nowDate.getTime();
        ledgerForCap.push({ kind: item.kind, sourceKey: sourceKey(item.kind, item.id), surfacedAtMs, title: item.title });
        try {
          await appendSurfaced(options.trustLedgerFile, { id: item.id, kind: item.kind, surfacedAtMs, title: item.title });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          errors.push(`trust ledger write failed: ${message}`);
        }
      }
      // Phase D broker fan-out: publish the same notice so live
      // chat-stream subscribers see it inline. Always alongside the
      // messaging-sink delivery — not a replacement. Fail-soft per
      // the broker contract (in-memory broker never throws).
      if (options.agentInitiatedNoticeBroker && options.agentInitiatedNoticeUserId) {
        options.agentInitiatedNoticeBroker.publish(options.agentInitiatedNoticeUserId, {
          generatedAt: firedAtIso,
          kind: item.kind,
          sourceId: item.id,
          text: noticeText
        });
      }
      if (options.historyFile) {
        await appendProactiveHistory(options.historyFile, {
          destination: options.destination,
          firedAtIso,
          itemId: item.id,
          kind: item.kind,
          providerId: sinkChoice === "terminal" ? "terminal" : options.providerId,
          startIso: item.startsAt.toISOString(),
          status: "delivered",
          text: noticeText,
          title: item.title
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${item.kind}:${item.id}: ${message}`);
      if (options.historyFile) {
        await appendProactiveHistory(options.historyFile, {
          destination: options.destination,
          error: message,
          firedAtIso,
          itemId: item.id,
          kind: item.kind,
          providerId: options.providerId,
          startIso: item.startsAt.toISOString(),
          status: "failed",
          text: noticeText,
          title: item.title
        });
      }
    }
  }

  if (firedThisRun > 0) {
    try {
      await writeProactiveFired(options.sidecarFile, nextFired);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`sidecar write failed: ${message}`);
    }
  }

  return { errors, fired: firedThisRun, imminent: imminent.length };
}

/**
 * Phase C marker — case-insensitive `[no-proactive]` anywhere in the
 * event's user-visible text (title or notes). Provider-neutral so
 * the same opt-out works against every CalendarProvider without
 * needing per-backend extended-property plumbing.
 */
function isCalendarOptedOut(event: CalendarEvent): boolean {
  const marker = "[no-proactive]";
  if (event.title.toLowerCase().includes(marker)) return true;
  if (event.notes && event.notes.toLowerCase().includes(marker)) return true;
  return false;
}

function calendarNoticeText(event: CalendarEvent, now: Date): string {
  const minutes = Math.max(0, Math.round((event.startsAt.getTime() - now.getTime()) / 60_000));
  const head = minutes === 0
    ? `⏰ ${event.title} starting now`
    : `⏰ ${event.title} in ${minutes} min`;
  return event.location ? `${head} (${event.location})` : head;
}

function taskNoticeText(task: PersistedTask, dueAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((dueAt.getTime() - now.getTime()) / 60_000));
  return minutes === 0
    ? `📋 ${task.title} due now`
    : `📋 ${task.title} due in ${minutes} min`;
}

function calendarFactSheet(event: CalendarEvent, now: Date): string {
  const minutes = Math.max(0, Math.round((event.startsAt.getTime() - now.getTime()) / 60_000));
  const parts = [
    `kind: calendar event`,
    `title: ${event.title}`,
    `starts in: ${minutes.toString()} minute(s)`,
    `start ISO: ${event.startsAt.toISOString()}`
  ];
  if (event.location) parts.push(`location: ${event.location}`);
  if (event.notes) parts.push(`notes: ${event.notes.slice(0, 200)}`);
  return parts.join("\n");
}

function taskFactSheet(task: PersistedTask, dueAt: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((dueAt.getTime() - now.getTime()) / 60_000));
  const parts = [
    `kind: task`,
    `title: ${task.title}`,
    `due in: ${minutes.toString()} minute(s)`,
    `due ISO: ${dueAt.toISOString()}`
  ];
  if (task.notes) parts.push(`notes: ${task.notes.slice(0, 200)}`);
  if (task.tags && task.tags.length > 0) parts.push(`tags: ${task.tags.join(", ")}`);
  return parts.join("\n");
}

const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60_000;

function isActiveSessionWindow(now: Date, options: RunDueProactiveNoticesOptions): boolean {
  if ((!options.modelProvider && !options.agentRuntime) || !options.agentModel || !options.activitySource) {
    return false;
  }
  const lastMs = options.activitySource.lastActivityMs();
  if (lastMs === undefined) {
    return false;
  }
  // Same non-finite guard as leadMinutes: a NaN window makes
  // `delta <= NaN` always false, silently disabling Phase D.
  const window = typeof options.activeSessionWindowMs === "number" && Number.isFinite(options.activeSessionWindowMs)
    ? options.activeSessionWindowMs
    : DEFAULT_ACTIVE_WINDOW_MS;
  return now.getTime() - lastMs <= window;
}

const PHASE_D_SYSTEM_PROMPT =
  `You are Muse, the user's JARVIS-style assistant. The proactive
daemon just detected an imminent calendar event or task. Compose a
single short heads-up (one or two sentences, ≤ 200 chars) that:
- Names the item and how soon it fires
- Mentions location if a calendar event lists one
- Suggests ONE concrete next step the user can take (e.g.
  "want me to pull up yesterday's notes?", "shall I draft the
  reply?"). Skip the suggestion if nothing obvious fits.

Do NOT prefix with the time emoji — the surface adds it. No
markdown, no lists, no JSON, plain text only.`;

/**
 * Faithfulness judge for a synthesized proactive notice — re-checks the LLM prose
 * against the item's factSheet (its only source) and returns YES/NO. Structural type
 * (no agent-core dependency in this package); the daemon caller builds it from the
 * same reverify primitives the reflection gate uses.
 */
export type NoticeGroundingReverify = (input: {
  readonly answer: string;
  readonly evidence: string;
  readonly query: string;
}) => Promise<boolean>;

const NOTICE_GROUNDING_QUERY =
  "Does this heads-up state ONLY facts present in the item details (time, title, location)?";

export async function synthesizeNoticeText(
  item: ImminentItem,
  options: Pick<RunDueProactiveNoticesOptions, "agentModel" | "modelProvider" | "agentRuntime" | "personaPreamble" | "reverify">
): Promise<string> {
  if (!options.agentModel) {
    return item.text;
  }
  const systemContent = options.personaPreamble && options.personaPreamble.trim().length > 0
    ? `${options.personaPreamble.trim()}\n\n${PHASE_D_SYSTEM_PROMPT}`
    : PHASE_D_SYSTEM_PROMPT;
  const messages = [
    { content: systemContent, role: "system" as const },
    { content: item.factSheet, role: "user" as const }
  ];
  let reply: string;
  if (options.modelProvider) {
    // Preferred path — raw text gen, no tools, no agent loop.
    const result = await options.modelProvider.generate({
      maxOutputTokens: 200,
      messages,
      model: options.agentModel,
      temperature: 0.4
    });
    reply = result.output.trim();
  } else if (options.agentRuntime) {
    const result = await options.agentRuntime.run({ messages, model: options.agentModel });
    reply = result.response.output.trim();
  } else {
    return item.text;
  }
  // Defensive: if the model output looks like a tool-call JSON object
  // (small local models love doing this even when the prompt forbids
  // it), drop back to the flat text instead of delivering junk.
  if (reply.length === 0 || looksLikeToolCallJson(reply)) {
    return item.text;
  }
  // Faithfulness gate: the synthesized heads-up is free T=0.4 prose over the
  // factSheet — re-check it's grounded there before PUSHING it (an unasked notice
  // with a wrong time / invented location is a maximally-damaging fabrication). A
  // NO / throw / empty-evidence verdict fails CLOSE to the verbatim, store-grounded
  // item.text — never silence, never the unverified synthesis.
  if (options.reverify) {
    const evidence = item.factSheet.trim();
    if (evidence.length === 0) return item.text;
    let grounded: boolean;
    try {
      grounded = await options.reverify({ answer: reply, evidence: item.factSheet, query: NOTICE_GROUNDING_QUERY });
    } catch {
      return item.text;
    }
    if (!grounded) return item.text;
  }
  // Prepend the same emoji the flat path uses so the messaging
  // channel keeps a visual signal.
  const prefix = item.kind === "calendar" ? "⏰" : "📋";
  return reply.startsWith(prefix) ? reply : `${prefix} ${reply}`;
}

/**
 * Heuristic: a synthesized notice should be prose, not JSON. The
 * 1.5B / 3B local models occasionally emit a `{"name":"muse.tasks.add",...}`
 * payload despite the "plain text only" instruction in the system
 * prompt. Catch and reject so the messaging channel never receives
 * a literal tool-call envelope as the user-visible text.
 */
function looksLikeToolCallJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Tolerate a leading emoji + space — that's our own prefix.
  const stripped = trimmed.replace(/^[^\w{[]+/, "");
  if (!stripped.startsWith("{") && !stripped.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(stripped) as unknown;
    // Any JSON parse success on a Phase-D reply is a tool-call leak.
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}
