/**
 * Slack polling daemon (Phase 2.d.3) — a per-provider wrapper
 * around the generic `channel-poll-tick.ts` factory. The shape
 * collapsed here (multi-channel `pollUpdates({ source })` →
 * `appendInbound`) is shared with Discord; only the provider type
 * and log prefix differ.
 *
 * Off by default. Activates only when:
 *   - `MUSE_SLACK_POLL_ENABLED === "1"`, and
 *   - `MUSE_SLACK_POLL_CHANNELS` is a non-empty CSV (e.g.
 *     `C0123ABCD,C0456EFGH`), and
 *   - the messaging registry has the `slack` provider, and
 *   - `inboxFile` is configured.
 */

import type { SlackProvider } from "@muse/messaging";

import {
  parsePollChannelsCsv,
  startChannelPollTick,
  type ChannelPollHandle
} from "./channel-poll-tick.js";

export interface SlackPollOptions {
  readonly provider: SlackProvider;
  readonly inboxFile: string;
  /** Channel IDs to poll each tick. Empty → daemon never registered. */
  readonly channels: readonly string[];
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export type SlackPollHandle = ChannelPollHandle;

export function startSlackPollTick(options: SlackPollOptions): SlackPollHandle {
  return startChannelPollTick({ ...options, logPrefix: "slack-poll" });
}

/**
 * Parse `MUSE_SLACK_POLL_CHANNELS` of the form `C0123ABCD,C0456EFGH`.
 * Identical to Discord's CSV parser — both delegate to
 * `parsePollChannelsCsv`. Kept as a per-provider re-export so call
 * sites read locally (env var name lines up with import name).
 */
export const parseSlackPollChannels = parsePollChannelsCsv;
