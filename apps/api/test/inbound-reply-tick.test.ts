import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessagingProviderRegistry,
  TelegramProvider,
  appendInbound,
  type InboundAgentRunner,
  type InboundMessage,
  type MessagingProvider,
  type OutboundMessage
} from "@muse/messaging";
import { describe, expect, it } from "vitest";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

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

  it("delivers the agent reply over a real provider's HTTP send — contract-faithful, not a fake registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-inbound-reply-http-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const cursorFile = join(dir, "telegram-inbox.json.reply-cursor.json");
    await appendInbound(inboxFile, message("h1", "555", "summarize my day"));

    let postUrl = "";
    let postBody = "";
    // Real TelegramProvider — it builds the real Bot API request;
    // only the HTTP boundary is faked, so the outbound POST
    // (URL + chat_id + text) is asserted exactly as the channel
    // would receive it. NOT a fake registry/provider.
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        postUrl = String(url);
        postBody = String(init?.body);
        return fakeJsonResponse({ ok: true, result: { message_id: 7 } });
      },
      token: "BOT-TOK"
    });
    const registry = new MessagingProviderRegistry([telegram]);
    const runner: InboundAgentRunner = { run: async ({ text }) => `done: ${text}` };

    const handle = startInboundReplyTick({ cursorFile, inboxFile, registry, runner });
    try {
      await handle.tickOnce();

      expect(postUrl).toBe("https://tg.test/botBOT-TOK/sendMessage");
      const body = JSON.parse(postBody) as { chat_id: string; text: string };
      expect(body.chat_id).toBe("555");
      expect(body.text).toContain("done: summarize my day");
    } finally {
      handle.stop();
    }
  });
});
