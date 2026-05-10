/**
 * Telegram polling daemon (Phase 2.a.3 per docs/design/messaging.md).
 *
 * Calls `registry.fetchInbound("telegram")` on a setInterval cadence
 * and appends each returned `InboundMessage` to a JSON inbox file
 * via `@muse/messaging/appendInbound`. The TelegramProvider built by
 * `buildMessagingRegistry` already has offset persistence (Phase
 * 2.a.1+2), so each tick advances through the queue rather than
 * reprocessing.
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

import { appendInbound, type MessagingProviderRegistry } from "@muse/messaging";

export interface TelegramPollOptions {
  readonly registry: MessagingProviderRegistry;
  readonly inboxFile: string;
  readonly providerId?: string;
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
  const providerId = options.providerId ?? "telegram";
  let polling = false;

  const tickOnce = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const inbound = await options.registry.fetchInbound(providerId, options.fetchLimit !== undefined ? { limit: options.fetchLimit } : undefined);
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
