import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

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

function isPersistedReplyCursor(value: unknown): value is PersistedShape {
  return isRecord(value) && value.version === 1 && Array.isArray(value.handled) && value.handled.every((item) => typeof item === "string");
}

export async function readReplyCursor(file: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return new Set();
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPersistedReplyCursor(parsed)) {
      return new Set(parsed.handled);
    }
  } catch {
    // malformed → treat as empty; the loop just re-answers (idempotent enough)
  }
  return new Set();
}

// The "answered" cursor must not lose a key under overlapping ticks — a lost
// key means a message gets ANSWERED TWICE (a duplicate reply to the user), the
// exact double-reply this cursor exists to prevent. Two bugs were possible:
// the read-merge-write was unserialised (last-writer-wins drops the other tick's
// keys), and the tmp name was `${file}.tmp-${pid}` — NO uniquifier, so two
// same-process concurrent writers shared the identical tmp path (interleaved
// write / ENOENT rename). Fix: a per-file mutation queue + a randomUUID tmp.
const appendQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;

export async function appendReplyCursor(file: string, newKeys: readonly string[]): Promise<void> {
  if (newKeys.length === 0) {
    return;
  }
  const prior = appendQueues.get(file) ?? resolvedPromise();
  const op = async (): Promise<void> => {
    const merged = new Set(await readReplyCursor(file));
    for (const key of newKeys) {
      merged.add(key);
    }
    const all = [...merged];
    const bounded = all.slice(Math.max(0, all.length - MAX_HANDLED));
    const payload: PersistedShape = { handled: bounded, version: 1 };
    await fs.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  };
  const next = prior.then(op, op);
  appendQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}
