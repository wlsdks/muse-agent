import { describe, expect, it } from "vitest";

import { MessagingProviderRegistry, TelegramProvider, createChannelApprovalGate } from "../src/index.js";
import type { MessagingProvider, OutboundMessage } from "../src/types.js";

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

describe("createChannelApprovalGate — approval gate exercised over the channel path", () => {
  it("lets read tools through without prompting", async () => {
    let posted = false;
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => { posted = true; return fakeJsonResponse({ ok: true, result: { message_id: 1 } }); },
      token: "T"
    });
    const gate = createChannelApprovalGate({
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram]),
      source: "555"
    });

    const decision = await gate({ risk: "read", runId: "r1", toolCall: { name: "notes.search" } });
    expect(decision.allowed).toBe(true);
    expect(posted).toBe(false);
  });

  it("blocks a risky tool and posts an in-chat approval prompt over the real provider's HTTP", async () => {
    let url = "";
    let body = "";
    const telegram = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (u, init) => {
        url = String(u);
        body = String(init?.body);
        return fakeJsonResponse({ ok: true, result: { message_id: 9 } });
      },
      token: "BOT-T"
    });
    const gate = createChannelApprovalGate({
      providerId: "telegram",
      registry: new MessagingProviderRegistry([telegram]),
      source: "555"
    });

    const decision = await gate({ risk: "execute", runId: "r2", toolCall: { name: "tasks.delete" } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("tasks.delete");
    expect(url).toBe("https://tg.test/botBOT-T/sendMessage");
    const sent = JSON.parse(body) as { chat_id: string; text: string };
    expect(sent.chat_id).toBe("555");
    expect(sent.text).toContain("tasks.delete");
    expect(sent.text).toContain("NOT executed");
    expect(sent.text).toContain("explicit approval");
  });

  it("fail-closed: a send failure still denies the risky tool", async () => {
    const throwing = {
      describe: () => ({ configured: true, displayName: "x", id: "telegram" }),
      id: "telegram",
      send: async (_m: OutboundMessage) => { throw new Error("network down"); }
    } as unknown as MessagingProvider;
    const gate = createChannelApprovalGate({
      providerId: "telegram",
      registry: new MessagingProviderRegistry([throwing]),
      source: "555"
    });

    const decision = await gate({ risk: "write", runId: "r3", toolCall: { name: "calendar.cancel" } });
    expect(decision.allowed).toBe(false);
  });
});
