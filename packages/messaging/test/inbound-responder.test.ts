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
});
