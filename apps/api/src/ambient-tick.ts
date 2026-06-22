/**
 * Ambient-perception firing daemon — schedules the P20 edge-triggered
 * ambient runner on the API server's lifecycle, mirroring
 * `pattern-tick.ts` / `proactive-tick.ts`. Reads the user's ambient
 * signal (a file an OS helper writes) each tick and delivers a
 * proactive notice through the messaging registry when a rule first
 * matches — without the user invoking anything.
 *
 * Off by default; the daemon-config gate lives in `tick-daemons.ts`.
 */

import { sendWithRetry } from "@muse/mcp-shared";
import { createAmbientNoticeRunner, type AmbientNoticeRule, type AmbientSignalSource, type KnowledgeAmbientTrigger, type ProactiveNoticeSink } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface AmbientTickOptions {
  readonly source: AmbientSignalSource;
  readonly rules: readonly AmbientNoticeRule[];
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly intervalMs?: number;
  readonly quietHours?: QuietHourRange;
  /** Optional knowledge enricher: a firing notice gains a related-knowledge line. */
  readonly enrich?: (query: string) => Promise<string | undefined> | string | undefined;
  /** Optional SB-3 knowledge trigger: the active window title alone edge-fires a recall notice with no rule. */
  readonly knowledgeTrigger?: KnowledgeAmbientTrigger;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface AmbientTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startAmbientTick(options: AmbientTickOptions): AmbientTickHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const now = options.now ?? (() => new Date());
  const sink: ProactiveNoticeSink = {
    deliver: async (notice) => {
      await sendWithRetry(options.registry, options.providerId, {
        destination: options.destination,
        text: `${notice.title}: ${notice.text}`
      });
    }
  };
  const runner = createAmbientNoticeRunner({
    rules: options.rules,
    sink,
    source: options.source,
    ...(options.enrich ? { enrich: options.enrich } : {}),
    ...(options.knowledgeTrigger ? { knowledgeTrigger: options.knowledgeTrigger } : {})
  });
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    if (firing) return;
    // Skip the whole tick during quiet hours WITHOUT advancing the
    // runner's edge state, so a context still active when quiet hours
    // end fires once then (a rising edge), not silently swallowed.
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runner.tick();
      if (summary.delivered > 0) {
        options.logger?.(`ambient-tick: delivered ${summary.delivered.toString()} notice(s) via ${options.providerId}`);
      }
    } catch (cause) {
      options.errorLogger?.(`ambient-tick: ${cause instanceof Error ? cause.message : String(cause)}`);
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
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
