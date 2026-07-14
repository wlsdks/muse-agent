import type { InboundAgentRunner } from "./inbound-responder.js";
import { appendThreadTurns, readThread, type ThreadTurn } from "./inbound-thread-store.js";

/**
 * Message-array-aware agent call. The threaded runner builds the
 * full per-channel message history (prior turns + the new user
 * message) and hands it here; the API wires this to
 * `agentRuntime.run({ messages })`.
 */
export type ThreadedAgentRun = (input: {
  readonly messages: readonly ThreadTurn[];
  readonly source: string;
  readonly providerId: string;
  /** Conversation-scope hint threaded from `InboundMessage.scope` (see `conversation-scope.ts`). */
  readonly scope?: string;
  /** Delegation-ack notify seam, threaded through unmodified — see `InboundAgentRunner`. */
  readonly notify?: (text: string) => Promise<void>;
}) => Promise<string>;

/**
 * Backend the threaded runner reads/writes per-channel turn history
 * through — generic so a caller can point it at the flat JSON thread file
 * (`fileThreadedTurnStore`, still used for the one-time migration read) OR
 * at a different substrate entirely (e.g. the API server wires Telegram/
 * Matrix through `FileConversationStore` so a channel thread IS an
 * addressable conversation — see `apps/api/src/threaded-conversation-store.ts`).
 */
export interface ThreadedTurnStore {
  readonly read: (key: string) => Promise<readonly ThreadTurn[]>;
  readonly append: (key: string, turns: readonly ThreadTurn[]) => Promise<void>;
}

/** The original flat-file backend, still available for callers that want it
 *  (tests, or a channel that never migrated to the conversation store). */
export function fileThreadedTurnStore(threadFile: string): ThreadedTurnStore {
  return {
    append: (key, turns) => appendThreadTurns(threadFile, key, turns),
    read: (key) => readThread(threadFile, key)
  };
}

/**
 * Wrap an agent call so each channel ({providerId}:{source}) is a
 * continuous session: prior turns are prepended to the new message,
 * and the user message + the agent's reply are persisted so the
 * NEXT inbound message on that channel sees them. `respondToInbound`
 * and the tick are unchanged — continuity lives behind the runner.
 */
export function createThreadedInboundRunner(options: {
  readonly run: ThreadedAgentRun;
  readonly store: ThreadedTurnStore;
}): InboundAgentRunner {
  return {
    run: async ({ text, source, providerId, scope, notify }) => {
      const key = `${providerId}:${source}`;
      const prior = await options.store.read(key);
      const reply = await options.run({
        messages: [...prior, { content: text, role: "user" }],
        providerId,
        source,
        ...(scope ? { scope } : {}),
        ...(notify ? { notify } : {})
      });
      // Only the user turn + the final reply are persisted — the ack (if
      // any) is a cosmetic aside, not part of the conversation history.
      await options.store.append(key, [
        { content: text, role: "user" },
        { content: reply, role: "assistant" }
      ]);
      return reply;
    }
  };
}
