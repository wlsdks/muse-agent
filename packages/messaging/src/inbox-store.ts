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

import type { InboundMessage } from "./types.js";
import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 5_000;
const DEFAULT_READ_LIMIT = 100;
export const MAX_READ_LIMIT = 200;
const MAX_IDEMPOTENCY_KEYS = 10_000;

interface PersistedShape {
  readonly version: 1;
  readonly inbox: readonly InboundMessage[];
  /** Bounded delivery receipts retained independently from inbox capacity. */
  readonly idempotencyKeys?: readonly string[];
}

interface PersistedInbox {
  readonly inbox: readonly InboundMessage[];
  readonly idempotencyKeys: readonly string[];
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
  /**
   * Stable delivery identifier supplied by a webhook provider. Unlike a
   * message retained in the inbox, this receipt remains after inbox capacity
   * trims so a delayed redelivery can still be ignored.
   */
  readonly idempotencyKey?: string;
}

/**
 * Append a single inbound message to the persisted file, trimming
 * to `capacity` newest entries. Atomic tmp+rename for crash safety,
 * per-file write serialization so two concurrent webhook invocations
 * don't clobber each other's append, and provider/source/message-id
 * idempotence. Provider delivery keys get a separate bounded receipt ledger;
 * deduplication outside that ledger's retention window is best-effort.
 */
export async function appendInbound(
  file: string,
  message: InboundMessage,
  options: AppendInboundOptions = {}
): Promise<boolean> {
  return withMessagingFileMutation(file, () => doAppendInbound(file, message, options));
}

async function doAppendInbound(
  file: string,
  message: InboundMessage,
  options: AppendInboundOptions
): Promise<boolean> {
  const capacity = clampCapacity(options.capacity);
  const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
  const existing = await readPersistedInbox(file);
  if (idempotencyKey !== undefined && existing.idempotencyKeys.includes(idempotencyKey)) {
    return false;
  }
  if (existing.inbox.some((entry) => isSameInboundMessage(entry, message))) {
    if (idempotencyKey !== undefined) {
      const payload: PersistedShape = {
        idempotencyKeys: retainRecentIdempotencyKeys(existing.idempotencyKeys, idempotencyKey),
        inbox: existing.inbox,
        version: 1
      };
      await atomicWritePrivateFile(file, `${JSON.stringify(payload, null, 2)}\n`);
    }
    return false;
  }
  // Stored newest-last so the append is straightforward; the trim
  // drops the oldest from the front.
  const next = [...existing.inbox, message];
  const trimmed = next.length > capacity ? next.slice(next.length - capacity) : next;
  const idempotencyKeys = idempotencyKey === undefined
    ? existing.idempotencyKeys
    : retainRecentIdempotencyKeys(existing.idempotencyKeys, idempotencyKey);
  const payload: PersistedShape = { idempotencyKeys, inbox: trimmed, version: 1 };
  await atomicWritePrivateFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  return true;
}

async function readPersistedInbox(file: string): Promise<PersistedInbox> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { idempotencyKeys: [], inbox: [] };
  }
  try {
    const parsed = JSON.parse(raw) as { inbox?: unknown; idempotencyKeys?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.inbox)) {
      return { idempotencyKeys: [], inbox: [] };
    }
    return {
      idempotencyKeys: parseIdempotencyKeys(parsed.idempotencyKeys),
      inbox: (parsed.inbox as unknown[]).flatMap((entry): readonly InboundMessage[] =>
        isInboundMessage(entry) ? [entry] : []
      )
    };
  } catch {
    return { idempotencyKeys: [], inbox: [] };
  }
}

function parseIdempotencyKeys(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry): readonly string[] => normalizeIdempotencyKey(entry) === undefined ? [] : [entry])
    .slice(-MAX_IDEMPOTENCY_KEYS);
}

function retainRecentIdempotencyKeys(existing: readonly string[], next: string): readonly string[] {
  return [...existing, next].slice(-MAX_IDEMPOTENCY_KEYS);
}

function normalizeIdempotencyKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

function isSameInboundMessage(left: InboundMessage, right: InboundMessage): boolean {
  return left.providerId === right.providerId
    && left.source === right.source
    && left.messageId === right.messageId;
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
