import { describe, expect, it } from "vitest";

import { TelegramProvider } from "../src/telegram-provider.js";

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
