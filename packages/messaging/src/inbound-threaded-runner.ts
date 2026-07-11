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
}) => Promise<string>;

/**
 * Wrap an agent call so each channel ({providerId}:{source}) is a
 * continuous session: prior turns are prepended to the new message,
 * and the user message + the agent's reply are persisted so the
 * NEXT inbound message on that channel sees them. `respondToInbound`
 * and the tick are unchanged — continuity lives behind the runner.
 */
export function createThreadedInboundRunner(options: {
  readonly run: ThreadedAgentRun;
  readonly threadFile: string;
}): InboundAgentRunner {
  return {
    run: async ({ text, source, providerId, scope }) => {
      const key = `${providerId}:${source}`;
      const prior = await readThread(options.threadFile, key);
      const reply = await options.run({
        messages: [...prior, { content: text, role: "user" }],
        providerId,
        source,
        ...(scope ? { scope } : {})
      });
      await appendThreadTurns(options.threadFile, key, [
        { content: text, role: "user" },
        { content: reply, role: "assistant" }
      ]);
      return reply;
    }
  };
}
