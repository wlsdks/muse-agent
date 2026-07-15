/**
 * Proactive surfacing — calendar imminence + task due-soon push.
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


import type { CalendarProviderRegistry } from "@muse/calendar";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { redactSecretsInText, withBestEffort } from "@muse/shared";

import { sendWithRetry } from "@muse/mcp-shared";
import { isQuietHour, type QuietHourRange } from "./quiet-hours.js";
import {
  collectImminentCalendar,
  collectImminentTasks,
  sortImminentByStart,
  type ImminentItem
} from "./notice-imminent.js";
import {
  synthesizeNoticeText,
  type NoticeGroundingReverify,
  type ProactiveAgentRuntimeLike,
  type ProactiveModelProviderLike
} from "./notice-synthesis.js";

export { sortImminentByStart } from "./notice-imminent.js";
export {
  synthesizeNoticeText,
  type NoticeGroundingReverify,
  type ProactiveAgentRuntimeLike,
  type ProactiveModelProviderLike
} from "./notice-synthesis.js";

/**
 * Structural shape of the agent-initiated notice broker (defined in
 * `@muse/agent-core/AgentInitiatedNoticeBroker`). We avoid the
 * import to keep `@muse/proactivity` from depending on `@muse/agent-core`
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

import { dirname } from "node:path";
import {
  appendProactiveHistory,
  appendSurfaced,
  avoidedSourceKeys,
  firedKey,
  readProactiveFired,
  readSessionLock,
  readTrustLedger,
  recordProactiveHeartbeat,
  sourceKey,
  withinDailyCap,
  withProcessLock,
  writeProactiveFired,
  type ProactiveFiredEntry,
  type TrustLedgerEntry
} from "@muse/stores";
export { firedKey, readProactiveFired, readSessionLock, writeProactiveFired, writeSessionLock, type ProactiveFiredEntry, type ProactiveFiredKind, type SessionLockPayload } from "@muse/stores";

/**
 * Track when the user was last seen on a Muse surface
 * (REST /api/chat, /api/chat/stream, or any future presence pub/sub
 * client). The proactive loop reads this to decide whether to
 * compose a one-shot agent-synthesized heads-up or fall back to
 * the flat notice string.
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
   * Agent-initiated turn. When `agentModel` is set AND the
   * activity source reports recent activity (within
   * `activeSessionWindowMs`), the daemon emits a one-shot text
   * generation with a synthesis prompt to compose a tailored
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
   * the synthesis system prompt so the synthesized notice addresses
   * the user by name and respects their preferences ("Stark님,
   * Q3 메모가 5분 후 마감입니다" instead of the generic
   * "Send Q3 budget memo due in 5 min"). Empty / undefined → no
   * personalisation, the daemon falls back to the generic prompt.
   */
  readonly personaPreamble?: string;
  /**
   * Faithfulness gate for the synthesized notice. A proactive notice is an
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
   * Agent-initiated notice broker. When set, every successfully
   * synthesised / delivered notice is ALSO published here so live
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
  /**
   * Directory for the liveness heartbeat files (DS-8). The `alive`
   * mark is touched at the START of every tick and the `fired` mark at
   * the END of a tick that returned without throwing, so `muse doctor`
   * can tell a stopped ticker from one that runs but fails every pass.
   * Defaults to the directory of `sidecarFile` (co-located with the
   * proactive state) so no extra wiring is needed; pass `null` to
   * disable. Writes are fail-soft and never break the tick.
   */
  readonly heartbeatDir?: string | null;
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
  /** Set only when another daemon held the firing lock for this tick — no
   *  read, send, or mark was attempted at all. Absent on every other path. */
  readonly outcome?: "lock-held";
}

/**
 * Public entrypoint: wraps the tick body with the DS-8 liveness heartbeat.
 * `alive` is written before any work; `fired` only after the body returns
 * without throwing (a clean pass). A throwing tick leaves `fired` stale so
 * `muse doctor` sees "running but failing". Heartbeat writes are fail-soft
 * and are NEVER allowed to change the tick's own success/failure.
 */
