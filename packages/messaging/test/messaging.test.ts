import { describe, expect, it } from "vitest";

import {
  DiscordProvider,
  FileMessagingCredentialStore,
  LineProvider,
  MessagingProviderError,
  MessagingProviderRegistry,
  MessagingValidationError,
  SlackProvider,
  TelegramProvider,
  validateOutboundMessage
} from "../src/index.js";
import { clampInboundLimit, tryParseJson } from "../src/provider-helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeJsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
    ...init
  });
}

describe("clampInboundLimit", () => {
  it("returns the default when raw is undefined or non-finite", () => {
    expect(clampInboundLimit(undefined)).toBe(20);
    expect(clampInboundLimit(Number.NaN)).toBe(20);
    expect(clampInboundLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it("clamps to [1, 100] (default cap) and truncates fractions", () => {
    expect(clampInboundLimit(0)).toBe(1);
    expect(clampInboundLimit(-5)).toBe(1);
    expect(clampInboundLimit(50.7)).toBe(50);
    expect(clampInboundLimit(9999)).toBe(100);
  });

  it("honours a custom max", () => {
    expect(clampInboundLimit(80, 50)).toBe(50);
    expect(clampInboundLimit(10, 50)).toBe(10);
  });
});

describe("tryParseJson", () => {
  it("returns undefined for empty body", () => {
    expect(tryParseJson<unknown>("")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(tryParseJson<unknown>("not json")).toBeUndefined();
    expect(tryParseJson<unknown>("{nope}")).toBeUndefined();
  });

  it("returns the typed value on success", () => {
    const out = tryParseJson<{ ok: boolean; n: number }>('{"ok":true,"n":3}');
    expect(out).toEqual({ n: 3, ok: true });
  });
});

describe("validateOutboundMessage", () => {
  it("rejects empty destination + empty text", () => {
    expect(() => validateOutboundMessage({ destination: "", text: "hi" }))
      .toThrow(MessagingValidationError);
    expect(() => validateOutboundMessage({ destination: "u", text: "" }))
      .toThrow(MessagingValidationError);
  });

  it("rejects oversized text (>4096 chars)", () => {
    expect(() => validateOutboundMessage({ destination: "u", text: "a".repeat(4097) }))
      .toThrow(MessagingValidationError);
  });

  it("accepts a normal payload", () => {
    expect(() => validateOutboundMessage({ destination: "u", text: "hi" })).not.toThrow();
  });
});

describe("TelegramProvider", () => {
  it("posts to bot{token}/sendMessage and surfaces message_id", async () => {
    let seenUrl = "";
    let seenBody = "";
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenBody = String(init?.body);
        return fakeJsonResponse({ ok: true, result: { chat: { id: 1 }, message_id: 42 } });
      },
      token: "BOT-TOKEN"
    });
    const receipt = await provider.send({ destination: "@me", text: "hi" });
    expect(seenUrl).toBe("https://tg.test/botBOT-TOKEN/sendMessage");
    expect(JSON.parse(seenBody)).toMatchObject({ chat_id: "@me", text: "hi" });
    expect(receipt).toMatchObject({ destination: "@me", messageId: "42", providerId: "telegram" });
  });

  it("throws MessagingProviderError on 401 with description", async () => {
    const provider = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Unauthorized", ok: false }, { status: 401 }),
      token: "x"
    });
    await expect(provider.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ code: "UPSTREAM_FAILED", providerId: "telegram", status: 401 });
  });
});

describe("DiscordProvider", () => {
  it("posts to channels/:id/messages with Bot auth header", async () => {
    let seenAuth = "";
    let seenUrl = "";
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
        return fakeJsonResponse({ id: "msg-1" });
      },
      token: "BOT123"
    });
    const receipt = await provider.send({ destination: "ch-9", text: "yo" });
    expect(seenUrl).toBe("https://disc.test/api/v10/channels/ch-9/messages");
    expect(seenAuth).toBe("Bot BOT123");
    expect(receipt).toMatchObject({ destination: "ch-9", messageId: "msg-1", providerId: "discord" });
  });
});

