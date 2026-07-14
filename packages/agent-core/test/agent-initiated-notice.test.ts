import { describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import {
  InMemoryAgentInitiatedNoticeBroker,
  type AgentInitiatedNotice
} from "../src/agent-initiated-notice.js";

function notice(text: string, kind = "calendar_event_imminent"): AgentInitiatedNotice {
  return { generatedAt: "2026-05-13T12:00:00Z", kind, text };
}

describe("InMemoryAgentInitiatedNoticeBroker", () => {
  it("delivers a publish to a single subscribed listener", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const received: AgentInitiatedNotice[] = [];
    broker.subscribe("stark", (n) => { received.push(n); });
    broker.publish("stark", notice("meeting in 5 min"));
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("meeting in 5 min");
  });

  it("fans a publish out to every subscriber on the userId", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const a: AgentInitiatedNotice[] = [];
    const b: AgentInitiatedNotice[] = [];
    broker.subscribe("stark", (n) => { a.push(n); });
    broker.subscribe("stark", (n) => { b.push(n); });
    broker.publish("stark", notice("hello"));
    await Promise.resolve();
    await Promise.resolve();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("does not deliver to subscribers of a different userId", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const ours: AgentInitiatedNotice[] = [];
    const theirs: AgentInitiatedNotice[] = [];
    broker.subscribe("stark", (n) => { ours.push(n); });
    broker.subscribe("rhodey", (n) => { theirs.push(n); });
    broker.publish("stark", notice("for stark only"));
    await Promise.resolve();
    expect(ours).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("publish with no subscribers is a silent no-op", () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    expect(() => broker.publish("stark", notice("nobody listening"))).not.toThrow();
    expect(broker.droppedCount()).toBe(0);
  });

  it("unsubscribe stops delivery", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const received: AgentInitiatedNotice[] = [];
    const unsubscribe = broker.subscribe("stark", (n) => { received.push(n); });
    broker.publish("stark", notice("first"));
    await Promise.resolve();
    unsubscribe();
    broker.publish("stark", notice("second"));
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("first");
    expect(broker.subscriberCount("stark")).toBe(0);
  });

  it("counts subscribers per userId", () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    expect(broker.subscriberCount("stark")).toBe(0);
    const u1 = broker.subscribe("stark", () => undefined);
    const u2 = broker.subscribe("stark", () => undefined);
    broker.subscribe("rhodey", () => undefined);
    expect(broker.subscriberCount("stark")).toBe(2);
    expect(broker.subscriberCount("rhodey")).toBe(1);
    u1();
    u2();
    expect(broker.subscriberCount("stark")).toBe(0);
  });

  it("a slow consumer's exception does not block other subscribers or future deliveries", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const fastReceived: AgentInitiatedNotice[] = [];
    broker.subscribe("stark", () => { throw new Error("boom"); });
    broker.subscribe("stark", (n) => { fastReceived.push(n); });
    broker.publish("stark", notice("one"));
    broker.publish("stark", notice("two"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fastReceived.map((n) => n.text)).toEqual(["one", "two"]);
  });

  it("drops the oldest queued notice and increments droppedCount when a slow subscriber's queue fills", async () => {
    // A subscriber whose onMessage never resolves blocks its own
    // queue. After we publish more than maxQueuedPerSubscriber
    // notices, the oldest pending notice is evicted.
    const broker = new InMemoryAgentInitiatedNoticeBroker({ maxQueuedPerSubscriber: 2 });
    const delivered: string[] = [];
    const blocked = Promise.withResolvers<void>();
    const blockedPromise = blocked.promise;
    broker.subscribe("stark", async (n) => {
      delivered.push(n.text);
      // First delivery enters this await and pins the drain loop;
      // subsequent publishes pile into the per-subscriber queue.
      if (n.text === "first") await blockedPromise;
    });
    broker.publish("stark", notice("first"));
    await Promise.resolve();
    expect(delivered).toEqual(["first"]); // drain started, awaiting
    broker.publish("stark", notice("second"));
    broker.publish("stark", notice("third"));
    broker.publish("stark", notice("fourth")); // exceeds cap of 2, evicts "second"
    expect(broker.droppedCount()).toBe(1);
    blocked.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // "second" was the oldest queued and got dropped; third + fourth survive.
    expect(delivered).toEqual(["first", "third", "fourth"]);
  });

  it("unsubscribe mid-drain stops delivery of already-queued notices to a dead consumer", async () => {
    // The consumer blocks on its FIRST delivery; while it's pinned, more notices
    // queue. Unsubscribing (e.g. a closed SSE stream) must stop the in-flight
    // drain from delivering the rest to a consumer that's gone.
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const delivered: string[] = [];
    const gate = Promise.withResolvers<void>();
    const unsubscribe = broker.subscribe("stark", async (n) => {
      delivered.push(n.text);
      if (n.text === "first") await gate.promise;
    });
    broker.publish("stark", notice("first"));
    await Promise.resolve();
    expect(delivered).toEqual(["first"]); // in-flight, awaiting the gate
    broker.publish("stark", notice("second"));
    broker.publish("stark", notice("third"));
    unsubscribe(); // consumer goes away mid-drain
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toEqual(["first"]); // second/third NOT delivered after unsubscribe
  });

  it("awaits async onMessage callbacks in order", async () => {
    const broker = new InMemoryAgentInitiatedNoticeBroker();
    const order: string[] = [];
    broker.subscribe("stark", async (n) => {
      order.push(`start-${n.text}`);
      await sleep(5);
      order.push(`end-${n.text}`);
    });
    broker.publish("stark", notice("a"));
    broker.publish("stark", notice("b"));
    // Allow both async deliveries to complete.
    await vi.waitFor(() => expect(order).toHaveLength(4), { timeout: 200 });
    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });
});