export async function runDueProactiveNotices(
  options: RunDueProactiveNoticesOptions
): Promise<RunDueProactiveNoticesSummary> {
  const heartbeatDir = resolveHeartbeatDir(options);
  const now = options.now ?? (() => new Date());
  if (heartbeatDir) {
    await withBestEffort(recordProactiveHeartbeat(heartbeatDir, "alive", now), false);
  }
  const summary = await runProactiveTickLocked(options);
  // `fired` marks a CLEAN pass. The inner loop catches per-item delivery
  // failures into `summary.errors` rather than throwing, so a tick that
  // reached items but failed EVERY delivery would otherwise still look
  // healthy. Gate on an empty error list so a persistently-failing ticker
  // (alive fresh, fired stale) is distinguishable from a healthy idle one.
  // A lock-held tick also has zero errors, so it is marked `fired` too —
  // this daemon did nothing WRONG this tick, another daemon just owned it.
  if (heartbeatDir && summary.errors.length === 0) {
    await withBestEffort(recordProactiveHeartbeat(heartbeatDir, "fired", now), false);
  }
  return summary;
}

/**
 * The whole select→send→mark tick — calendar/task fetch, optional Phase-D
 * synthesis + reverify, per-item delivery, and the trailing sidecar write —
 * runs under the cross-process `withProcessLock`
 * (`${options.sidecarFile}.firing.lock`, the same generalized lock the
 * reminder/followup/checkin/objective ticks use — `@muse/stores/digest-lock.ts`)
 * because the api daemon's `proactive-tick` and the CLI daemon's
 * `makeProactiveTick` read the SAME sidecar file: `writeProactiveFired` is one
 * write at the END of the tick, not mutual exclusion, so without a real lock
 * both daemons can read the same imminent item as un-fired and both deliver it
 * before either records it. This critical section is LARGER than the other
 * four loops' (a calendar/task fetch plus, per item, an optional LLM synthesis
 * and grounding reverify) — but `withProcessLock`'s own heartbeat refreshes the
 * lock file's mtime on an unref'd `staleMs / 3` interval for as long as the
 * section runs, so a legitimately slow tick never has its lock stolen
 * mid-work. That is what makes wrapping the WHOLE tick (rather than only the
 * final sidecar write) safe here. A LIVE held lock returns
 * `outcome: "lock-held"` immediately with nothing fetched or sent; a broken
 * lock (non-contention fs error) fails OPEN — the tick still runs unlocked
 * rather than silently skipping proactive notices.
 */
async function runProactiveTickLocked(
  options: RunDueProactiveNoticesOptions
): Promise<RunDueProactiveNoticesSummary> {
  const lockPath = `${options.sidecarFile}.firing.lock`;
  const lockOutcome = await withProcessLock(lockPath, () => runDueProactiveNoticesUnderLock(options));
  if (lockOutcome.kind === "lock-held") {
    return { errors: [], fired: 0, imminent: 0, outcome: "lock-held" };
  }
  if (lockOutcome.lockError !== undefined) {
    // Fail-open on a BROKEN lock (not contention): the tick still ran,
    // unlocked, so this degrades to the pre-lock duplicate-delivery risk
    // rather than silencing proactive notices.
    return {
      ...lockOutcome.value,
      errors: [`proactive-tick: lock acquisition failed, proceeding without lock: ${lockOutcome.lockError}`, ...lockOutcome.value.errors]
    };
  }
  return lockOutcome.value;
}

/**
 * Heartbeat directory: explicit `heartbeatDir` wins (`null` disables);
 * otherwise co-locate with the proactive sidecar so the live daemon emits
 * heartbeats with no extra wiring.
 */