describe("DiscordProvider.fetchInbound", () => {
  it("hits /channels/:id/messages?limit=N with Bot auth and maps responses", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
        return fakeJsonResponse([
          {
            author: { global_name: "Stark", username: "stark97" },
            channel_id: "ch-9",
            content: "hello",
            id: "msg-1",
            timestamp: "2026-05-11T08:00:00.000+00:00"
          },
          {
            author: { username: "bot" },
            channel_id: "ch-9",
            content: "",  // empty → skipped
            id: "msg-2",
            timestamp: "2026-05-11T08:01:00.000+00:00"
          }
        ]);
      },
      token: "BOT123"
    });
    const inbound = await provider.fetchInbound({ limit: 5, source: "ch-9" });
    expect(seenUrl).toBe("https://disc.test/api/v10/channels/ch-9/messages?limit=5");
    expect(seenAuth).toBe("Bot BOT123");
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      messageId: "msg-1",
      providerId: "discord",
      receivedAtIso: "2026-05-11T08:00:00.000+00:00",
      sender: "Stark", // global_name preferred over username
      source: "ch-9",
      text: "hello"
    });
  });

  it("rejects calls without `source` (channel id) before any HTTP", async () => {
    let calls = 0;
    const provider = new DiscordProvider({
      fetch: async () => {
        calls += 1;
        return fakeJsonResponse([]);
      },
      token: "x"
    });
    await expect(provider.fetchInbound()).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
      message: expect.stringContaining("source")
    });
    expect(calls).toBe(0);
  });

  it("propagates 4xx as MessagingProviderError with parsed Discord error message", async () => {
    const provider = new DiscordProvider({
      fetch: async () => fakeJsonResponse({ code: 50001, message: "Missing Access" }, { status: 403 }),
      token: "x"
    });
    await expect(provider.fetchInbound({ source: "ch-1" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: expect.stringContaining("Missing Access"),
      status: 403
    });
  });
});

describe("SlackProvider", () => {
  it("requires ok:true and surfaces ts as message id", async () => {
    const provider = new SlackProvider({
      fetch: async () => fakeJsonResponse({ channel: "C123", ok: true, ts: "1700000000.000100" }),
      token: "xoxb-test"
    });
    const receipt = await provider.send({ destination: "C123", text: "hi" });
    expect(receipt).toMatchObject({ destination: "C123", messageId: "1700000000.000100", providerId: "slack" });
  });

  it("turns ok:false into MessagingProviderError with the slack error code", async () => {
    const provider = new SlackProvider({
      fetch: async () => fakeJsonResponse({ error: "channel_not_found", ok: false }),
      token: "x"
    });
    await expect(provider.send({ destination: "x", text: "hi" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: expect.stringContaining("channel_not_found")
    });
  });
});

describe("LineProvider", () => {
  it("synthesises a line:{iso} receipt id when push succeeds", async () => {
    const provider = new LineProvider({
      fetch: async () => new Response("{}", { status: 200 }),
      now: () => new Date("2026-05-10T08:00:00Z"),
      token: "ch-token"
    });
    const receipt = await provider.send({ destination: "U-123", text: "hi" });
    expect(receipt).toMatchObject({
      destination: "U-123",
      messageId: "line:2026-05-10T08:00:00.000Z",
      providerId: "line"
    });
  });

  it("propagates 4xx as MessagingProviderError", async () => {
    const provider = new LineProvider({
      fetch: async () => new Response(JSON.stringify({ message: "Invalid token" }), { status: 401 }),
      token: "x"
    });
    await expect(provider.send({ destination: "U-1", text: "hi" }))
      .rejects.toMatchObject({ status: 401 });
  });
});

describe("TelegramProvider.fetchInbound", () => {
  it("calls getUpdates with limit + timeout=0 and maps text updates to InboundMessage", async () => {
    let seenUrl = "";
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => {
        seenUrl = String(url);
        return fakeJsonResponse({
          ok: true,
          result: [
            {
              message: {
                chat: { id: 999, username: "stark" },
                date: 1700000000,
                from: { first_name: "Stark", id: 999, username: "stark97" },
                message_id: 5,
                text: "hello"
              },
              update_id: 100
            },
            { update_id: 101 }, // no message → skipped
            {
              message: { chat: { id: 999 }, date: 1700000060, message_id: 6, text: "second" },
              update_id: 102
            }
          ]
        });
      },
      token: "TOKEN"
    });
    const inbound = await provider.fetchInbound({ limit: 10 });
    expect(seenUrl).toBe("https://tg.test/botTOKEN/getUpdates?limit=10&timeout=0");
    expect(inbound).toHaveLength(2);
    expect(inbound[0]).toMatchObject({
      messageId: "5",
      providerId: "telegram",
      receivedAtIso: "2023-11-14T22:13:20.000Z",
      sender: "stark97",
      source: "999",
      text: "hello"
    });
    expect(inbound[1]?.messageId).toBe("6");
    expect(inbound[1]?.sender).toBeUndefined();
  });

  it("clamps limit to [1, 100] and defaults to 20 when omitted", async () => {
    const seen: string[] = [];
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => {
        seen.push(String(url));
        return fakeJsonResponse({ ok: true, result: [] });
      },
      token: "x"
    });
    await provider.fetchInbound();
    await provider.fetchInbound({ limit: 0 });
    await provider.fetchInbound({ limit: 9999 });
    expect(seen[0]).toContain("limit=20");
    expect(seen[1]).toContain("limit=1");
    expect(seen[2]).toContain("limit=100");
  });

  it("throws MessagingProviderError when getUpdates 4xxs", async () => {
    const provider = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Unauthorized", ok: false }, { status: 401 }),
      token: "x"
    });
    await expect(provider.fetchInbound()).rejects.toMatchObject({ code: "UPSTREAM_FAILED", status: 401 });
  });
});

