import { describe, expect, it } from "vitest";

import { TelegramProvider } from "../src/telegram-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

describe("TelegramProvider — idempotent read retries, send never does", () => {
  it("pollUpdates retries a transient 503, then returns the inbound message", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(503, { ok: false });
      }
      return jsonResponse(200, { ok: true, result: [{ message: { chat: { id: 123 }, date: 1_700_000_000, text: "hi" }, update_id: 1 }] });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    const messages = await provider.pollUpdates();

    expect(messages.map((m) => m.text)).toEqual(["hi"]);
    expect(calls).toBe(2); // retried the 503 once
  });

  it("send does NOT retry a 503 — fails after a single call (no duplicate-message risk)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse(503, { description: "busy", ok: false });
    }) as unknown as typeof globalThis.fetch;

    const provider = new TelegramProvider({ baseUrl: "http://tg.test", fetch: fetchImpl, token: "T" });
    await expect(provider.send({ destination: "@me", text: "hello" })).rejects.toThrow();
    expect(calls).toBe(1); // send is non-idempotent → never retried
  });
});
