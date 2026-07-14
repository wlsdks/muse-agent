import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isRecord } from "@muse/shared";

/**
 * DEPRECATED (S3b) production backend — the API server now wires Telegram/
 * Matrix through `FileConversationStore` (`apps/api/src/threaded-conversation-
 * store.ts`) so a channel thread is an addressable conversation, same store
 * the CLI/web use. This module survives ONLY for the one-time migration read
 * of a pre-existing `${inboxFile}.threads.json` file, and as a still-valid
 * generic `ThreadedTurnStore` backend (`fileThreadedTurnStore`) for a caller
 * that hasn't migrated. Do not add new production call sites.
 *
 * Per-channel conversation memory for the inbound reply loop, so a
 * channel chat is a continuous session (the user's 2nd message
 * sees the 1st turn). Keyed by `${providerId}:${source}` — each
 * chat / DM is its own thread; threads never bleed into each other.
 *
 * Bounded to the most recent `MAX_TURNS` messages per thread (the
 * agent context budget trims anyway; unbounded growth would be a
 * slow leak). Atomic tmp+rename, 0o600, like the sibling stores.
 */

export interface ThreadTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

const MAX_TURNS = 12;

interface PersistedShape {
  readonly version: 1;
  readonly threads: Readonly<Record<string, readonly ThreadTurn[]>>;
}

function isTurn(value: unknown): value is ThreadTurn {
  if (!isRecord(value)) {
    return false;
  }
  return (value.role === "user" || value.role === "assistant") && typeof value.content === "string";
}

function isPersistedThreadStore(value: unknown): value is PersistedShape {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.threads) &&
    Object.values(value.threads).every((thread) => Array.isArray(thread) && thread.every(isTurn))
  );
}

async function readAll(file: string): Promise<Record<string, ThreadTurn[]>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPersistedThreadStore(parsed)) {
      return { ...parsed.threads };
    }
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.threads)) {
      const out: Record<string, ThreadTurn[]> = {};
      for (const [key, value] of Object.entries(parsed.threads)) {
        if (Array.isArray(value)) {
          out[key] = value.filter(isTurn);
        }
      }
      return out;
    }
  } catch {
    // malformed → treat as no history (the chat just starts fresh)
  }
  return {};
}

export async function readThread(file: string, key: string): Promise<readonly ThreadTurn[]> {
  return (await readAll(file))[key] ?? [];
}

/** Every thread in the legacy file, keyed by `${providerId}:${source}` —
 *  ONLY for the one-time migration into `FileConversationStore` (S3b). */
export async function readAllThreads(file: string): Promise<Readonly<Record<string, readonly ThreadTurn[]>>> {
  return readAll(file);
}

const writeQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;

export async function appendThreadTurns(
  file: string,
  key: string,
  turns: readonly ThreadTurn[]
): Promise<void> {
  if (turns.length === 0) {
    return;
  }
  const prior = writeQueues.get(file) ?? resolvedPromise();
  const next = prior.then(
    () => doAppendThreadTurns(file, key, turns),
    () => doAppendThreadTurns(file, key, turns)
  );
  writeQueues.set(file, next.catch(() => undefined));
  return next;
}

async function doAppendThreadTurns(
  file: string,
  key: string,
  turns: readonly ThreadTurn[]
): Promise<void> {
  const all = await readAll(file);
  const merged = [...(all[key] ?? []), ...turns];
  all[key] = merged.slice(Math.max(0, merged.length - MAX_TURNS));
  const payload: PersistedShape = { threads: all, version: 1 };
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
