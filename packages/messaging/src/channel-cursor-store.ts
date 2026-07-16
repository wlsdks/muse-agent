/**
 * Generic per-channel cursor sidecar, shared by the Discord `after`
 * store (snowflake cursor) and the Slack `after` store (`ts` cursor).
 * Both providers are per-channel APIs with no global "what's new?"
 * stream, so each keeps a `{ channelId → cursor }` map on disk.
 *
 * Shape:
 *   { "version": 1, "after": { "<channelId>": "<cursor>", ... } }
 *
 * Cursors are stored verbatim as strings — Discord snowflakes are
 * 64-bit IDs that would lose precision as JSON numbers, and Slack's
 * `ts` is an epoch-seconds string with microsecond precision that
 * would suffer float rounding across the JSON round-trip.
 *
 * Missing / malformed file → undefined for the given channel, so the
 * first poll falls back to the provider's default (newest-first
 * snapshot). Writes are atomic (tmp + rename).
 */

import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

interface PersistedShape {
  readonly version: 1;
  readonly after: Readonly<Record<string, string>>;
}

export async function readChannelCursor(file: string, channelId: string): Promise<string | undefined> {
  const map = await readMap(file);
  const value = map[channelId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function writeChannelCursor(file: string, channelId: string, cursor: string): Promise<void> {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new TypeError(`after must be a non-empty string, got ${String(cursor)}`);
  }
  await withMessagingFileMutation(file, async () => {
    const existing = await readMap(file);
    const next: PersistedShape = {
      after: { ...existing, [channelId]: cursor },
      version: 1
    };
    await atomicWritePrivateFile(file, `${JSON.stringify(next, null, 2)}\n`);
  });
}

async function readMap(file: string): Promise<Readonly<Record<string, string>>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  const candidate = (parsed as { after?: unknown }).after;
  if (!candidate || typeof candidate !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}
