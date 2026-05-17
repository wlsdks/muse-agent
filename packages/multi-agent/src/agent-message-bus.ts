import type { JsonObject } from "@muse/shared";

/**
 * Cross-agent communication primitive for `MultiAgentOrchestrator` and
 * `SupervisorAgent`.
 *
 * The bus is scoped to a single orchestration run. Agent A publishes its
 * result as an `AgentMessage`; agent B can subscribe (receive a callback when
 * matching messages are published) or pull (`getMessages(agentId)` /
 * `getConversation()`).
 *
 * Messages with `targetAgentId === undefined` are broadcast — every agent is
 * a recipient.
 *
 * Reactor parity reference:
 * `/modules/agent/src/main/kotlin/com/reactor/multiagent/AgentMessageBus.kt`.
 */

export interface AgentMessage {
  readonly sourceAgentId: string;
  readonly targetAgentId?: string;
  readonly content: string;
  readonly metadata?: JsonObject;
  readonly timestamp: Date;
}

export type AgentMessageHandler = (message: AgentMessage) => void | Promise<void>;

export interface AgentMessageBus {
  publish(message: AgentMessage): Promise<void>;
  subscribe(agentId: string, handler: AgentMessageHandler): void;
  getMessages(agentId: string): readonly AgentMessage[];
  getConversation(): readonly AgentMessage[];
  clear(): void;
}

export interface InMemoryAgentMessageBusOptions {
  /**
   * Maximum number of distinct subscriber keys to retain. When exceeded,
   * the oldest subscriber bucket is evicted (FIFO via insertion order).
   * Defaults to 1000 — matches Reactor's Caffeine W-TinyLFU bound.
   */
  readonly maxSubscribers?: number;
}

/**
 * Default in-memory bus. Single-process only; not durable across restarts.
 *
 * Subscriber buckets are bounded so a long-running supervisor cannot leak
 * memory on agent IDs that subscribe but never unsubscribe. `allMessages` is
 * unbounded by design — it represents the conversation log for the run, and
 * the run is expected to call `clear()` (or be replaced) at supervisor exit.
 */
export class InMemoryAgentMessageBus implements AgentMessageBus {
  private readonly allMessages: AgentMessage[] = [];
  private readonly subscribers = new Map<string, AgentMessageHandler[]>();
  private readonly maxSubscribers: number;

  constructor(options: InMemoryAgentMessageBusOptions = {}) {
    const limit = options.maxSubscribers ?? 1000;

    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("maxSubscribers must be a positive integer");
    }

    this.maxSubscribers = limit;
  }

  async publish(message: AgentMessage): Promise<void> {
    this.allMessages.push(message);
    await this.notifySubscribers(message);
  }

  subscribe(agentId: string, handler: AgentMessageHandler): void {
    let bucket = this.subscribers.get(agentId);

    if (!bucket) {
      this.evictIfFull();
      bucket = [];
      this.subscribers.set(agentId, bucket);
    }

    bucket.push(handler);
  }

  getMessages(agentId: string): readonly AgentMessage[] {
    return this.allMessages.filter(
      (message) => message.targetAgentId === agentId || message.targetAgentId === undefined
    );
  }

  getConversation(): readonly AgentMessage[] {
    return [...this.allMessages];
  }

  clear(): void {
    this.allMessages.length = 0;
    this.subscribers.clear();
  }

  private async notifySubscribers(message: AgentMessage): Promise<void> {
    if (message.targetAgentId !== undefined) {
      const bucket = this.subscribers.get(message.targetAgentId);

      if (bucket) {
        await Promise.all(bucket.map((handler) => this.deliver(handler, message)));
      }

      return;
    }

    const handlers: AgentMessageHandler[] = [];

    for (const bucket of this.subscribers.values()) {
      handlers.push(...bucket);
    }

    await Promise.all(handlers.map((handler) => this.deliver(handler, message)));
  }

  // Fail-open fan-out: a subscriber that throws (sync or async) must
  // not break delivery to the other subscribers or reject publish().
  // The bus is shared infra — one misbehaving agent handler cannot be
  // allowed to silently drop messages to every other agent.
  private async deliver(handler: AgentMessageHandler, message: AgentMessage): Promise<void> {
    try {
      await handler(message);
    } catch {
      // intentionally swallowed — best-effort delivery
    }
  }

  private evictIfFull(): void {
    if (this.subscribers.size < this.maxSubscribers) {
      return;
    }

    const oldestKey = this.subscribers.keys().next().value;

    if (oldestKey !== undefined) {
      this.subscribers.delete(oldestKey);
    }
  }
}
