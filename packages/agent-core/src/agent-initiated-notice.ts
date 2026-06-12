/**
 * Agent-initiated notice broker — in-process pub/sub primitive for
 * Phase D of the proactive surfacing design
 * (docs/design/phase-d-chat-stream-routing.md).
 *
 * The proactive notice loop already synthesises a one-line response
 * via `modelProvider.generate()` when an imminent calendar/task fires
 * during an active chat session. Today that response only goes to the
 * messaging sink (Telegram / Discord / log). This broker is the
 * integration seam for fanning the same response out to live
 * `/api/chat/stream` subscribers as well, so a user who is mid-chat
 * sees the proactive turn *inline* in the conversation instead of
 * out-of-band in another app.
 *
 * Producer call: `broker.publish(userId, notice)`.
 * Consumer call: `const unsubscribe = broker.subscribe(userId, fn)`.
 *
 * The broker fans out to every subscriber of the given userId. Slow
 * consumers do NOT block the publisher — each delivery is wrapped in
 * try/catch and a synchronous queue cap. Once the per-subscriber
 * backlog exceeds `maxQueuedPerSubscriber`, the OLDEST queued notice
 * is dropped (preserving freshness) and a drop counter increments
 * so operators can audit pressure.
 *
 * Persistence is intentionally not part of v1. Notices fire and are
 * gone; a client that comes online later does not receive them.
 * A future iter can layer a TTL'd backing store under the same
 * interface without changing producers/consumers.
 */

export interface AgentInitiatedNotice {
  /** Source category: "calendar_event_imminent", "task_due_soon", etc. */
  readonly kind: string;
  /** Human-readable text the producer wants delivered to the chat. */
  readonly text: string;
  /** ISO timestamp the producer assigned. */
  readonly generatedAt: string;
  /** Optional opaque source id (event id / task id) for client dedupe. */
  readonly sourceId?: string;
}

export interface AgentInitiatedNoticeBroker {
  publish(userId: string, notice: AgentInitiatedNotice): void;
  subscribe(
    userId: string,
    onMessage: (notice: AgentInitiatedNotice) => void | Promise<void>
  ): () => void;
  /** Diagnostic — how many notices have been dropped due to backpressure. */
  droppedCount(): number;
  /** Diagnostic — active subscriber count for a userId (0 when none). */
  subscriberCount(userId: string): number;
}

export interface InMemoryAgentInitiatedNoticeBrokerOptions {
  /**
   * Per-subscriber queue cap. When a subscriber's pending-notice
   * count exceeds this, the OLDEST pending notice is dropped.
   * Default 16 — slow consumers stay live but old notices age out
   * before the listener gets to them.
   */
  readonly maxQueuedPerSubscriber?: number;
}

/**
 * In-process implementation. Single producer process, single consumer
 * process (the API server). The Phase D broker is intentionally
 * NOT cross-machine — multi-device fan-out needs server-side dedupe
 * and is a separate design.
 */
export class InMemoryAgentInitiatedNoticeBroker implements AgentInitiatedNoticeBroker {
  private readonly subscribers = new Map<string, Set<Subscription>>();
  private readonly maxQueued: number;
  private dropped = 0;

  constructor(options: InMemoryAgentInitiatedNoticeBrokerOptions = {}) {
    this.maxQueued = Math.max(1, options.maxQueuedPerSubscriber ?? 16);
  }

  publish(userId: string, notice: AgentInitiatedNotice): void {
    const subs = this.subscribers.get(userId);
    if (!subs || subs.size === 0) {
      return;
    }
    for (const sub of subs) {
      if (sub.queue.length >= this.maxQueued) {
        sub.queue.shift();
        this.dropped += 1;
      }
      sub.queue.push(notice);
      void this.drain(sub);
    }
  }

  subscribe(
    userId: string,
    onMessage: (notice: AgentInitiatedNotice) => void | Promise<void>
  ): () => void {
    const sub: Subscription = { onMessage, queue: [], draining: false, active: true };
    let bucket = this.subscribers.get(userId);
    if (!bucket) {
      bucket = new Set<Subscription>();
      this.subscribers.set(userId, bucket);
    }
    bucket.add(sub);
    return () => {
      // Mark inactive FIRST: an in-flight drain (awaiting a slow onMessage
      // started before this unsubscribe) must stop delivering queued notices to
      // a now-dead consumer (e.g. a closed SSE stream), not just be hidden from
      // future publishes.
      sub.active = false;
      sub.queue.length = 0;
      const stillThere = this.subscribers.get(userId);
      if (!stillThere) return;
      stillThere.delete(sub);
      if (stillThere.size === 0) {
        this.subscribers.delete(userId);
      }
    };
  }

  droppedCount(): number {
    return this.dropped;
  }

  subscriberCount(userId: string): number {
    return this.subscribers.get(userId)?.size ?? 0;
  }

  private async drain(sub: Subscription): Promise<void> {
    if (sub.draining) {
      return;
    }
    sub.draining = true;
    try {
      while (sub.active && sub.queue.length > 0) {
        const next = sub.queue.shift();
        if (!next) continue;
        try {
          await sub.onMessage(next);
        } catch {
          // Subscriber failure must never block other subscribers
          // or wedge the broker. Swallow + continue.
        }
      }
    } finally {
      sub.draining = false;
    }
  }
}

interface Subscription {
  readonly onMessage: (notice: AgentInitiatedNotice) => void | Promise<void>;
  readonly queue: AgentInitiatedNotice[];
  draining: boolean;
  /** Cleared on unsubscribe so an in-flight drain stops delivering to a dead consumer. */
  active: boolean;
}
