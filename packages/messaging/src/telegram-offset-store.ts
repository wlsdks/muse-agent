/**
 * Persisted `update_id` offset for Telegram's `getUpdates`.
 *
 * Telegram's Bot API redelivers any update the bot hasn't
 * acknowledged via `?offset=<update_id+1>` for ~24h, so a polling
 * client that doesn't track offset will reprocess the same messages
 * every tick. This store is the single-integer sidecar that lets
 * `TelegramProvider.fetchInbound` advance through the queue.
 *
 * Shape: `{ "version": 1, "offset": <number> }`. Missing /
 * malformed files yield `undefined` — first poll then starts at
 * Telegram's default (oldest visible update). Atomic tmp+rename
 * write, same pattern as `inbox-store.ts`.
 */

import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

interface PersistedShape {
  readonly version: 1;
  readonly offset: number;
}

export async function readTelegramOffset(file: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const candidate = (parsed as { offset?: unknown }).offset;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return undefined;
  }
  return Math.trunc(candidate);
}

export async function writeTelegramOffset(file: string, offset: number): Promise<void> {
  if (!Number.isFinite(offset)) {
    throw new TypeError(`offset must be a finite number, got ${String(offset)}`);
  }
  await withMessagingFileMutation(file, async () => {
    // Telegram offsets acknowledge every update below the cursor, so moving
    // backwards replays old messages. A slower concurrent poll may only keep
    // the newer cursor, never overwrite it with an older one.
    const persisted = await readTelegramOffset(file);
    const nextOffset = Math.max(persisted ?? Number.NEGATIVE_INFINITY, Math.trunc(offset));
    const payload: PersistedShape = { offset: nextOffset, version: 1 };
    await atomicWritePrivateFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  });
}
