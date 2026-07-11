/**
 * Per-channel "after" cursor for Discord's
 * `GET /channels/:id/messages?after=<snowflake>` endpoint.
 *
 * Thin delegation onto `channel-cursor-store.ts` (the generic
 * per-channel cursor sidecar shared with `slack-after-store.ts`) —
 * kept as a named module so consumers (the Discord polling path,
 * tests) don't need to know the shared implementation lives
 * elsewhere.
 */

import { readChannelCursor, writeChannelCursor } from "./channel-cursor-store.js";

export async function readDiscordAfter(file: string, channelId: string): Promise<string | undefined> {
  return readChannelCursor(file, channelId);
}

export async function writeDiscordAfter(file: string, channelId: string, after: string): Promise<void> {
  return writeChannelCursor(file, channelId, after);
}
