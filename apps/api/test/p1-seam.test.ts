import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MessagingProviderRegistry,
  TelegramProvider,
  appendInbound,
  createChannelApprovalGate,
  createThreadedInboundRunner,
  type InboundMessage
} from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startInboundReplyTick } from "../src/inbound-reply-tick.js";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function inbound(messageId: string, source: string, text: string): InboundMessage {
  return { messageId, providerId: "telegram", receivedAtIso: "2026-05-18T19:00:00.000Z", source, text };
}

/**
 * P1 target-completion seam audit: wires the pieces exactly as
 * `server.ts` does — tick → respondToInbound → threaded runner →
 * (agent + channel approval gate) → real TelegramProvider HTTP +
 * cursor + thread persistence — and proves the whole user flow
 * works, not just each piece in isolation.
 */
describe("P1 seam — two-way channel conversation composes end-to-end", () => {
  it("ingests → replies over real HTTP → carries thread context → gates a risky tool in-chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-p1-seam-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const cursorFile = join(dir, "telegram-inbox.json.reply-cursor.json");
    const threadFile = join(dir, "telegram-inbox.json.threads.json");

    const posts: Array<{ url: string; body: { chat_id: string; text?: string; action?: string } }> = [];
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (u, init) => {
        posts.push({
          body: JSON.parse(String(init?.body)) as { chat_id: string; text?: string; action?: string },
          url: String(u)
        });
        return fakeJsonResponse({ ok: true, result: { message_id: posts.length } });
      },
      token: "BOT-T"
    });
    const registry = new MessagingProviderRegistry([telegram]);

    const agentSaw: { role: string; content: string }[][] = [];
    // Mirrors server.ts: threaded runner whose run() carries the
    // per-channel history and a per-message channel approval gate.
    const runner = createThreadedInboundRunner({
      run: async ({ messages, providerId, source }) => {
        agentSaw.push(messages.map((m) => ({ content: m.content, role: m.role })));
        const last = messages[messages.length - 1]?.content ?? "";
        if (/delete|cancel|remove/iu.test(last)) {
          const gate = createChannelApprovalGate({ providerId, registry, source });
          const decision = await gate({
            risk: "execute",
            runId: "seam",
            toolCall: { name: "tasks.delete" }
          });
          return decision.allowed ? "Deleted." : `Blocked: ${decision.reason ?? "denied"}`;
        }
        return last.includes("name is Sam") ? "Noted, Sam." : "ok";
      },
      threadFile
    });
    const handle = startInboundReplyTick({ cursorFile, inboxFile, registry, runner });

    try {
      // Turn 1: a benign message.
      await appendInbound(inboxFile, inbound("m1", "555", "remember my name is Sam"));
      await handle.tickOnce();

      // Turn 2: a risky request on the SAME channel.
      await appendInbound(inboxFile, inbound("m2", "555", "delete all my tasks"));
      await handle.tickOnce();

      // Every POST hits one of exactly two known Telegram endpoints —
      // sendChatAction (typing keepalives, interleaved on a timer) and
      // sendMessage (the actual reply content). Any other endpoint here
      // would be an unexpected wiring change.
      const endpoints = new Set(posts.map((p) => p.url.replace(/^https:\/\/tg\.test\/botBOT-T\//u, "")));
      expect(endpoints).toEqual(new Set(["sendChatAction", "sendMessage"]));

      // 3 outbound sendMessage POSTs, all to chat 555 over the real
      // provider HTTP: (1) the turn-1 reply, (2) the in-chat approval
      // prompt for the risky tool, (3) the turn-2 reply (blocked pending
      // approval). Typing keepalives (sendChatAction) interleave on a
      // timer, so they are asserted by presence, not position.
      const messages = posts.filter((p) => p.url.endsWith("/sendMessage"));
      expect(messages.map((p) => p.url)).toEqual([
        "https://tg.test/botBOT-T/sendMessage",
        "https://tg.test/botBOT-T/sendMessage",
        "https://tg.test/botBOT-T/sendMessage"
      ]);
      expect(posts.some((p) => p.url.endsWith("/sendChatAction"))).toBe(true);
      expect(posts.every((p) => p.body.chat_id === "555")).toBe(true);
      expect(messages[0]?.body.text).toContain("Noted, Sam.");
      expect(messages[1]?.body.text).toContain("NOT executed");
      expect(messages[1]?.body.text).toContain("tasks.delete");
      expect(messages[2]?.body.text).toContain("Blocked");

      // m1 answered once (cursor); m2's agent turn carried the
      // turn-1 user msg + Muse reply (thread continuity).
      expect(agentSaw).toHaveLength(2);
      expect(agentSaw[0]).toEqual([{ content: "remember my name is Sam", role: "user" }]);
      expect(agentSaw[1]).toEqual([
        { content: "remember my name is Sam", role: "user" },
        { content: "Noted, Sam.", role: "assistant" },
        { content: "delete all my tasks", role: "user" }
      ]);
    } finally {
      handle.stop();
    }
  });
});
