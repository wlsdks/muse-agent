import type { MessagingProviderRegistry } from "./registry.js";
import type { InboundMessage } from "./types.js";

/**
 * Structural duck-type of the agent runner. `@muse/messaging` must
 * not depend on `@muse/agent-core`; the API wires the real
 * AgentRuntime in (same pattern the proactive loop uses).
 */
export interface InboundAgentRunner {
  run(input: {
    readonly text: string;
    readonly source: string;
    readonly providerId: string;
  }): Promise<string>;
}

export interface RespondToInboundOptions {
  readonly messages: readonly InboundMessage[];
  readonly runner: InboundAgentRunner;
  readonly registry: MessagingProviderRegistry;
  /** `${providerId}:${messageId}` keys already answered — skipped. */
  readonly alreadyHandled?: ReadonlySet<string>;
}

export interface RespondToInboundResult {
  /** Keys answered (agent ran) this batch — caller persists these. */
  readonly handled: readonly string[];
  /** How many non-empty replies were actually dispatched. */
  readonly replied: number;
  readonly errors: readonly string[];
}

export function inboundKey(message: { readonly providerId: string; readonly messageId: string }): string {
  return `${message.providerId}:${message.messageId}`;
}

/**
 * The conversational reply loop: for each new inbound message, run
 * the agent on its text and send the answer back to the originating
 * channel (`source`) via the same provider. A per-message failure
 * is collected and does NOT mark the message handled, so a
 * transient agent error is retried on the next pass rather than
 * silently dropping the user's message.
 */
export async function respondToInbound(
  options: RespondToInboundOptions
): Promise<RespondToInboundResult> {
  const already = options.alreadyHandled ?? new Set<string>();
  const handled: string[] = [];
  const errors: string[] = [];
  let replied = 0;

  for (const message of options.messages) {
    const key = inboundKey(message);
    if (already.has(key) || handled.includes(key)) {
      continue;
    }
    try {
      // "typing…" presence while the agent composes — cosmetic, so a
      // failure (unsupported provider, dead chat) never blocks the reply.
      try {
        const provider = options.registry.require(message.providerId);
        if (provider.sendTyping) {
          await provider.sendTyping(message.source);
        }
      } catch {
        // ignore: presence is best-effort
      }
      const reply = (
        await options.runner.run({
          providerId: message.providerId,
          source: message.source,
          text: message.text
        })
      ).trim();
      if (reply.length === 0) {
        // Agent consumed it and chose to stay silent — done, don't
        // reprocess; nothing to send.
        handled.push(key);
        continue;
      }
      await options.registry.send(message.providerId, {
        destination: message.source,
        text: reply
      });
      // Mark handled ONLY after the reply is actually delivered: a
      // transient send failure (rate limit / network) must be
      // retried next pass, not silently swallowed with the answer
      // lost forever.
      handled.push(key);
      replied += 1;
    } catch (cause) {
      errors.push(`${key}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  return { errors, handled, replied };
}
