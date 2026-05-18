import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessagingProviderRegistry,
  appendInbound,
  type InboundAgentRunner,
  type InboundMessage,
  type MessagingProvider,
  type OutboundMessage
} from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startInboundReplyTick } from "../src/inbound-reply-tick.js";

function message(messageId: string, source: string, text: string): InboundMessage {
  return { messageId, providerId: "telegram", receivedAtIso: "2026-05-18T17:00:00.000Z", source, text };
}

function captureProvider(): { provider: MessagingProvider; sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  const provider = {
    describe: () => ({ configured: true, displayName: "telegram", id: "telegram" }),
    id: "telegram",
    send: async (m: OutboundMessage) => {
      sent.push(m);
      return { destination: m.destination, messageId: "tg-out", providerId: "telegram" };
    }
  } as unknown as MessagingProvider;
  return { provider, sent };
}

describe("startInboundReplyTick", () => {
  it("answers each new inbox message via the agent, replies to its source, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-inbound-reply-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const cursorFile = join(dir, "telegram-inbox.json.reply-cursor.json");
    await appendInbound(inboxFile, message("m1", "chat-1", "what's next?"));
    await appendInbound(inboxFile, message("m2", "chat-2", "remind me at 6"));

    const { provider, sent } = captureProvider();
    const registry = new MessagingProviderRegistry([provider]);
    const runner: InboundAgentRunner = { run: async ({ text }) => `agent: ${text}` };
    const logged: string[] = [];

    const handle = startInboundReplyTick({
      cursorFile,
      inboxFile,
      logger: (m) => logged.push(m),
      registry,
      runner
    });
    try {
      await handle.tickOnce();

      // readInbox delivers newest-first, so m2 is answered before m1.
      expect(sent).toEqual([
        { destination: "chat-2", text: "agent: remind me at 6" },
        { destination: "chat-1", text: "agent: what's next?" }
      ]);
      const cursor = JSON.parse(readFileSync(cursorFile, "utf8")) as { handled: string[] };
      expect(cursor.handled.sort()).toEqual(["telegram:m1", "telegram:m2"]);
      expect(logged).toEqual(["inbound-reply: replied 2/2"]);

      // Second tick: same inbox, cursor now records both → no double-reply.
      await handle.tickOnce();
      expect(sent).toHaveLength(2);
    } finally {
      handle.stop();
    }
  });
});
