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
  /** Maximum retained messages for one orchestration run. Defaults to 10,000. */
  readonly maxMessages?: number;
  /** Maximum retained handlers for one agent id. Defaults to 100. */
  readonly maxHandlersPerSubscriber?: number;
}

/**
 * Default in-memory bus. Single-process only; not durable across restarts.
 *
 * Subscriber keys, handlers within each key, and the conversation tail are
 * bounded so a long-running supervisor cannot leak memory when lifecycle
 * cleanup is delayed. Retention is FIFO; delivery remains live for every
 * published message even after older history is evicted.
 */
export class InMemoryAgentMessageBus implements AgentMessageBus {
  private readonly allMessages: AgentMessage[] = [];
  private readonly subscribers = new Map<string, AgentMessageHandler[]>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private deliveryGeneration = 0;
  private readonly maxSubscribers: number;
  private readonly maxMessages: number;
  private readonly maxHandlersPerSubscriber: number;

  constructor(options: InMemoryAgentMessageBusOptions = {}) {
    this.maxSubscribers = requirePositiveSafeInteger(options.maxSubscribers, 1000, "maxSubscribers");
    this.maxMessages = requirePositiveSafeInteger(options.maxMessages, 10_000, "maxMessages");
    this.maxHandlersPerSubscriber = requirePositiveSafeInteger(options.maxHandlersPerSubscriber, 100, "maxHandlersPerSubscriber");
  }

  async publish(message: AgentMessage): Promise<void> {
    this.allMessages.push(message);
    if (this.allMessages.length > this.maxMessages) {
      this.allMessages.splice(0, this.allMessages.length - this.maxMessages);
    }
    const generation = this.deliveryGeneration;
    const delivery = this.deliveryTail.then(async () => {
      if (generation === this.deliveryGeneration) {
        await this.notifySubscribers(message);
      }
    });
    // Keep later publishes live even if a future implementation adds a
    // failing bus-level operation; subscriber failures already fail open.
    this.deliveryTail = delivery.catch(() => {});
    await delivery;
  }

  subscribe(agentId: string, handler: AgentMessageHandler): void {
    let bucket = this.subscribers.get(agentId);

    if (!bucket) {
      this.evictIfFull();
      bucket = [];
      this.subscribers.set(agentId, bucket);
    }

    if (bucket.length >= this.maxHandlersPerSubscriber) {
      bucket.shift();
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
    this.deliveryGeneration += 1;
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

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}
