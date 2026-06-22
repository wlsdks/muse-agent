/**
 * Situational-briefing daemon — wires `runDueSituationalBriefing`
 * (P8-b2) into apps/api as a `setInterval` rider, the parallel of
 * `objectives-tick.ts` for the briefing loop. Without it the
 * synthesised situational picture exists only as a library the
 * user's running server never drives.
 *
 * Deterministic + zero-LLM (the composer is pure; delivery is the
 * messaging registry). Off unless started. Cadence `intervalMs`
 * (default 30 min — a briefing is coarser than the per-item
 * ticks), clamped to [5s, 6h]; single-flight; fail-soft; unref.
 * `imminent` defaults to `[]` so the daemon briefs delegated-
 * objective status; calendar-derived imminent is a later
 * enhancement injected here.
 */

import { type BriefingImminent } from "@muse/mcp";
import { runDueSituationalBriefing, type EmailProvider, type WeatherProvider } from "@muse/domain-tools";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface SituationalBriefingTickOptions {
  readonly objectivesFile: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly sidecarFile: string;
  readonly imminent?: readonly BriefingImminent[];
  /**
   * Per-tick imminent source (imminence is time-relative). When
   * set it overrides the static `imminent`; a thrown provider
   * fails soft to no imminent items (the objective-status briefing
   * still goes out).
   */
  readonly imminentProvider?: (now: Date) => Promise<readonly BriefingImminent[]>;
  /**
   * Optional weather grounding: when both are set, a non-empty briefing
   * gains a current-weather line for `weatherLocation`. Fail-soft.
   */
  readonly weatherProvider?: WeatherProvider;
  readonly weatherLocation?: string;
  /** Optional inbox grounding: a non-empty briefing gains an unread digest. */
  readonly emailProvider?: EmailProvider;
  /** Optional predicate flagging an unread sender as a known contact, so the inbox line surfaces people-you-know first. */
  readonly inboxKnownSender?: (from: string) => boolean;
  /** Optional knowledge enricher: a non-empty briefing gains a related-note line for the top imminent item. */
  readonly relatedKnowledge?: (query: string) => Promise<string | undefined> | string | undefined;
  /** Optional home-alert resolver: a non-empty briefing gains a line flagging noteworthy home states (door unlocked). */
  readonly homeAlert?: () => Promise<string | undefined> | string | undefined;
  /** Optional upcoming-birthdays resolver: a non-empty briefing gains a "Sarah today; Bob in 3 days" line. */
  readonly birthdayLine?: () => Promise<string | undefined> | string | undefined;
  /** Optional due-tasks resolver: a non-empty briefing gains a "Buy milk (overdue); Pay rent (today)" line. */
  readonly tasksDueLine?: () => Promise<string | undefined> | string | undefined;
  /** Optional "shape of the day" resolver: a non-empty briefing gains a "free after 16:00" line. */
  readonly availabilityLine?: () => Promise<string | undefined> | string | undefined;
  readonly windowMs?: number;
  readonly intervalMs?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  readonly quietHours?: QuietHourRange;
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 6 * 60 * 60_000;

export interface SituationalBriefingTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startSituationalBriefingTick(
  options: SituationalBriefingTickOptions
): SituationalBriefingTickHandle {
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
      let imminent = options.imminent ?? [];
      if (options.imminentProvider) {
        try {
          imminent = await options.imminentProvider(now());
        } catch {
          imminent = [];
        }
      }
      const summary = await runDueSituationalBriefing({
        destination: options.destination,
        imminent,
        messagingRegistry: options.registry,
        now,
        objectivesFile: options.objectivesFile,
        providerId: options.providerId,
        sidecarFile: options.sidecarFile,
        ...(options.weatherProvider && options.weatherLocation
          ? { weatherLocation: options.weatherLocation, weatherProvider: options.weatherProvider }
          : {}),
        ...(options.emailProvider ? { emailProvider: options.emailProvider } : {}),
        ...(options.inboxKnownSender ? { inboxKnownSender: options.inboxKnownSender } : {}),
        ...(options.relatedKnowledge ? { relatedKnowledge: options.relatedKnowledge } : {}),
        ...(options.homeAlert ? { homeAlert: options.homeAlert } : {}),
        ...(options.birthdayLine ? { birthdayLine: options.birthdayLine } : {}),
        ...(options.tasksDueLine ? { tasksDueLine: options.tasksDueLine } : {}),
        ...(options.availabilityLine ? { availabilityLine: options.availabilityLine } : {}),
        ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {})
      });
      if (summary.delivered > 0) {
        options.logger?.(`situational-briefing-tick: delivered via ${options.providerId}`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`situational-briefing-tick: ${message}`);
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
