/**
 * Discord polling daemon (Phase 2.c.3) — a per-provider wrapper
 * around the generic `channel-poll-tick.ts` factory. The shape
 * collapsed here (multi-channel `pollUpdates({ source })` →
 * `appendInbound`) is shared with Slack; only the provider type
 * and log prefix differ, so the daemon logic lives in one place
 * and these wrappers exist to keep the per-provider import names
 * familiar at call sites.
 *
 * Off by default. Activates only when:
 *   - `MUSE_DISCORD_POLL_ENABLED === "1"`, and
 *   - `MUSE_DISCORD_POLL_CHANNELS` is a non-empty CSV, and
 *   - the messaging registry has the `discord` provider, and
 *   - `inboxFile` is configured.
 */

import type { DiscordProvider } from "@muse/messaging";

import {
  parsePollChannelsCsv,
  startChannelPollTick,
  type ChannelPollHandle
} from "./channel-poll-tick.js";

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

export type DiscordPollHandle = ChannelPollHandle;

export function startDiscordPollTick(options: DiscordPollOptions): DiscordPollHandle {
  return startChannelPollTick({ ...options, logPrefix: "discord-poll" });
}

/**
 * Parse `MUSE_DISCORD_POLL_CHANNELS` of the form `id1,id2,id3`.
 * Identical to Slack's CSV parser — both delegate to
 * `parsePollChannelsCsv`. Kept as a per-provider re-export so call
 * sites read locally (env var name lines up with import name).
 */
export const parseDiscordPollChannels = parsePollChannelsCsv;
