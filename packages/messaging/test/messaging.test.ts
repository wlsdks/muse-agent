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
  readTelegramOffset,
  validateOutboundMessage,
  writeTelegramOffset
} from "../src/index.js";
import { clampInboundLimit, tryParseJson } from "../src/provider-helpers.js";
import { appendInbound, readInbox } from "../src/inbox-store.js";
import { mkdtempSync, readFileSync } from "node:fs";
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

describe("SlackProvider.fetchInbound", () => {
  it("posts to conversations.history with form body and maps text messages", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenBody = "";
    const provider = new SlackProvider({
      baseUrl: "https://slk.test/api",
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
        seenBody = String(init?.body);
        return fakeJsonResponse({
          messages: [
            { text: "hi from stark", ts: "1700000000.000100", type: "message", user: "U-STARK" },
            // empty text → skipped
            { text: "", ts: "1700000010.000100", type: "message", user: "U-BOT" },
            { bot_id: "B-1", subtype: "bot_message", text: "deploy ok", ts: "1700000020.000100", username: "deployer" }
          ],
          ok: true
        });
      },
      token: "xoxb-test"
    });
    const inbound = await provider.fetchInbound({ limit: 10, source: "C123" });
    expect(seenUrl).toBe("https://slk.test/api/conversations.history");
    expect(seenAuth).toBe("Bearer xoxb-test");
    expect(seenBody).toContain("channel=C123");
    expect(seenBody).toContain("limit=10");
    expect(inbound).toHaveLength(2);
    expect(inbound[0]).toMatchObject({
      messageId: "1700000000.000100",
      providerId: "slack",
      receivedAtIso: "2023-11-14T22:13:20.000Z",
      sender: "U-STARK",
      source: "C123",
      text: "hi from stark"
    });
    // bot messages keep `username` as the sender display
    expect(inbound[1]).toMatchObject({ sender: "deployer", text: "deploy ok" });
  });

  it("rejects calls without `source` before any HTTP", async () => {
    let calls = 0;
    const provider = new SlackProvider({
      fetch: async () => {
        calls += 1;
        return fakeJsonResponse({ messages: [], ok: true });
      },
      token: "x"
    });
    await expect(provider.fetchInbound()).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
      message: expect.stringContaining("source")
    });
    expect(calls).toBe(0);
  });

  it("turns ok:false into MessagingProviderError carrying the slack error code", async () => {
    const provider = new SlackProvider({
      fetch: async () => fakeJsonResponse({ error: "channel_not_found", ok: false }),
      token: "x"
    });
    await expect(provider.fetchInbound({ source: "C-bogus" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: expect.stringContaining("channel_not_found")
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

describe("telegram-offset-store", () => {
  it("readTelegramOffset returns undefined when the file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    expect(await readTelegramOffset(join(dir, "missing.json"))).toBeUndefined();
  });

  it("readTelegramOffset returns undefined when the JSON is malformed or offset is not a finite number", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    const garbage = join(dir, "garbage.json");
    const nan = join(dir, "nan.json");
    const ok = join(dir, "ok.json");
    await writeTelegramOffset(ok, 42);
    // Hand-craft malformed shapes to exercise the guards.
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(garbage, "{not json", "utf8");
    await fs.writeFile(nan, JSON.stringify({ offset: "NaN", version: 1 }), "utf8");
    expect(await readTelegramOffset(garbage)).toBeUndefined();
    expect(await readTelegramOffset(nan)).toBeUndefined();
    expect(await readTelegramOffset(ok)).toBe(42);
  });

  it("writeTelegramOffset round-trips the latest value atomically (tmp+rename)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    const file = join(dir, "offset.json");
    await writeTelegramOffset(file, 10);
    await writeTelegramOffset(file, 999);
    expect(await readTelegramOffset(file)).toBe(999);
    // Atomic write should leave no tmp leftovers.
    const { promises: fs } = await import("node:fs");
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });
});

describe("TelegramProvider.fetchInbound inbox-file branch", () => {
  it("when inboxFile is configured, fetchInbound reads from the persisted store and does not hit Bot API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-inbox-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [
        { messageId: "1", providerId: "telegram", receivedAtIso: "2026-05-11T00:00:00Z", source: "999", text: "older" },
        { messageId: "2", providerId: "telegram", receivedAtIso: "2026-05-11T00:01:00Z", source: "999", text: "newer" }
      ],
      version: 1
    }), "utf8");
    let fetchCalls = 0;
    const provider = new TelegramProvider({
      fetch: async () => { fetchCalls += 1; return fakeJsonResponse({ ok: true, result: [] }); },
      inboxFile,
      token: "T"
    });
    const inbound = await provider.fetchInbound({ limit: 10 });
    // Stored newest-last; readInbox reverses to newest-first.
    expect(inbound.map((m) => m.text)).toEqual(["newer", "older"]);
    expect(fetchCalls).toBe(0);
  });

  it("pollUpdates still hits Bot API even when inboxFile is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-poll-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    let seenUrl = "";
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => { seenUrl = String(url); return fakeJsonResponse({ ok: true, result: [] }); },
      inboxFile,
      token: "T"
    });
    await provider.pollUpdates();
    expect(seenUrl).toBe("https://tg.test/botT/getUpdates?limit=20&timeout=0");
  });
});

