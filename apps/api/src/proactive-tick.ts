/**
 * Proactive surfacing daemon (Phase A per docs/design/proactive-surfacing.md).
 * Sibling of reminder-tick.ts — same setInterval-on-the-API-server
 * pattern, calendar-imminence-driven signal source.
 *
 * Off by default. Activates only when:
 *   - `MUSE_PROACTIVE_PROVIDER` and `MUSE_PROACTIVE_DESTINATION` are set,
 *   - the messaging registry has the named provider,
 *   - a calendar registry is wired (some provider registered), and
 *   - a sidecar file is configured.
 *
 * Tick cadence is `MUSE_PROACTIVE_TICK_MS` (default 60_000); clamped
 * to [5s, 1h] for the same reason reminder-tick clamps.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentInitiatedNoticeBroker } from "@muse/agent-core";
import { buildGroundingReverify } from "@muse/agent-core";
import { runDueProactiveNotices, type ProactiveActivitySource, type ProactiveAgentRuntimeLike, type ProactiveModelProviderLike } from "@muse/proactivity";
import type { CalendarProviderRegistry } from "@muse/calendar";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface ProactiveTickOptions {
  readonly calendarRegistry?: CalendarProviderRegistry;
  /**
   * Personal-tasks store file (`~/.muse/tasks.json` by default).
   * When set, open tasks with imminent dueAt fire alongside
   * calendar imminent events. Phase B of
   * docs/design/proactive-surfacing.md.
   */
  readonly tasksFile?: string;
  /**
   * Autonomous investigator (P0-b3). Given the imminent item it
   * returns a one-line finding (a notes/tool lookup of the likely
   * unstated need) appended to the unasked notice. Fail-open in the
   * loop.
   */
  readonly investigate?: (item: {
    readonly title: string;
    readonly kind: string;
    readonly factSheet: string;
  }) => Promise<string | undefined>;
  readonly messagingRegistry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly sidecarFile: string;
  readonly leadMinutes?: number;
  readonly intervalMs?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  /**
   * Phase D — agent-initiated turn. Pass `modelProvider` (preferred,
   * raw text gen without tool registry) OR `agentRuntime` (legacy,
   * full agent pipeline) along with `agentModel` to enable
   * LLM-composed heads-ups when the user has recent chat activity.
   */
  readonly modelProvider?: ProactiveModelProviderLike;
  readonly agentRuntime?: ProactiveAgentRuntimeLike;
  readonly agentModel?: string;
  readonly activitySource?: ProactiveActivitySource;
  /** Phase D session window. Default 5 minutes (300_000 ms). */
  readonly activeSessionWindowMs?: number;
  /**
   * Optional proactive-history sidecar (default
   * ~/.muse/proactive-history.json). When set, every delivery
   * attempt is appended so `muse.proactive.history` /
   * `GET /api/proactive/history` / `muse proactive history` can
   * audit "did the 3pm meeting notice land?" weeks later.
   */
  readonly historyFile?: string;
  /**
   * Shared with the reminder daemon — operators rarely want a
   * different quiet window for the two channels. Parse via
   * `parseQuietHours(MUSE_PROACTIVE_QUIET_HOURS ?? MUSE_REMINDER_QUIET_HOURS)`
   * at the wiring layer.
   */
  readonly quietHours?: QuietHourRange;
  /**
   * Phase D broker. When provided alongside
   * `agentInitiatedNoticeUserId`, every delivered notice is also
   * published so live `/api/agent-notices/stream` subscribers see
   * the same heads-up inline.
   */
  readonly agentInitiatedNoticeBroker?: AgentInitiatedNoticeBroker;
  readonly agentInitiatedNoticeUserId?: string;
  /**
   * `~/.muse/session-lock.json` path. Read on every
   * tick by `runDueProactiveNotices`; when the marker is active,
   * the tick reports `sessionLockedUntil` and skips firing.
   */
  readonly sessionLockFile?: string;
  /**
   * Trust-instrumentation sidecar (`~/.muse/proactive-trust.json`).
   * Records every delivered notice for the precision scoreboard and
   * silences user-vetoed sources (learned avoidance). Phase 2.
   */
  readonly trustLedgerFile?: string;
  /** 24h surfacing cap (opt-in; requires trustLedgerFile). */
  readonly dailyCap?: number;
  /** Injectable clock for tests; default is `() => new Date()`. */
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface ProactiveTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startProactiveTick(options: ProactiveTickOptions): ProactiveTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    if (firing) {
      return;
    }
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runDueProactiveNotices({
        ...(options.activeSessionWindowMs !== undefined ? { activeSessionWindowMs: options.activeSessionWindowMs } : {}),
        ...(options.activitySource ? { activitySource: options.activitySource } : {}),
        ...(options.agentInitiatedNoticeBroker ? { agentInitiatedNoticeBroker: options.agentInitiatedNoticeBroker } : {}),
        ...(options.agentInitiatedNoticeUserId ? { agentInitiatedNoticeUserId: options.agentInitiatedNoticeUserId } : {}),
        ...(options.agentModel ? { agentModel: options.agentModel } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        // Faithfulness-gate the synthesized Phase D notice (same judge as reflection):
        // a confabulated push detail fails CLOSE to the verbatim store line.
        ...(options.modelProvider && options.agentModel
          ? { reverify: buildGroundingReverify(options.modelProvider, options.agentModel) }
          : {}),
        ...(options.agentRuntime ? { agentRuntime: options.agentRuntime } : {}),
        ...(options.calendarRegistry ? { calendarRegistry: options.calendarRegistry } : {}),
        ...(options.investigate ? { investigate: options.investigate } : {}),
        destination: options.destination,
        ...(options.historyFile ? { historyFile: options.historyFile } : {}),
        ...(options.leadMinutes !== undefined ? { leadMinutes: options.leadMinutes } : {}),
        messagingRegistry: options.messagingRegistry,
        now,
        providerId: options.providerId,
        ...(options.sessionLockFile ? { sessionLockFile: options.sessionLockFile } : {}),
        sidecarFile: options.sidecarFile,
        ...(options.tasksFile ? { tasksFile: options.tasksFile } : {}),
        ...(options.trustLedgerFile ? { trustLedgerFile: options.trustLedgerFile } : {}),
        ...(options.dailyCap !== undefined && options.dailyCap > 0 ? { dailyCap: options.dailyCap } : {})
      });
      if (summary.sessionLockedUntil) {
        // One log per tick — audit trail without user spam.
        options.logger?.(
          `proactive-tick: skipped (session locked until ${summary.sessionLockedUntil})`
        );
      } else if (summary.fired > 0 || summary.errors.length > 0) {
        options.logger?.(
          `proactive-tick: fired ${summary.fired.toString()} of ${summary.imminent.toString()} imminent via ${options.providerId}` +
            (summary.errors.length > 0 ? `, ${summary.errors.length.toString()} error(s)` : "")
        );
        for (const error of summary.errors) {
          options.errorLogger?.(`proactive-tick: ${error}`);
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`proactive-tick: ${message}`);
    } finally {
      firing = false;
    }
  };

  const handle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => clearInterval(handle),
    tickOnce
  };
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}