function resolveHeartbeatDir(options: RunDueProactiveNoticesOptions): string | undefined {
  if (options.heartbeatDir === null) return undefined;
  if (typeof options.heartbeatDir === "string" && options.heartbeatDir.length > 0) {
    return options.heartbeatDir;
  }
  return options.sidecarFile ? dirname(options.sidecarFile) : undefined;
}

async function runDueProactiveNoticesUnderLock(
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
    const collected = await collectImminentCalendar(options.calendarRegistry, nowDate, cutoff);
    imminent.push(...collected.items);
    errors.push(...collected.errors);
  }

  if (options.tasksFile) {
    const collected = await collectImminentTasks(options.tasksFile, nowDate, cutoff);
    imminent.push(...collected.items);
    errors.push(...collected.errors);
  }

  if (imminent.length === 0) {
    return { errors, fired: 0, imminent: 0 };
  }

  const fired = await readProactiveFired(options.sidecarFile);
  const seen = new Set(fired.map((entry) => firedKey(entry)));
  let firedThisRun = 0;
  let nextFired: readonly ProactiveFiredEntry[] = fired;

  // Trust instrumentation: learned avoidance + daily cap.
  // Fail-open — a corrupt/unreadable ledger never gags the daemon.
  const trustLedger = options.trustLedgerFile
    ? await withBestEffort(readTrustLedger(options.trustLedgerFile), [])
    : [];
  const avoided = avoidedSourceKeys(trustLedger);
  const capEnabled = options.trustLedgerFile !== undefined
    && typeof options.dailyCap === "number"
    && Number.isFinite(options.dailyCap)
    && options.dailyCap > 0;
  const ledgerForCap: TrustLedgerEntry[] = [...trustLedger];

  // Decide once whether the active-session window allows
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

    const { delivered } = await deliverImminentItem(item, {
      errors,
      ledgerForCap,
      now,
      nowDate,
      options,
      phaseDActive,
      sinkChoice
    });
    if (delivered) {
      firedThisRun += 1;
      nextFired = [...nextFired, candidate];
      seen.add(key);
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

interface DeliverImminentContext {
  // `errors` and `ledgerForCap` are the caller's live arrays — the
  // helper mutates them in place exactly as the inlined loop body did.
  readonly errors: string[];
  readonly ledgerForCap: TrustLedgerEntry[];
  readonly now: () => Date;
  readonly nowDate: Date;
  readonly options: RunDueProactiveNoticesOptions;
  readonly phaseDActive: boolean;
  readonly sinkChoice: ProactiveSinkChoice;
}

// Per-item delivery: synthesize → investigate → redact → send (terminal
// or messaging, quiet-hours-gated) → trust-ledger + broker + history.
// Returns whether the notice was delivered so the caller can advance
// firedThisRun / nextFired / seen; all failure paths are caught here and
// recorded into `ctx.errors` rather than thrown.
async function deliverImminentItem(
  item: ImminentItem,
  ctx: DeliverImminentContext
): Promise<{ readonly delivered: boolean }> {
  const { errors, ledgerForCap, now, nowDate, options, phaseDActive, sinkChoice } = ctx;

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
  // Set the instant the send resolves — BEFORE the trust-ledger / broker /
  // history side-effects. A throw in those later steps still leaves the item
  // counted as delivered (matching the inlined body, where firedThisRun was
  // incremented at this exact point and a later throw fell to the catch with
  // the increment already applied).
  let delivered = false;
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
    delivered = true;
    // Trust ledger: record the delivered surface for the
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
    // Broker fan-out: publish the same notice so live
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
    return { delivered };
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
    return { delivered };
  }
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
  // `delta <= NaN` always false, silently disabling synthesis.
  const window = typeof options.activeSessionWindowMs === "number" && Number.isFinite(options.activeSessionWindowMs)
    ? options.activeSessionWindowMs
    : DEFAULT_ACTIVE_WINDOW_MS;
  return now.getTime() - lastMs <= window;
}
