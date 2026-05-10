/**
 * Per-channel `ts` cursor for Slack's `conversations.history?oldest=<ts>`.
 *
 * Slack's API is per-channel (no global stream), so the store is a
 * `{ channelId → ts }` map — same shape as `discord-after-store.ts`,
 * different cursor type. Slack `ts` is an epoch-seconds string with
 * microsecond precision (e.g. `"1700000000.123456"`); storing it
 * verbatim avoids float precision loss that would corrupt the
 * cursor across the JSON round-trip.
 *
 * Missing / malformed file → undefined for the given channel; first
 * poll then falls back to Slack's default (newest-first snapshot).
 * Atomic tmp+rename write, same as the Telegram/Discord stores.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

interface PersistedShape {
  readonly version: 1;
  readonly after: Readonly<Record<string, string>>;
}

export async function readSlackAfter(file: string, channelId: string): Promise<string | undefined> {
  const map = await readMap(file);
  const value = map[channelId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function writeSlackAfter(file: string, channelId: string, after: string): Promise<void> {
  if (typeof after !== "string" || after.length === 0) {
    throw new TypeError(`after must be a non-empty string, got ${String(after)}`);
  }
  const existing = await readMap(file);
  const next: PersistedShape = {
    after: { ...existing, [channelId]: after },
    version: 1
  };
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
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
