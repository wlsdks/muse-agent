/**
 * Telegram polling daemon (Phase 2.a.3 + 2.a.4 per docs/design/messaging.md).
 *
 * Calls `provider.pollUpdates()` on a setInterval cadence and
 * appends each returned `InboundMessage` to a JSON inbox file via
 * `@muse/messaging/appendInbound`. `pollUpdates` already advances
 * the persisted offset (Phase 2.a.1+2), so each tick walks the
 * queue rather than reprocessing.
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
 *
 * Same single-flight + unref + injectable-logger shape as
 * `reminder-tick.ts`. Tick cadence is `MUSE_TELEGRAM_POLL_INTERVAL_MS`
 * (default 30_000); clamped to [5s, 1h].
 */

import { appendInbound, type TelegramProvider } from "@muse/messaging";

export interface TelegramPollOptions {
  readonly provider: TelegramProvider;
  readonly inboxFile: string;
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
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

export function startTelegramPollTick(options: TelegramPollOptions): TelegramPollHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let polling = false;

  const tickOnce = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const inbound = await options.provider.pollUpdates(
        options.fetchLimit !== undefined ? { limit: options.fetchLimit } : undefined
      );
      if (inbound.length === 0) {
        return;
      }
      for (const message of inbound) {
        await appendInbound(options.inboxFile, message);
      }
      options.logger?.(`telegram-poll: ingested ${inbound.length.toString()} message(s)`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      options.errorLogger?.(`telegram-poll: ${message}`);
    } finally {
      polling = false;
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
