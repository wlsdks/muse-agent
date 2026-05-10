/**
 * Discord polling daemon (Phase 2.c.3 per docs/design/messaging.md).
 *
 * Discord's API is per-channel — there is no global "what's new?"
 * stream like Telegram's getUpdates — so this daemon iterates a
 * user-configured channel list on each tick, calling
 * `provider.pollUpdates({ source: channelId })` and appending each
 * returned `InboundMessage` to a JSON inbox file. The per-channel
 * cursor (Phase 2.c.1+2) lives in the provider's `afterFile`, so
 * the daemon doesn't track state itself.
 *
 * One channel's failure must not abort the tick: a missing /
 * mis-permissioned channel is logged and skipped; remaining
 * channels still poll.
 *
 * Off by default. Activates only when:
 *   - `MUSE_DISCORD_POLL_ENABLED === "1"`, and
 *   - `MUSE_DISCORD_POLL_CHANNELS` is a non-empty CSV, and
 *   - the messaging registry has the `discord` provider, and
 *   - `inboxFile` is configured.
 *
 * Same single-flight + unref + injectable-logger shape as
 * `telegram-poll-tick.ts`. Tick cadence is
 * `MUSE_DISCORD_POLL_INTERVAL_MS` (default 30_000); clamped to [5s, 1h].
 */

import { appendInbound, type DiscordProvider } from "@muse/messaging";

export interface DiscordPollOptions {
  readonly provider: DiscordProvider;
  readonly inboxFile: string;
  /** Channel IDs to poll each tick. Empty → daemon never registered. */
  readonly channels: readonly string[];
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export interface DiscordPollHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export function startDiscordPollTick(options: DiscordPollOptions): DiscordPollHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let polling = false;

  const tickOnce = async (): Promise<void> => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      let totalIngested = 0;
      for (const channel of options.channels) {
        try {
          const inbound = await options.provider.pollUpdates({
            source: channel,
            ...(options.fetchLimit !== undefined ? { limit: options.fetchLimit } : {})
          });
          for (const message of inbound) {
            await appendInbound(options.inboxFile, message);
          }
          totalIngested += inbound.length;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          // Per-channel failure: log and continue so a single bad
          // channel id doesn't poison the rest of the tick.
          options.errorLogger?.(`discord-poll: channel ${channel}: ${message}`);
        }
      }
      if (totalIngested > 0) {
        options.logger?.(`discord-poll: ingested ${totalIngested.toString()} message(s) across ${options.channels.length.toString()} channel(s)`);
      }
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

/**
 * Parse `MUSE_DISCORD_POLL_CHANNELS` of the form `id1,id2,id3`.
 * Trims each entry and drops empties. Returns `undefined` when the
 * raw value is missing/blank so the daemon stays off.
 */
export function parseDiscordPollChannels(raw: string | undefined): readonly string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parts = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
