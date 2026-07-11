import { describe, expect, it } from "vitest";

import {
  MessagingProviderRegistry,
  inboundKey,
  respondToInbound,
  type InboundAgentRunner
} from "../src/index.js";
import type { InboundMessage, MessagingProvider, OutboundMessage } from "../src/types.js";

function makeProvider(id: string): { provider: MessagingProvider; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  const provider: MessagingProvider = {
    id: id as MessagingProvider["id"],
    describe: () => ({ id: id as MessagingProvider["id"], displayName: id, configured: true }),
    send: async (message) => {
      sent.push(message);
      return { destination: message.destination, messageId: `${id}-out`, providerId: id as MessagingProvider["id"] };
    }
  };
  return { provider, sent };
}

function inbound(over: Partial<InboundMessage> & Pick<InboundMessage, "messageId" | "text">): InboundMessage {
  return {
    providerId: "telegram",
    receivedAtIso: "2026-05-18T16:00:00.000Z",
    source: "chat-1",
    ...over
  } as InboundMessage;
}

describe("respondToInbound", () => {
  it("runs the agent per inbound message and replies to its source channel", async () => {
    const { provider, sent } = makeProvider("telegram");
    const registry = new MessagingProviderRegistry([provider]);
    const seenByAgent: string[] = [];
    const runner: InboundAgentRunner = {
      run: async ({ text, source, providerId }) => {
        seenByAgent.push(`${providerId}:${source}:${text}`);
        return `echo: ${text}`;
      }
    };

    const result = await respondToInbound({
      messages: [
        inbound({ messageId: "m1", text: "what's on my calendar?" }),
        inbound({ messageId: "m2", source: "chat-9", text: "remind me at 5pm" })
      ],
      registry,
      runner
    });

    expect(seenByAgent).toEqual([
      "telegram:chat-1:what's on my calendar?",
      "telegram:chat-9:remind me at 5pm"
    ]);
    expect(sent).toEqual([
      { destination: "chat-1", text: "echo: what's on my calendar?" },
      { destination: "chat-9", text: "echo: remind me at 5pm" }
    ]);
    expect(result.replied).toBe(2);
    expect(result.handled).toEqual(["telegram:m1", "telegram:m2"]);
    expect(result.errors).toEqual([]);
  });

  it("skips messages already handled and an empty agent reply", async () => {
    const { provider, sent } = makeProvider("telegram");
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = {
      run: async ({ text }) => (text === "blank" ? "   " : `r:${text}`)
    };

    const result = await respondToInbound({
      alreadyHandled: new Set([inboundKey({ messageId: "old", providerId: "telegram" })]),
      messages: [
        inbound({ messageId: "old", text: "stale" }),
        inbound({ messageId: "blank", text: "blank" }),
        inbound({ messageId: "new", text: "hello" })
      ],
      registry,
      runner
    });

    // "old" skipped entirely; "blank" handled but not sent; "new" replied.
    expect(sent).toEqual([{ destination: "chat-1", text: "r:hello" }]);
    expect(result.replied).toBe(1);
    expect(result.handled).toEqual(["telegram:blank", "telegram:new"]);
  });

  it("collects a per-message agent failure without dropping siblings or marking it handled", async () => {
    const { provider, sent } = makeProvider("telegram");
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = {
      run: async ({ text }) => {
        if (text === "boom") {
          throw new Error("agent timeout");
        }
        return `ok:${text}`;
      }
    };

    const result = await respondToInbound({
      messages: [
        inbound({ messageId: "bad", text: "boom" }),
        inbound({ messageId: "good", text: "fine" })
      ],
      registry,
      runner
    });

    expect(sent).toEqual([{ destination: "chat-1", text: "ok:fine" }]);
    expect(result.handled).toEqual(["telegram:good"]);
    expect(result.errors).toEqual(["telegram:bad: agent timeout"]);
  });

  it("a transient send failure is NOT marked handled (retried next pass), siblings unaffected", async () => {
    const sent: OutboundMessage[] = [];
    const provider: MessagingProvider = {
      describe: () => ({ configured: true, displayName: "telegram", id: "telegram" as MessagingProvider["id"] }),
      id: "telegram" as MessagingProvider["id"],
      send: async (message) => {
        if (message.destination === "flaky") {
          throw new Error("429 Too Many Requests");
        }
        sent.push(message);
        return {
          destination: message.destination,
          messageId: "telegram-out",
          providerId: "telegram" as MessagingProvider["id"]
        };
      }
    };
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = { run: async ({ text }) => `ok:${text}` };

    const result = await respondToInbound({
      messages: [
        inbound({ messageId: "drop", source: "flaky", text: "important question" }),
        inbound({ messageId: "ok", source: "chat-1", text: "fine" })
      ],
      registry,
      runner
    });

    // Sibling still replied; the failed-send message is NOT handled,
    // so the caller retries it next pass instead of losing the
    // computed answer forever.
    expect(sent).toEqual([{ destination: "chat-1", text: "ok:fine" }]);
    expect(result.replied).toBe(1);
    expect(result.handled).toEqual(["telegram:ok"]);
    expect(result.errors).toEqual(["telegram:drop: 429 Too Many Requests"]);
  });

  it("wires a notify seam a runner can use to send an ack toward the same destination before the final reply", async () => {
    const { provider, sent } = makeProvider("telegram");
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = {
      run: async ({ text, notify }) => {
        await notify?.("on it — I'll let you know");
        return `final: ${text}`;
      }
    };

    const result = await respondToInbound({
      messages: [inbound({ messageId: "m1", text: "book a flight" })],
      registry,
      runner
    });

    expect(sent).toEqual([
      { destination: "chat-1", text: "on it — I'll let you know" },
      { destination: "chat-1", text: "final: book a flight" }
    ]);
    expect(result.replied).toBe(1);
    expect(result.handled).toEqual(["telegram:m1"]);
    expect(result.errors).toEqual([]);
  });

  it("swallows a notify send failure — the final answer still delivers and the message is still marked handled", async () => {
    const sent: OutboundMessage[] = [];
    const provider: MessagingProvider = {
      describe: () => ({ configured: true, displayName: "telegram", id: "telegram" as MessagingProvider["id"] }),
      id: "telegram" as MessagingProvider["id"],
      send: async (message) => {
        if (message.text.startsWith("ack:")) {
          throw new Error("rate limited");
        }
        sent.push(message);
        return { destination: message.destination, messageId: "telegram-out", providerId: "telegram" as MessagingProvider["id"] };
      }
    };
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = {
      run: async ({ text, notify }) => {
        await notify?.("ack: on it");
        return `final: ${text}`;
      }
    };

    const result = await respondToInbound({
      messages: [inbound({ messageId: "m1", text: "book a flight" })],
      registry,
      runner
    });

    expect(sent).toEqual([{ destination: "chat-1", text: "final: book a flight" }]);
    expect(result.replied).toBe(1);
    expect(result.handled).toEqual(["telegram:m1"]);
    expect(result.errors).toEqual([]);
  });
});
