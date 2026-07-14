import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

/**
 * Persisted set of inbound message keys (`${providerId}:${messageId}`)
 * whose delegation ack has already been DELIVERED, so a restart or a
 * retried tick (the final reply send failed and the message is still
 * unhandled) never sends a second ack for the same message. Sibling
 * store to `inbox-reply-cursor.ts` — same shape, same atomic-write /
 * per-file-queue / bound-and-prune conventions, distinct file because
 * "acked" and "handled" are independent (an ack can deliver before the
 * final reply that marks a message handled).
 */

const MAX_ACKED = 500;

interface PersistedShape {
  readonly version: 1;
  readonly acked: readonly string[];
}

function isPersistedAckCursor(value: unknown): value is PersistedShape {
  return isRecord(value) && value.version === 1 && Array.isArray(value.acked) && value.acked.every((item) => typeof item === "string");
}

export async function readAckCursor(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPersistedAckCursor(parsed)) {
      return new Set(parsed.acked);
    }
  } catch {
    // malformed → treat as empty; worst case one duplicate ack, never a lost final answer
  }
  return new Set();
}

// Same race the reply cursor guards against: an overlapping tick must never
// lose an acked key (a lost key means a SECOND ack for the same message,
// exactly the duplicate this cursor exists to prevent). Per-file mutation
// queue + randomUUID tmp, mirrored from `appendReplyCursor`.
const appendQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;

export async function appendAckCursor(file: string, newKeys: readonly string[]): Promise<void> {
  if (newKeys.length === 0) {
    return;
  }
  const prior = appendQueues.get(file) ?? resolvedPromise();
  const op = async (): Promise<void> => {
    const merged = new Set(await readAckCursor(file));
    for (const key of newKeys) {
      merged.add(key);
    }
    const all = [...merged];
    const bounded = all.slice(Math.max(0, all.length - MAX_ACKED));
    const payload: PersistedShape = { acked: bounded, version: 1 };
    await fs.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  const next = prior.then(op, op);
  appendQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}
