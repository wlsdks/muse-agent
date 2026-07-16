import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MessagingProviderError } from "../src/errors.js";
import { readTelegramOffset } from "../src/telegram-offset-store.js";
import { TelegramProvider } from "../src/telegram-provider.js";

describe("TelegramProvider external boundary contract", () => {
  it("normalizes a timeout-shaped outbound rejection without retrying an ambiguous send", async () => {
    const fetchImpl = (async () => { throw new Error("request to Telegram timed out after 30000ms"); }) as unknown as typeof globalThis.fetch;
    const provider = new TelegramProvider({ fetch: fetchImpl, token: "T" });
    const err = await provider.send({ destination: "1", text: "hi" }).catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.code).toBe("UPSTREAM_FAILED");
    expect(err.retryable).toBe(false);
  });

  it("normalizes an unreadable successful send body instead of creating a fake receipt", async () => {
    const unreadable = {
      headers: new Headers(),
      ok: true,
      status: 200,
      statusText: "OK",
      text: async (): Promise<string> => { throw new Error("body stream failed"); }
    } as unknown as Response;
    const provider = new TelegramProvider({ fetch: async () => unreadable, token: "T" });
    const err = await provider.send({ destination: "1", text: "hi" }).catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.status).toBe(200);
    expect(err.retryable).toBe(false);
  });

  it("keeps valid update progress when malformed update ids and dates appear in the same API payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-telegram-offset-"));
    const offsetFile = join(directory, "offset.json");
    try {
      const provider = new TelegramProvider({
        fetch: async () => new Response('{"ok":true,"result":[null,{"update_id":1e400},{"update_id":7,"message":{"chat":null,"date":1700000000,"message_id":7,"text":"bad chat"}},{"update_id":8,"message":{"chat":{"id":1},"date":1e400,"message_id":8,"text":"bad date"}},{"update_id":9,"message":{"chat":{"id":1},"date":1700000000,"message_id":9,"text":"valid"}}]}'),
        offsetFile,
        token: "T"
      });
      const inbound = await provider.pollUpdates();
      expect(inbound).toMatchObject([{ messageId: "9", text: "valid" }]);
      expect(await readTelegramOffset(offsetFile)).toBe(10);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("retains Telegram's body retry_after after a read rate limit remains exhausted", async () => {
    const provider = new TelegramProvider({
      fetch: async () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429 }),
      token: "T"
    });
    const err = await provider.pollUpdates().catch((cause: unknown) => cause) as MessagingProviderError;
    expect(err).toBeInstanceOf(MessagingProviderError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2_000);
  });
});
