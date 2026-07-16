import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

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

export async function readAckCursor(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; acked?: unknown };
    if (parsed && parsed.version === 1 && Array.isArray(parsed.acked)) {
      return new Set(parsed.acked.filter((k): k is string => typeof k === "string"));
    }
  } catch {
    // malformed → treat as empty; worst case one duplicate ack, never a lost final answer
  }
  return new Set();
}

export async function appendAckCursor(file: string, newKeys: readonly string[]): Promise<void> {
  if (newKeys.length === 0) {
    return;
  }
  // Losing an acknowledged key causes a second acknowledgement. Coordinate
  // the complete read-merge-write across both daemon processes.
  await withMessagingFileMutation(file, async () => {
    const merged = new Set(await readAckCursor(file));
    for (const key of newKeys) {
      merged.add(key);
    }
    const all = [...merged];
    const bounded = all.slice(Math.max(0, all.length - MAX_ACKED));
    const payload: PersistedShape = { acked: bounded, version: 1 };
    await atomicWritePrivateFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  });
}
