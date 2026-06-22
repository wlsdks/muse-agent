/**
 * Web-watch daemon — schedules the P21 web-watch runner on the API
 * server's lifecycle, mirroring `ambient-tick.ts`. Each tick polls
 * every configured watch's page (HTTP) and delivers a proactive
 * notice through the messaging registry when a watch fires. Read-only
 * perception; a watch never acts.
 *
 * Off by default; the daemon-config gate lives in `tick-daemons.ts`.
 */

import { sendWithRetry } from "@muse/mcp-shared";
import { createWebWatchRunner, type ProactiveNoticeSink, type WebWatch } from "@muse/proactivity";
import type { MessagingProviderRegistry } from "@muse/messaging";

import { isQuietHour, type QuietHourRange } from "./reminder-tick.js";

export interface WebWatchTickOptions {
  readonly watches: readonly WebWatch[];
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly intervalMs?: number;
  readonly quietHours?: QuietHourRange;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
  readonly now?: () => Date;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 60 * 60_000;

export interface WebWatchTickHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

export function startWebWatchTick(options: WebWatchTickOptions): WebWatchTickHandle {
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
  const runner = createWebWatchRunner({ sink, watches: options.watches });
  let firing = false;

  const tickOnce = async (): Promise<void> => {
    if (firing) return;
    if (options.quietHours && isQuietHour(now().getHours(), options.quietHours)) {
      return;
    }
    firing = true;
    try {
      const summary = await runner.tick();
      if (summary.delivered > 0) {
        options.logger?.(`web-watch: delivered ${summary.delivered.toString()} notice(s) via ${options.providerId}`);
      }
    } catch (cause) {
      options.errorLogger?.(`web-watch: ${cause instanceof Error ? cause.message : String(cause)}`);
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
