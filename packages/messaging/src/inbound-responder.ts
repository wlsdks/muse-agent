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
    /**
     * Conversation-scope hint carried straight through from
     * `InboundMessage.scope` (see `conversation-scope.ts`). Threaded
     * unmodified so the caller can gate pairing / memory / risky-tool
     * approval on it — `respondToInbound` itself stays scope-agnostic.
     */
    readonly scope?: string;
    /**
     * Second-channel send toward the SAME destination as the eventual
     * reply, for a delegation acknowledgment sent before the agent run
     * completes. Cosmetic — a failed notify must never fail the run.
     */
    readonly notify?: (text: string) => Promise<void>;
  }): Promise<string>;
}

export interface RespondToInboundOptions {
  readonly messages: readonly InboundMessage[];
  readonly runner: InboundAgentRunner;
  readonly registry: MessagingProviderRegistry;
  /** `${providerId}:${messageId}` keys already answered — skipped. */
  readonly alreadyHandled?: ReadonlySet<string>;
  /**
   * `${providerId}:${messageId}` keys whose delegation ack has already
   * been DELIVERED (see `acked` below) — for these, `notify` is not
   * wired into the runner at all, so a retry of the final reply (e.g.
   * after a transient `registry.send` failure) never composes or sends
   * a second ack. A message not yet acked still gets `notify` wired
   * every retry, same as today.
   */
  readonly ackAlreadySent?: ReadonlySet<string>;
  /**
   * Re-fire cadence for the typing indicator while the agent thinks.
   * Telegram's typing presence expires after ~5s, so a slow local
   * model needs periodic keepalives or the chat looks dead mid-turn.
   */
  readonly typingIntervalMs?: number;
}

const DEFAULT_TYPING_INTERVAL_MS = 4_000;

export interface RespondToInboundResult {
  /** Keys answered (agent ran) this batch — caller persists these. */
  readonly handled: readonly string[];
  /**
   * Keys whose delegation ack was actually DELIVERED this batch (the
   * wrapped `notify` reached `registry.send` without throwing) —
   * caller persists these the same way as `handled`, into
   * `ackAlreadySent` for the next call. Independent of `handled`: an
   * ack can deliver even when the final reply send then fails and the
   * message stays unhandled (retried), and that retry must not
   * re-send the ack.
   */
  readonly acked: readonly string[];
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
  const ackAlreadySent = options.ackAlreadySent ?? new Set<string>();
  const handled: string[] = [];
  const acked: string[] = [];
  const errors: string[] = [];
  let replied = 0;

  for (const message of options.messages) {
    const key = inboundKey(message);
    if (already.has(key) || handled.includes(key)) {
      continue;
    }
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // "typing…" presence while the agent composes — cosmetic, so a
      // failure (unsupported provider, dead chat) never blocks the reply.
      try {
        const provider = options.registry.require(message.providerId);
        if (provider.sendTyping) {
          const sendTyping = provider.sendTyping.bind(provider);
          await sendTyping(message.source);
          typingTimer = setInterval(() => {
            void sendTyping(message.source).catch(() => undefined);
          }, options.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS);
          if (typeof typingTimer.unref === "function") {
            typingTimer.unref();
          }
        }
      } catch {
        // ignore: presence is best-effort
      }
      const reply = (
        await options.runner.run({
          providerId: message.providerId,
          source: message.source,
          text: message.text,
          // An already-DELIVERED ack for this key gets no notify seam at
          // all — the runner then sees `notify === undefined` and never
          // composes or sends a second one on a retried run.
          ...(ackAlreadySent.has(key)
            ? {}
            : {
                notify: async (text: string) => {
                  try {
                    await options.registry.send(message.providerId, {
                      destination: message.source,
                      text
                    });
                    if (!acked.includes(key)) {
                      acked.push(key);
                    }
                  } catch {
                    // Ack delivery is cosmetic — a failed notify must never
                    // fail the run or affect handled-marking. Not recording
                    // it here means a genuinely lost ack CAN retry next
                    // pass — acceptable: this is at-most-once per
                    // DELIVERED ack, i.e. what the user actually sees.
                  }
                }
              }),
          ...(message.scope ? { scope: message.scope } : {})
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
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
    }
  }

  return { acked, errors, handled, replied };
}
