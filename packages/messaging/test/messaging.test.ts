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
