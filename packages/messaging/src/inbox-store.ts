/**
 * Persisted inbox for messaging providers that deliver via webhook.
 *
 * Phase 2.b.1 of `docs/design/line-webhook.md`. The webhook handler
 * (next iter) appends each parsed `InboundMessage` here; the
 * provider's `fetchInbound` (iter after) reads back. The two
 * surfaces share the on-disk shape so a Line message round-trips
 * unchanged regardless of which surface walks it next.
 *
 * `~/.muse/line-inbox.json` (or whatever path the caller supplies)
 * is a single JSON object `{ inbox: InboundMessage[] }`, atomic
 * `tmp`+rename writes, capped to `capacity` newest entries (default
 * 500). The cap is enforced on append — `readInbox` doesn't trim.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { InboundMessage } from "./types.js";

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 5_000;
const DEFAULT_READ_LIMIT = 100;
export const MAX_READ_LIMIT = 200;

interface PersistedShape {
  readonly version: 1;
  readonly inbox: readonly InboundMessage[];
}

/**
 * Read the persisted inbox newest-first, optionally capped at
 * `limit`. Missing / malformed files yield an empty array — same
 * idempotent-read pattern personal-tasks-store uses.
 */
export async function readInbox(file: string, limit?: number): Promise<readonly InboundMessage[]> {
  const cap = clampReadLimit(limit);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { inbox?: unknown }).inbox)) {
    return [];
  }
  const all = (parsed as { inbox: unknown[] }).inbox.flatMap((entry): readonly InboundMessage[] =>
    isInboundMessage(entry) ? [entry] : []
  );
  // The file is stored newest-last so writes can append in O(1)
  // semantically; reverse + slice to deliver newest-first.
  return [...all].reverse().slice(0, cap);
}

export interface AppendInboundOptions {
  readonly capacity?: number;
}

/**
 * Append a single inbound message to the persisted file, trimming
 * to `capacity` newest entries. Atomic tmp+rename for crash safety,
 * AND per-file write serialization so two concurrent webhook
 * invocations don't both read the same inbox snapshot and clobber
 * each other's append at rename time.
 */
const writeQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;

export async function appendInbound(
  file: string,
  message: InboundMessage,
  options: AppendInboundOptions = {}
): Promise<void> {
  const prior = writeQueues.get(file) ?? resolvedPromise();
  const run = (): Promise<void> => doAppendInbound(file, message, options);
  const next = prior.then(run, run);
  writeQueues.set(file, next.catch(() => undefined));
  return next;
}

async function doAppendInbound(
  file: string,
  message: InboundMessage,
  options: AppendInboundOptions
): Promise<void> {
  const capacity = clampCapacity(options.capacity);
  const existing = await readPersistedRaw(file);
  // Stored newest-last so the append is straightforward; the trim
  // drops the oldest from the front.
  const next = [...existing, message];
  const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
  const payload: PersistedShape = { inbox: trimmed, version: 1 };
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

async function readPersistedRaw(file: string): Promise<readonly InboundMessage[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { inbox?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.inbox)) {
      return [];
    }
    return (parsed.inbox as unknown[]).flatMap((entry): readonly InboundMessage[] =>
      isInboundMessage(entry) ? [entry] : []
    );
  } catch {
    return [];
  }
}

function clampReadLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_READ_LIMIT;
  }
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(raw)));
}

function clampCapacity(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) {
    return DEFAULT_CAPACITY;
  }
  return Math.max(1, Math.min(MAX_CAPACITY, Math.trunc(raw)));
}

function isInboundMessage(value: unknown): value is InboundMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as InboundMessage;
  return typeof candidate.providerId === "string"
    && typeof candidate.messageId === "string"
    && typeof candidate.source === "string"
    && typeof candidate.receivedAtIso === "string"
    && typeof candidate.text === "string";
}
