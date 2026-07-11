/**
 * Conversational reply daemon. Each tick reads
 * the inbox file the poll/webhook ingestion daemons populate, runs
 * the full agent on every not-yet-answered inbound message, and
 * sends the agent's reply back to the originating channel — so a
 * message the user sends Muse on a wired channel IS a Muse session.
 *
 * Distinct from the poll daemon (that one only ingests → inbox);
 * this one consumes the inbox and answers. A dedicated reply cursor
 * (not the context-injection cursor) tracks answered messages so a
 * restart or overlapping tick never double-replies.
 *
 * Same single-flight + unref + injectable-logger + clamp shape as
 * `telegram-poll-tick.ts`. Off unless `MUSE_INBOUND_REPLY_ENABLED=1`.
 */

import {
  appendAckCursor,
  appendReplyCursor,
  readAckCursor,
  readInbox,
  readReplyCursor,
  respondToInbound,
  type InboundAgentRunner,
  type MessagingProviderRegistry
} from "@muse/messaging";

export interface InboundReplyOptions {
  readonly inboxFile: string;
  readonly cursorFile: string;
  /**
   * Sidecar recording delegation-ack delivery, so a re-run after a
   * transient final-send failure never sends a second ack for the
   * same message. Optional — defaults to `${cursorFile}.acked.json`,
   * same co-location convention as the reply cursor next to the inbox.
   */
  readonly ackCursorFile?: string;
  readonly runner: InboundAgentRunner;
  readonly registry: MessagingProviderRegistry;
  readonly intervalMs?: number;
  readonly fetchLimit?: number;
  readonly logger?: (message: string) => void;
  readonly errorLogger?: (message: string) => void;
}

export interface InboundReplyHandle {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export function startInboundReplyTick(options: InboundReplyOptions): InboundReplyHandle {
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let running = false;

  const tickOnce = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const messages = await readInbox(options.inboxFile, options.fetchLimit);
      if (messages.length === 0) {
        return;
      }
      const ackCursorFile = options.ackCursorFile ?? `${options.cursorFile}.acked.json`;
      const alreadyHandled = await readReplyCursor(options.cursorFile);
      const ackAlreadySent = await readAckCursor(ackCursorFile);
      const result = await respondToInbound({
        ackAlreadySent,
        alreadyHandled,
        messages,
        registry: options.registry,
        runner: options.runner
      });
      if (result.handled.length > 0) {
        await appendReplyCursor(options.cursorFile, result.handled);
      }
      if (result.acked.length > 0) {
        await appendAckCursor(ackCursorFile, result.acked);
      }
      if (result.replied > 0 || result.errors.length > 0) {
        options.logger?.(
          `inbound-reply: replied ${result.replied.toString()}/${messages.length.toString()}`
          + (result.errors.length > 0 ? `, ${result.errors.length.toString()} error(s)` : "")
        );
      }
      for (const error of result.errors) {
        options.errorLogger?.(`inbound-reply: ${error}`);
      }
    } catch (cause) {
      options.errorLogger?.(`inbound-reply: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => {
    void tickOnce();
  }, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }

  return {
    stop: () => clearInterval(handle),
    tickOnce
  };
}

function clampInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.trunc(raw)));
}
