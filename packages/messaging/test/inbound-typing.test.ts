import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { respondToInbound } from "../src/inbound-responder.js";
import { MessagingProviderRegistry } from "../src/registry.js";

import type { InboundMessage, MessagingProvider } from "../src/types.js";

function message(id: string, text: string): InboundMessage {
  return { messageId: id, providerId: "typingful", receivedAtIso: "2026-07-11T00:00:00.000Z", source: "42", text };
}

describe("respondToInbound typing indicator", () => {
  it("sends a typing action BEFORE the agent runs, then delivers the reply", async () => {
    const events: string[] = [];
    const provider: MessagingProvider = {
      describe: () => ({ description: "stub", displayName: "T", id: "typingful" }),
      id: "typingful",
      send: async () => {
        events.push("send");
        return { destination: "42", messageId: "m", providerId: "typingful" };
      },
      sendTyping: async (destination) => {
        events.push(`typing:${destination}`);
      }
    };
    const result = await respondToInbound({
      messages: [message("1", "hello")],
      registry: new MessagingProviderRegistry([provider]),
      runner: {
        run: async () => {
          events.push("run");
          return "hi there";
        }
      }
    });

    expect(result.replied).toBe(1);
    expect(events).toEqual(["typing:42", "run", "send"]);
  });

  it("a typing failure is cosmetic — the reply still goes out", async () => {
    const events: string[] = [];
    const provider: MessagingProvider = {
      describe: () => ({ description: "stub", displayName: "T", id: "typingful" }),
      id: "typingful",
      send: async () => {
        events.push("send");
        return { destination: "42", messageId: "m", providerId: "typingful" };
      },
      sendTyping: async () => {
        throw new Error("typing exploded");
      }
    };
    const result = await respondToInbound({
      messages: [message("1", "hello")],
      registry: new MessagingProviderRegistry([provider]),
      runner: { run: async () => "hi" }
    });

    expect(result.replied).toBe(1);
    expect(result.errors).toEqual([]);
    expect(events).toEqual(["send"]);
  });

  it("a provider without sendTyping just replies (no crash)", async () => {
    const provider: MessagingProvider = {
      describe: () => ({ description: "stub", displayName: "T", id: "typingful" }),
      id: "typingful",
      send: async () => ({ destination: "42", messageId: "m", providerId: "typingful" })
    };
    const result = await respondToInbound({
      messages: [message("1", "hello")],
      registry: new MessagingProviderRegistry([provider]),
      runner: { run: async () => "hi" }
    });
    expect(result.replied).toBe(1);
  });
});

describe("respondToInbound typing keepalive", () => {
  it("re-fires typing while a slow agent thinks, so the indicator never dies", async () => {
    let typingCount = 0;
    const provider: MessagingProvider = {
      describe: () => ({ description: "stub", displayName: "T", id: "typingful" }),
      id: "typingful",
      send: async () => ({ destination: "42", messageId: "m", providerId: "typingful" }),
      sendTyping: async () => {
        typingCount += 1;
      }
    };
    const result = await respondToInbound({
      messages: [message("1", "hello")],
      registry: new MessagingProviderRegistry([provider]),
      runner: {
        run: async () => {
          await sleep(80);
          return "slow answer";
        }
      },
      typingIntervalMs: 20
    });

    expect(result.replied).toBe(1);
    expect(typingCount).toBeGreaterThanOrEqual(3);
  });

  it("stops re-firing once the reply is delivered", async () => {
    let typingCount = 0;
    const provider: MessagingProvider = {
      describe: () => ({ description: "stub", displayName: "T", id: "typingful" }),
      id: "typingful",
      send: async () => ({ destination: "42", messageId: "m", providerId: "typingful" }),
      sendTyping: async () => {
        typingCount += 1;
      }
    };
    await respondToInbound({
      messages: [message("1", "hello")],
      registry: new MessagingProviderRegistry([provider]),
      runner: { run: async () => "fast" },
      typingIntervalMs: 10
    });
    const after = typingCount;
    await sleep(60);
    expect(typingCount).toBe(after);
  });
});
