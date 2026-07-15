import { describe, expect, it } from "vitest";

import { TELEGRAM_BOT_COMMANDS, TelegramProvider } from "../src/telegram-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

describe("TelegramProvider real-time surface", () => {
  it("pollUpdates long-polls when longPollSeconds is set (timeout param reaches getUpdates)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse(200, { ok: true, result: [] });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await provider.pollUpdates({ longPollSeconds: 25 });

    expect(urls[0]).toContain("timeout=25");
  });

  it("pollUpdates without longPollSeconds stays a short snapshot (timeout=0)", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse(200, { ok: true, result: [] });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await provider.pollUpdates();

    expect(urls[0]).toContain("timeout=0");
  });

  it("sendTyping POSTs a typing chat action to the chat", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return jsonResponse(200, { ok: true, result: true });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await provider.sendTyping("12345");

    expect(calls[0]?.url).toBe("http://tg.test/botT/sendChatAction");
    expect(calls[0]?.body).toEqual({ action: "typing", chat_id: "12345" });
  });

  it("sendTyping surfaces an upstream failure as a provider error", async () => {
    const fetchImpl = (async () => jsonResponse(400, { description: "chat not found", ok: false })) as unknown as typeof globalThis.fetch;
    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await expect(provider.sendTyping("1")).rejects.toThrow(/chat not found/u);
  });
});

describe("TelegramProvider.reactToMessage", () => {
  it("POSTs a setMessageReaction with the emoji", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return jsonResponse(200, { ok: true, result: true });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await provider.reactToMessage("12345", "77", "👀");

    expect(calls[0]?.url).toBe("http://tg.test/botT/setMessageReaction");
    expect(calls[0]?.body).toEqual({
      chat_id: "12345",
      message_id: 77,
      reaction: [{ emoji: "👀", type: "emoji" }]
    });
  });

  it("surfaces an upstream failure as a provider error", async () => {
    const fetchImpl = (async () => jsonResponse(400, { description: "REACTION_INVALID", ok: false })) as unknown as typeof globalThis.fetch;
    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await expect(provider.reactToMessage("1", "2", "🤖")).rejects.toThrow(/REACTION_INVALID/u);
  });
});

describe("TelegramProvider.registerCommands", () => {
  it("POSTs setMyCommands with the exact new/status/model/help list", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body)), url: String(url) });
      return jsonResponse(200, { ok: true, result: true });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await provider.registerCommands();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://tg.test/botT/setMyCommands");
    // Hard-coded, not a re-import of TELEGRAM_BOT_COMMANDS — a mutation to
    // the exported list must fail THIS assertion, not just compare against
    // itself. Mirrors the exact set inbound-slash-commands.ts handles.
    expect(calls[0]?.body).toEqual({
      commands: [
        { command: "new", description: "Start a fresh conversation, clearing this chat's history" },
        { command: "status", description: "Show the current model, pending approvals, and turn count" },
        { command: "model", description: "Show the current default model" },
        { command: "help", description: "List available commands" }
      ]
    });
  });

  it("every command name/description satisfies Telegram's BotCommand limits", () => {
    for (const { command, description } of TELEGRAM_BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/u);
      expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it("surfaces an upstream failure as a provider error (fail-soft is the caller's job, not this method's)", async () => {
    const fetchImpl = (async () => jsonResponse(400, { description: "BUTTON_DATA_INVALID", ok: false })) as unknown as typeof globalThis.fetch;
    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await expect(provider.registerCommands()).rejects.toThrow(/BUTTON_DATA_INVALID/u);
  });
});