/**
 * Tiny in-memory presence tracker for Phase D. The chat-route hook
 * calls `record()` on every /api/chat* request; the proactive
 * daemon reads `lastActivityMs()` to decide whether to compose an
 * agent-synthesized notice. No history kept — just the most recent
 * timestamp — since the daemon only ever asks "is the user
 * around right now?".
 */
export interface InMemoryActivityTracker extends ProactiveActivitySource {
  record(at?: number): void;
}

export function createInMemoryActivityTracker(): InMemoryActivityTracker {
  let lastMs: number | undefined;
  return {
    lastActivityMs: () => lastMs,
    record: (at?: number) => {
      lastMs = at ?? Date.now();
    }
  };
}

/**
 * File-backed presence tracker for multi-process / multi-device
 * Phase D. Two processes pointing at the same file (e.g. apps/api on
 * machine A + a future `muse listen` daemon on the same `~/.muse`)
 * see each other's activity through the shared JSON blob. The format
 * is intentionally minimal — just `{ lastActivityMs: number }`.
 *
 * Writes are debounced to once per `debounceMs` (default 1s) so a
 * burst of /api/chat requests doesn't thrash the disk. Reads are
 * cached for the same window so the daemon's per-tick `lastActivityMs()`
 * call doesn't re-read the file every minute either (negligible
 * either way, but keeps the abstraction symmetric).
 */
