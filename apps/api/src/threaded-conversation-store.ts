/**
 * Telegram/Matrix half of the shared conversation store (S3b): the inbound
 * reply daemons' `createThreadedInboundRunner` reads/writes per-channel
 * thread history through this `ThreadedTurnStore` adapter — backed by the
 * SAME `FileConversationStore` the CLI and web use — so a Telegram/Matrix
 * chat shows up in `muse chats` and can be resumed on the desktop. The
 * conversation id is exactly the runner's thread key (`${providerId}:${source}`,
 * e.g. `telegram:123456789`).
 *
 * `runUserId` memory/persona scoping (`inbound-agent-run.ts`) is a SEPARATE,
 * deliberate privacy boundary — untouched here. This module only threads the
 * TRANSCRIPT; it does not affect which user-memory bucket a reply draws from.
 */

import { access, rename } from "node:fs/promises";

import { readAllThreads, type ThreadedTurnStore, type ThreadTurn } from "@muse/messaging";
import { FileConversationStore, recentChatTurns } from "@muse/stores";
import { isRecord } from "@muse/shared";

// The pre-S3b `inbound-thread-store.ts` MAX_TURNS — a RAW turn count (not a
// pair count), preserved so migrating to the conversation store doesn't
// silently widen a Telegram/Matrix reply's context window.
export const THREADED_CHANNEL_READ_LIMIT = 12;

/**
 * Adapts `FileConversationStore` to the runner's generic `ThreadedTurnStore`
 * contract. Every failure fails soft: a read that can't resolve returns no
 * prior turns (fresh-context fallback, never a thrown error that would kill
 * the reply daemon), and a write that can't land is swallowed so a store
 * hiccup never costs the user their already-generated reply.
 */
export function conversationStoreThreadedTurnStore(
  store: FileConversationStore,
  options: { readonly origin: string }
): ThreadedTurnStore {
  return {
    append: async (key, turns) => {
      // Control-plane slash commands (S5, /new /status /model /help) are
      // not conversation content — persisting them would pollute the next
      // turn's context and, for /new specifically, immediately re-add a
      // turn to the very conversation it just cleared.
      if (turns.some((turn) => turn.role === "user" && turn.content.trim().startsWith("/"))) {
        return;
      }
      try {
        await store.appendTurns(
          key,
          turns.map((turn) => ({ content: turn.content, role: turn.role })),
          { origin: options.origin }
        );
      } catch {
        /* fail-soft — see this function's doc comment */
      }
    },
    read: async (key) => {
      try {
        const conversation = await store.get(key);
        return recentChatTurns(conversation?.turns ?? [], THREADED_CHANNEL_READ_LIMIT).map((turn) => ({
          content: turn.content,
          role: turn.role
        }));
      } catch {
        return [];
      }
    }
  };
}

export interface ThreadMigrationResult {
  readonly migrated: boolean;
  readonly threadCount: number;
}

/**
 * One-time lossless import of a legacy `${threadFile}` (the flat per-channel
 * JSON thread store) into the conversation store, then renames the legacy
 * file to `.migrated`. The rename happens ONLY after every thread's turns
 * have landed — a failure mid-import (or a missing/malformed source file)
 * leaves the legacy file exactly as it was, so a retry on the next boot is
 * always safe. A missing legacy file (already migrated, or never existed)
 * is a no-op: `{ migrated: false, threadCount: 0 }`.
 */
export async function migrateLegacyThreadFile(
  threadFile: string,
  store: FileConversationStore,
  options: { readonly origin: string }
): Promise<ThreadMigrationResult> {
  try {
    await access(threadFile);
  } catch {
    return { migrated: false, threadCount: 0 };
  }
  const threads = await readAllThreads(threadFile);
  const entries = Object.entries(threads).filter((entry): entry is [string, readonly ThreadTurn[]] => {
    const turns = entry[1];
    return Array.isArray(turns) && turns.every((turn): turn is ThreadTurn => isThreadTurn(turn));
  });
  try {
    for (const [key, turns] of entries) {
      await store.appendTurns(key, turns.map((turn) => ({ content: turn.content, role: turn.role })), {
        origin: options.origin
      });
    }
  } catch {
    // A partial import must never look "done" — leave the legacy file
    // intact so the next boot retries the whole thing from scratch.
    return { migrated: false, threadCount: 0 };
  }
  await rename(threadFile, `${threadFile}.migrated`);
  return { migrated: true, threadCount: entries.length };
}

function isThreadTurn(value: unknown): value is ThreadTurn {
  return isThreadTurnObject(value) && (value.role === "user" || value.role === "assistant") && typeof value.content === "string";
}

function isThreadTurnObject(value: unknown): value is { readonly role: unknown; readonly content: unknown } {
  return isRecord(value);
}