describe("MessagingProviderRegistry", () => {
  it("describes registered providers and routes send to the matching id", async () => {
    const tg = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => fakeJsonResponse({ ok: true, result: { message_id: 7 } }),
      token: "x"
    });
    const registry = new MessagingProviderRegistry([tg]);
    expect(registry.describe()).toEqual([{ description: expect.any(String), displayName: "Telegram", id: "telegram" }]);
    const receipt = await registry.send("telegram", { destination: "1", text: "hi" });
    expect(receipt.messageId).toBe("7");
  });

  it("throws PROVIDER_NOT_FOUND for unknown ids", async () => {
    const registry = new MessagingProviderRegistry();
    await expect(registry.send("telegram", { destination: "1", text: "hi" }))
      .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    expect(() => registry.require("telegram")).toThrow(MessagingProviderError);
  });

  it("fetchInbound surfaces a clear error for providers without inbound support", async () => {
    const slack = new SlackProvider({ token: "x" });
    const registry = new MessagingProviderRegistry([slack]);
    await expect(registry.fetchInbound("slack")).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: expect.stringContaining("does not support inbound")
    });
  });

  it("fetchInbound delegates to the provider when supported", async () => {
    const tg = new TelegramProvider({
      fetch: async () => fakeJsonResponse({
        ok: true,
        result: [{
          message: { chat: { id: 1 }, date: 1700000000, message_id: 7, text: "yo" },
          update_id: 1
        }]
      }),
      token: "x"
    });
    const registry = new MessagingProviderRegistry([tg]);
    const inbound = await registry.fetchInbound("telegram", { limit: 5 });
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe("yo");
  });
});

describe("FileMessagingCredentialStore", () => {
  it("round-trips save / load / list / remove", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-msg-creds-"));
    const store = new FileMessagingCredentialStore(join(root, "messaging.json"));
    expect(await store.list()).toEqual([]);
    await store.save("telegram", { token: "abc" });
    await store.save("slack", { token: "xoxb" });
    expect(await store.list()).toEqual(["slack", "telegram"]);
    expect(await store.load("telegram")).toEqual({ token: "abc" });
    await store.remove("telegram");
    expect(await store.list()).toEqual(["slack"]);
    expect(await store.load("telegram")).toBeUndefined();
  });
});