export interface FileBackedActivityTrackerOptions {
  readonly file: string;
  readonly debounceMs?: number;
  /** Test seam — defaults to `() => Date.now()`. */
  readonly now?: () => number;
}

export function createFileBackedActivityTracker(options: FileBackedActivityTrackerOptions): InMemoryActivityTracker {
  const now = options.now ?? (() => Date.now());
  const debounceMs = Math.max(0, options.debounceMs ?? 1_000);
  let cachedLastMs: number | undefined;
  let cachedAtMs = 0;
  let pendingWriteMs: number | undefined;
  let lastWriteAtMs = 0;
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  const readFromDisk = (): number | undefined => {
    try {
      const raw = readFileSync(options.file, "utf8");
      const parsed = JSON.parse(raw) as { readonly lastActivityMs?: unknown };
      if (typeof parsed.lastActivityMs === "number" && Number.isFinite(parsed.lastActivityMs)) {
        return parsed.lastActivityMs;
      }
    } catch {
      // Missing / malformed file — treat as "never recorded".
    }
    return undefined;
  };

  const flushWrite = (): void => {
    if (pendingWriteMs === undefined) return;
    const value = pendingWriteMs;
    pendingWriteMs = undefined;
    lastWriteAtMs = now();
    try {
      const tmp = `${options.file}.tmp-${process.pid.toString()}-${lastWriteAtMs.toString()}`;
      mkdirSync(dirname(options.file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify({ lastActivityMs: value })}\n`, "utf8");
      renameSync(tmp, options.file);
    } catch {
      // Best-effort — the daemon will see a slightly older value
      // until the next successful write. Don't crash the request hook.
    }
  };

  return {
    lastActivityMs: () => {
      const nowMs = now();
      if (cachedLastMs !== undefined && nowMs - cachedAtMs < debounceMs) {
        return cachedLastMs;
      }
      cachedLastMs = readFromDisk();
      cachedAtMs = nowMs;
      // The in-flight pending value (if any) wins over the on-disk
      // value — otherwise a daemon tick that lands between record()
      // and the debounced flush would miss the new activity.
      if (pendingWriteMs !== undefined && (cachedLastMs === undefined || pendingWriteMs > cachedLastMs)) {
        return pendingWriteMs;
      }
      return cachedLastMs;
    },
    record: (at?: number) => {
      const value = at ?? now();
      pendingWriteMs = pendingWriteMs === undefined ? value : Math.max(pendingWriteMs, value);
      // Invalidate the read cache so the next lastActivityMs() picks
      // up the new value even if we haven't flushed yet.
      cachedAtMs = 0;
      const elapsed = now() - lastWriteAtMs;
      if (elapsed >= debounceMs) {
        flushWrite();
        return;
      }
      if (writeTimer) return;
      writeTimer = setTimeout(() => {
        writeTimer = undefined;
        flushWrite();
      }, debounceMs - elapsed);
      // Don't keep the process alive solely to flush activity.
      if (typeof writeTimer.unref === "function") {
        writeTimer.unref();
      }
    }
  };
}
