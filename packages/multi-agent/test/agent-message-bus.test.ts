import { describe, expect, it } from "vitest";

import {
  InMemoryAgentMessageBus,
  MultiAgentOrchestrator,
  RuleBasedAgentWorker,
  createWorkerResult,
  type AgentMessage
} from "../src/index.js";

describe("InMemoryAgentMessageBus", () => {
  it("delivers a targeted message only to subscribers of that agent id", async () => {
    const bus = new InMemoryAgentMessageBus();
    const targetReceived: AgentMessage[] = [];
    const otherReceived: AgentMessage[] = [];

    bus.subscribe("target", (message) => {
      targetReceived.push(message);
    });
    bus.subscribe("other", (message) => {
      otherReceived.push(message);
    });

    await bus.publish({
      content: "hello",
      sourceAgentId: "research",
      targetAgentId: "target",
      timestamp: new Date()
    });

    expect(targetReceived).toHaveLength(1);
    expect(targetReceived[0]?.content).toBe("hello");
    expect(otherReceived).toHaveLength(0);
  });

  it("isolates a throwing subscriber — others still receive, publish() resolves", async () => {
    const bus = new InMemoryAgentMessageBus();
    let bSeen = 0;
    let aLateSeen = 0;

    // Registered FIRST and throws synchronously — pre-fix this broke
    // the `.map` before Promise.all and dropped every later handler.
    bus.subscribe("a", () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe("a", () => {
      aLateSeen += 1; // same-bucket sibling, registered after the thrower
    });
    bus.subscribe("b", async () => {
      await Promise.resolve();
      throw new Error("bad async subscriber");
    });
    bus.subscribe("b", () => {
      bSeen += 1;
    });

    await expect(
      bus.publish({ content: "broadcast", sourceAgentId: "supervisor", timestamp: new Date() })
    ).resolves.toBeUndefined();
    expect(aLateSeen).toBe(1);
    expect(bSeen).toBe(1);

    // Targeted delivery into a bucket whose first handler throws.
    await expect(
      bus.publish({ content: "for-a", sourceAgentId: "x", targetAgentId: "a", timestamp: new Date() })
    ).resolves.toBeUndefined();
    expect(aLateSeen).toBe(2);
  });

  it("broadcast messages reach every subscriber", async () => {
    const bus = new InMemoryAgentMessageBus();
    let aSeen = 0;
    let bSeen = 0;

    bus.subscribe("a", () => {
      aSeen += 1;
    });
    bus.subscribe("b", () => {
      bSeen += 1;
    });

    await bus.publish({
      content: "broadcast",
      sourceAgentId: "supervisor",
      timestamp: new Date()
    });

    expect(aSeen).toBe(1);
    expect(bSeen).toBe(1);
  });

  it("getMessages filters by target id and includes broadcasts", async () => {
    const bus = new InMemoryAgentMessageBus();

    await bus.publish({ content: "for-a", sourceAgentId: "x", targetAgentId: "a", timestamp: new Date() });
    await bus.publish({ content: "for-b", sourceAgentId: "x", targetAgentId: "b", timestamp: new Date() });
    await bus.publish({ content: "all", sourceAgentId: "x", timestamp: new Date() });

    const aMessages = bus.getMessages("a").map((message) => message.content);
    expect(aMessages).toEqual(["for-a", "all"]);

    const bMessages = bus.getMessages("b").map((message) => message.content);
    expect(bMessages).toEqual(["for-b", "all"]);
  });

  it("getConversation returns every message in publish order", async () => {
    const bus = new InMemoryAgentMessageBus();

    await bus.publish({ content: "1", sourceAgentId: "x", timestamp: new Date() });
    await bus.publish({ content: "2", sourceAgentId: "y", targetAgentId: "z", timestamp: new Date() });
    await bus.publish({ content: "3", sourceAgentId: "z", timestamp: new Date() });

    expect(bus.getConversation().map((message) => message.content)).toEqual(["1", "2", "3"]);
  });

  it("isolates messages from publisher, subscriber, and query-result mutation", async () => {
    const bus = new InMemoryAgentMessageBus();
    const timestamp = new Date("2026-07-16T00:00:00.000Z");
    const metadata = { nested: { value: "original" } };
    const receivedBySecondSubscriber: AgentMessage[] = [];

    bus.subscribe("agent", (message) => {
      (message.timestamp as Date).setUTCFullYear(2000);
      ((message.metadata as { nested: { value: string } }).nested.value) = "first-subscriber";
    });
    bus.subscribe("agent", (message) => {
      receivedBySecondSubscriber.push(message);
    });

    await bus.publish({ content: "message", metadata, sourceAgentId: "source", targetAgentId: "agent", timestamp });
    timestamp.setUTCFullYear(1999);
    metadata.nested.value = "publisher";

    expect(receivedBySecondSubscriber).toMatchObject([
      {
        content: "message",
        metadata: { nested: { value: "original" } },
        timestamp: new Date("2026-07-16T00:00:00.000Z")
      }
    ]);

    const queried = bus.getConversation()[0]!;
    (queried.timestamp as Date).setUTCFullYear(1988);
    ((queried.metadata as { nested: { value: string } }).nested.value) = "query";

    expect(bus.getConversation()).toMatchObject([
      {
        content: "message",
        metadata: { nested: { value: "original" } },
        timestamp: new Date("2026-07-16T00:00:00.000Z")
      }
    ]);
  });

  it("delivers concurrent publishes to a subscriber in publish order", async () => {
    const bus = new InMemoryAgentMessageBus();
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHandlerStarted = new Promise<void>((resolve) => {
      bus.subscribe("agent", async (message) => {
        if (message.content === "first") {
          resolve();
          await new Promise<void>((release) => { releaseFirst = release; });
        }
        seen.push(message.content);
      });
    });

    const first = bus.publish({ content: "first", sourceAgentId: "x", targetAgentId: "agent", timestamp: new Date() });
    await firstHandlerStarted;
    const second = bus.publish({ content: "second", sourceAgentId: "x", targetAgentId: "agent", timestamp: new Date() });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(seen).toEqual(["first", "second"]);
  });

  it("clear() empties messages and subscribers", async () => {
    const bus = new InMemoryAgentMessageBus();
    let calls = 0;

    bus.subscribe("a", () => {
      calls += 1;
    });
    await bus.publish({ content: "before", sourceAgentId: "x", targetAgentId: "a", timestamp: new Date() });

    bus.clear();
    await bus.publish({ content: "after", sourceAgentId: "x", targetAgentId: "a", timestamp: new Date() });

    expect(bus.getConversation()).toEqual([
      { content: "after", sourceAgentId: "x", targetAgentId: "a", timestamp: expect.any(Date) }
    ]);
    expect(calls).toBe(1);
  });

  it("evicts the oldest subscriber bucket when maxSubscribers is exceeded", async () => {
    const bus = new InMemoryAgentMessageBus({ maxSubscribers: 2 });
    const seen: string[] = [];

    bus.subscribe("first", () => {
      seen.push("first");
    });
    bus.subscribe("second", () => {
      seen.push("second");
    });
    bus.subscribe("third", () => {
      seen.push("third");
    });

    await bus.publish({ content: "go", sourceAgentId: "x", timestamp: new Date() });

    expect(seen).toEqual(["second", "third"]);
  });

  it("retains only the newest bounded conversation tail", async () => {
    const bus = new InMemoryAgentMessageBus({ maxMessages: 2 });
    await bus.publish({ content: "first", sourceAgentId: "x", timestamp: new Date() });
    await bus.publish({ content: "second", sourceAgentId: "x", timestamp: new Date() });
    await bus.publish({ content: "third", sourceAgentId: "x", timestamp: new Date() });
    expect(bus.getConversation().map((message) => message.content)).toEqual(["second", "third"]);
  });

  it("evicts the oldest handler within an over-subscribed agent bucket", async () => {
    const bus = new InMemoryAgentMessageBus({ maxHandlersPerSubscriber: 2 });
    const seen: string[] = [];
    bus.subscribe("agent", () => { seen.push("first"); });
    bus.subscribe("agent", () => { seen.push("second"); });
    bus.subscribe("agent", () => { seen.push("third"); });
    await bus.publish({ content: "go", sourceAgentId: "x", targetAgentId: "agent", timestamp: new Date() });
    expect(seen).toEqual(["second", "third"]);
  });

  it("rejects non-positive maxSubscribers", () => {
    expect(() => new InMemoryAgentMessageBus({ maxSubscribers: 0 })).toThrow(RangeError);
    expect(() => new InMemoryAgentMessageBus({ maxSubscribers: -5 })).toThrow(RangeError);
    expect(() => new InMemoryAgentMessageBus({ maxMessages: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new InMemoryAgentMessageBus({ maxHandlersPerSubscriber: 0 })).toThrow(RangeError);
  });
});

describe("MultiAgentOrchestrator with messageBus", () => {
  it("publishes a message per completed worker in sequential mode", async () => {
    const bus = new InMemoryAgentMessageBus();
    const research = new RuleBasedAgentWorker("research", "Research", ["task"], (input) =>
      createWorkerResult("research", "researched", input)
    );
    const code = new RuleBasedAgentWorker("code", "Code", ["task"], (input) =>
      createWorkerResult("code", "coded", input)
    );
    const orchestrator = new MultiAgentOrchestrator({
      messageBus: bus,
      workers: [research, code]
    });

    await orchestrator.run({
      messages: [{ content: "task", role: "user" }],
      model: "model-1"
    });

    const conversation = bus.getConversation();
    expect(conversation.map((message) => ({ source: message.sourceAgentId, content: message.content }))).toEqual([
      { source: "research", content: "researched" },
      { source: "code", content: "coded" }
    ]);
  });

  it("publishes a failure message when a worker throws", async () => {
    const bus = new InMemoryAgentMessageBus();
    const failing = new RuleBasedAgentWorker("primary", "Primary", ["task"], () => {
      throw new Error("boom");
    });
    const fallback = new RuleBasedAgentWorker("fallback", "Fallback", ["task"], (input) =>
      createWorkerResult("fallback", "ok", input)
    );
    const orchestrator = new MultiAgentOrchestrator({
      messageBus: bus,
      workers: [failing, fallback]
    });

    await orchestrator.run({
      messages: [{ content: "task", role: "user" }],
      model: "model-1"
    });

    const messages = bus.getConversation();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.metadata).toMatchObject({ status: "failed" });
    expect(messages[0]?.content).toBe("boom");
    expect(messages[1]?.sourceAgentId).toBe("fallback");
  });

  it("does not publish when no message bus is provided", async () => {
    const orchestrator = new MultiAgentOrchestrator({
      workers: [
        new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) => createWorkerResult("alpha", "a", input))
      ]
    });

    const result = await orchestrator.run({
      messages: [{ content: "task", role: "user" }],
      model: "model-1"
    });

    expect(result.results).toHaveLength(1);
  });
});
