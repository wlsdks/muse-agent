/**
 * Telegram polling daemon (Phase 2.a.3 + 2.a.4 per docs/design/messaging.md).
 *
 * Calls `provider.pollUpdates()` and appends each returned
 * `InboundMessage` to a JSON inbox file via
 * `@muse/messaging/appendInbound`. `pollUpdates` already advances
 * the persisted offset (Phase 2.a.1+2), so each tick walks the
 * queue rather than reprocessing.
 *
 * Two cadence modes:
 *   - **Long poll** (`longPollSeconds` > 0, the default wiring): a
 *     continuous self-scheduling loop. Each `getUpdates` call is HELD
 *     by Telegram for up to that many seconds and returns the moment
 *     a message arrives — near-real-time delivery without a public
 *     webhook endpoint. The loop re-launches immediately after each
 *     poll (`relaunchDelayMs` breather), and backs off to
 *     `intervalMs` after an error so a dead network can't hot-loop.
 *   - **Interval snapshot** (`longPollSeconds` absent/0): the legacy
 *     setInterval cadence (`intervalMs`, default 30s, clamped [5s, 1h]).
 *
 * Why `provider` and not `registry`: the daemon is the Bot-API-side
 * ingestion path. The user-facing `registry.fetchInbound` reads
 * from the inbox file once configured (Phase 2.a.4), so calling it
 * here would create a read/write loop. Taking the provider directly
 * keeps the two surfaces separated.
 *
 * Off by default. Activates only when:
 *   - `MUSE_TELEGRAM_POLL_ENABLED === "1"`, and
 *   - the messaging registry has the `telegram` provider, and
 *   - `inboxFile` is configured.
 */

import { appendInbound, type TelegramProvider } from "@muse/messaging";

export interface TelegramPollOptions {
  readonly provider: TelegramProvider;
  readonly inboxFile: string;
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  /** > 0 switches to the continuous long-poll loop (seconds Telegram holds each getUpdates). */
  readonly longPollSeconds?: number;
  /** Breather between long polls (default 250ms; tests shrink it). */
  readonly relaunchDelayMs?: number;
  /** Fires after a poll that ingested >0 messages — lets the reply daemon run immediately. */
  readonly onIngested?: (count: number) => void;
  /**
   * Emoji reaction fired on each ingested message — the "seen" signal
   * (Bot API has no read receipts). Cosmetic: a reaction failure never
   * blocks ingestion. Empty/undefined disables.
   */
  readonly ackReaction?: string;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export interface TelegramPollHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;
const DEFAULT_RELAUNCH_DELAY_MS = 250;

export function startTelegramPollTick(options: TelegramPollOptions): TelegramPollHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const longPollSeconds = options.longPollSeconds ?? 0;
  let polling = false;

  const tickOnce = async (): Promise<boolean> => {
    if (polling) {
      return false;
    }
    polling = true;
    try {
      const inbound = await options.provider.pollUpdates({
        ...(options.fetchLimit !== undefined ? { limit: options.fetchLimit } : {}),
        ...(longPollSeconds > 0 ? { longPollSeconds } : {})
      });
      if (inbound.length === 0) {
        return true;
      }
      for (const message of inbound) {
        await appendInbound(options.inboxFile, message);
        if (options.ackReaction) {
          void options.provider
            .reactToMessage(message.source, message.messageId, options.ackReaction)
            .catch(() => undefined);
        }
      }
      options.logger?.(`telegram-poll: ingested ${inbound.length.toString()} message(s)`);
      options.onIngested?.(inbound.length);
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`telegram-poll: ${message}`);
      return false;
    } finally {
      polling = false;
    }
  };

  if (longPollSeconds > 0) {
    const relaunchDelayMs = options.relaunchDelayMs ?? DEFAULT_RELAUNCH_DELAY_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      const ok = await tickOnce();
      if (stopped) {
        return;
      }
      timer = setTimeout(() => {
        void loop();
      }, ok ? relaunchDelayMs : intervalMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    };
    void loop();
    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
      tickOnce: async () => {
        await tickOnce();
      }
    };
  }

  const handle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => clearInterval(handle),
    tickOnce: async () => {
      await tickOnce();
    }
  };
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