describe("TelegramProvider.fetchInbound offset tracking", () => {
  it("omits ?offset when no offsetFile is configured (backward-compat snapshot mode)", async () => {
    let seenUrl = "";
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => { seenUrl = String(url); return fakeJsonResponse({ ok: true, result: [] }); },
      token: "T"
    });
    await provider.fetchInbound();
    expect(seenUrl).not.toContain("offset=");
  });

  it("passes ?offset=<stored> and advances the file to max(update_id)+1 after a successful poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    const offsetFile = join(dir, "offset.json");
    await writeTelegramOffset(offsetFile, 100);
    const urls: string[] = [];
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (url) => {
        urls.push(String(url));
        return fakeJsonResponse({
          ok: true,
          result: [
            { message: { chat: { id: 1 }, date: 1, message_id: 1, text: "a" }, update_id: 100 },
            { message: { chat: { id: 1 }, date: 2, message_id: 2, text: "b" }, update_id: 105 },
            { update_id: 104 } // non-message update — still must be ack'd
          ]
        });
      },
      offsetFile,
      token: "T"
    });
    const inbound = await provider.fetchInbound({ limit: 50 });
    expect(urls[0]).toContain("&offset=100");
    expect(inbound).toHaveLength(2);
    // Highest update_id seen was 105 (the non-message one too) → store 106.
    expect(await readTelegramOffset(offsetFile)).toBe(106);
  });

  it("leaves the offset file untouched when the response is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    const offsetFile = join(dir, "offset.json");
    await writeTelegramOffset(offsetFile, 7);
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => fakeJsonResponse({ ok: true, result: [] }),
      offsetFile,
      token: "T"
    });
    await provider.fetchInbound();
    expect(await readTelegramOffset(offsetFile)).toBe(7);
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
    // All four shipped providers implement fetchInbound in some form
    // now. The "not supported" guard still matters for any future
    // provider added without inbound; assert it via a stub.
    const stub = {
      describe: () => ({ description: "stub", displayName: "Stub", id: "stub" }),
      id: "stub",
      send: async () => { throw new Error("send not used in this test"); }
    } as unknown as Parameters<typeof MessagingProviderRegistry.prototype.register>[0];
    const registry = new MessagingProviderRegistry([stub]);
    await expect(registry.fetchInbound("stub")).rejects.toMatchObject({
      code: "UPSTREAM_FAILED",
      message: expect.stringContaining("does not support inbound")
    });
  });

  it("LineProvider.fetchInbound throws INVALID_DESTINATION when inboxFile isn't configured", async () => {
    const line = new LineProvider({ token: "x" });
    await expect(line.fetchInbound()).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
      message: expect.stringContaining("inboxFile")
    });
  });

  it("LineProvider.fetchInbound reads the persisted webhook inbox newest-first", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-line-fetch-"));
    const inboxFile = join(root, "line-inbox.json");
    const line = new LineProvider({ inboxFile, token: "x" });

    // Empty file → empty array.
    expect(await line.fetchInbound({ limit: 10 })).toEqual([]);

    // Append two messages via the same store the webhook would use.
    const { appendInbound } = await import("../src/index.js");
    await appendInbound(inboxFile, {
      messageId: "m1",
      providerId: "line",
      receivedAtIso: "2026-05-11T08:00:00.000Z",
      sender: "U-stark",
      source: "U-stark",
      text: "hello"
    });
    await appendInbound(inboxFile, {
      messageId: "m2",
      providerId: "line",
      receivedAtIso: "2026-05-11T08:01:00.000Z",
      sender: "U-stark",
      source: "U-stark",
      text: "follow-up"
    });
    const inbound = await line.fetchInbound({ limit: 10 });
    expect(inbound.map((m) => m.messageId)).toEqual(["m2", "m1"]); // newest-first
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

describe("inbox-store", () => {
  function makeMessage(overrides: Partial<{ messageId: string; receivedAtIso: string; text: string }> = {}): import("../src/index.js").InboundMessage {
    return {
      messageId: overrides.messageId ?? "msg-1",
      providerId: "line",
      receivedAtIso: overrides.receivedAtIso ?? "2026-05-11T08:00:00.000Z",
      source: "U-stark",
      text: overrides.text ?? "hello"
    };
  }

  it("readInbox returns [] for missing/malformed files", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-"));
    expect(await readInbox(join(root, "missing.json"))).toEqual([]);
    // malformed JSON
    const { writeFileSync } = await import("node:fs");
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{not json", "utf8");
    expect(await readInbox(bad)).toEqual([]);
    // wrong shape
    const wrong = join(root, "wrong.json");
    writeFileSync(wrong, '{"messages":[]}', "utf8");
    expect(await readInbox(wrong)).toEqual([]);
  });

  it("appendInbound persists newest-last; readInbox surfaces newest-first", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-rw-"));
    const file = join(root, "inbox.json");
    await appendInbound(file, makeMessage({ messageId: "1", text: "first" }));
    await appendInbound(file, makeMessage({ messageId: "2", text: "second" }));
    await appendInbound(file, makeMessage({ messageId: "3", text: "third" }));
    const out = await readInbox(file);
    expect(out.map((m) => m.text)).toEqual(["third", "second", "first"]);
  });

  it("appendInbound trims to capacity dropping oldest", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-cap-"));
    const file = join(root, "inbox.json");
    for (let index = 0; index < 5; index += 1) {
      await appendInbound(file, makeMessage({ messageId: `m${index.toString()}` }), { capacity: 3 });
    }
    const out = await readInbox(file);
    expect(out.map((m) => m.messageId)).toEqual(["m4", "m3", "m2"]);
    // On disk it's stored newest-last
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { inbox: Array<{ messageId: string }> };
    expect(persisted.inbox.map((m) => m.messageId)).toEqual(["m2", "m3", "m4"]);
  });

  it("readInbox honours `limit` (default 100, max 200)", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-limit-"));
    const file = join(root, "inbox.json");
    for (let index = 0; index < 30; index += 1) {
      await appendInbound(file, makeMessage({ messageId: `m${index.toString()}` }));
    }
    expect(await readInbox(file, 5)).toHaveLength(5);
    expect(await readInbox(file)).toHaveLength(30); // 30 < default 100
    expect(await readInbox(file, 9999)).toHaveLength(30); // capped to 200, but only 30 exist
  });

  it("isInboundMessage rejects malformed entries on read", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-bad-"));
    const file = join(root, "inbox.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({
      inbox: [
        { messageId: "ok", providerId: "line", receivedAtIso: "x", source: "y", text: "z" },
        { messageId: 42 }, // bad type → skipped
        null,
        { providerId: "line" } // missing required fields → skipped
      ]
    }), "utf8");
    const out = await readInbox(file);
    expect(out).toHaveLength(1);
    expect(out[0]?.messageId).toBe("ok");
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
