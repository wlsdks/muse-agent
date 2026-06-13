/**
 * Generic multi-channel polling daemon shared by the per-channel
 * messaging providers (currently Discord and Slack — both walk
 * `pollUpdates({ source: channelId })` per channel each tick).
 *
 * Telegram has its own dedicated daemon (`telegram-poll-tick.ts`)
 * because Telegram's getUpdates is a single global stream, not
 * per-channel — different shape, deliberately not generalised here.
 *
 * Per-channel failures are logged and skipped so one bad channel
 * (archived, missing access, bad id) doesn't poison the rest of
 * the tick. Single-flight + unref + injectable-logger shape.
 * Cadence clamped to [5s, 1h].
 */

import { appendInbound, type InboundFetchOptions, type InboundMessage } from "@muse/messaging";

interface ChannelPollingProvider {
  pollUpdates(options?: InboundFetchOptions): Promise<readonly InboundMessage[]>;
}

export interface ChannelPollOptions {
  readonly provider: ChannelPollingProvider;
  readonly inboxFile: string;
  readonly channels: readonly string[];
  /** Log prefix used for both the summary log and the per-channel error log. */
  readonly logPrefix: string;
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export interface ChannelPollHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export function startChannelPollTick(options: ChannelPollOptions): ChannelPollHandle {
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
          options.errorLogger?.(`${options.logPrefix}: channel ${channel}: ${message}`);
        }
      }
      if (totalIngested > 0) {
        options.logger?.(
          `${options.logPrefix}: ingested ${totalIngested.toString()} message(s) across ${options.channels.length.toString()} channel(s)`
        );
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
 * Parse a comma-separated channel id list (`id1,id2,id3`). Trims
 * each entry and drops empties. Returns `undefined` when the raw
 * value is missing/blank so the daemon stays off.
 */
export function parsePollChannelsCsv(raw: string | undefined): readonly string[] | undefined {
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
