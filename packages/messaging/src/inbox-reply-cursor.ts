import { promises as fs } from "node:fs";

import { atomicWritePrivateFile, withMessagingFileMutation } from "./messaging-file-store.js";

/**
 * Persisted set of inbound message keys (`${providerId}:${messageId}`)
 * the conversational reply loop has already answered, so a restart
 * or overlapping tick never double-replies. Distinct from the
 * context-injection cursor (that one is "last injected per source"
 * for prompt context; this one is "answered" for the reply loop).
 *
 * Bounded to the most recent `MAX_HANDLED` keys — the inbox file is
 * itself trimmed, so older keys can never reappear and don't need
 * retaining. Atomic tmp+rename, 0o600, like the other personal
 * stores.
 */

const MAX_HANDLED = 500;

interface PersistedShape {
  readonly version: 1;
  readonly handled: readonly string[];
}

export async function readReplyCursor(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; handled?: unknown };
    if (parsed && parsed.version === 1 && Array.isArray(parsed.handled)) {
      return new Set(parsed.handled.filter((k): k is string => typeof k === "string"));
    }
  } catch {
    // malformed → treat as empty; the loop just re-answers (idempotent enough)
  }
  return new Set();
}

export async function appendReplyCursor(file: string, newKeys: readonly string[]): Promise<void> {
  if (newKeys.length === 0) {
    return;
  }
  // A missing key results in a duplicate user-facing reply. The complete
  // mutation must therefore be shared by the API and CLI daemons too.
  await withMessagingFileMutation(file, async () => {
    const merged = new Set(await readReplyCursor(file));
    for (const key of newKeys) {
      merged.add(key);
    }
    const all = [...merged];
    const bounded = all.slice(Math.max(0, all.length - MAX_HANDLED));
    const payload: PersistedShape = { handled: bounded, version: 1 };
    await atomicWritePrivateFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  });
}
