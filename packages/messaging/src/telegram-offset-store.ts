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
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

interface PersistedShape {
  readonly version: 1;
  readonly offset: number;
}

function isPersistedTelegramOffset(value: unknown): value is PersistedShape {
  return isRecord(value) && value.version === 1 && typeof value.offset === "number" && Number.isFinite(value.offset);
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
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPersistedTelegramOffset(parsed)) {
    return undefined;
  }
  return Math.trunc(parsed.offset);
}

export async function writeTelegramOffset(file: string, offset: number): Promise<void> {
  if (!Number.isFinite(offset)) {
    throw new TypeError(`offset must be a finite number, got ${String(offset)}`);
  }
  const payload: PersistedShape = { offset: Math.trunc(offset), version: 1 };
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  // 0o600: this sidecar reveals which Telegram bot updates this
  // process has acknowledged. Sibling `inbound-thread-store` already
  // uses user-only mode (its docstring calls it out as the convention)
  // — default umask would leave this file world-readable on a shared
  // box, leaking the user's polling cadence + chat ids.
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}
