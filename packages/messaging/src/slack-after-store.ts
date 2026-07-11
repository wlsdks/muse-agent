/**
 * Per-channel `ts` cursor for Slack's `conversations.history?oldest=<ts>`.
 *
 * Thin delegation onto `channel-cursor-store.ts` (the generic
 * per-channel cursor sidecar shared with `discord-after-store.ts`) —
 * kept as a named module so consumers (the Slack polling path,
 * tests) don't need to know the shared implementation lives
 * elsewhere.
 */

import { readChannelCursor, writeChannelCursor } from "./channel-cursor-store.js";

export async function readSlackAfter(file: string, channelId: string): Promise<string | undefined> {
  return readChannelCursor(file, channelId);
}

export async function writeSlackAfter(file: string, channelId: string, after: string): Promise<void> {
  return writeChannelCursor(file, channelId, after);
}
