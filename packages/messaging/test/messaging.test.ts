import { describe, expect, it } from "vitest";

import {
  DiscordProvider,
  FileMessagingCredentialStore,
  LineProvider,
  MessagingProviderError,
  isRetryableMessagingStatus,
  MessagingProviderRegistry,
  MessagingValidationError,
  SlackProvider,
  TelegramProvider,
  clampForTelegram,
  escapeForTelegramParseMode,
  escapeSlackText,
  readDiscordAfter,
  readSlackAfter,
  readTelegramOffset,
  validateOutboundMessage,
  writeDiscordAfter,
  writeSlackAfter,
  writeTelegramOffset
} from "../src/index.js";
import { clampInboundLimit, tryParseJson } from "../src/provider-helpers.js";
import { appendInbound, readInbox } from "../src/inbox-store.js";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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

  it("rejects whitespace-only text and whitespace-only destination — trim symmetry across both fields", () => {
    // Pre-fix `text` was bare `.length === 0`-checked, so a `"   "` /
    // `"\n"` payload flew out to Telegram/Slack/Discord/libnotify as a
    // blank notification — the recipient sees an empty bubble.
    expect(() => validateOutboundMessage({ destination: "u", text: "   " }), "text=\"   \" must reject — not silently send a blank notification").toThrow(MessagingValidationError);
    expect(() => validateOutboundMessage({ destination: "u", text: "\n\t" })).toThrow(MessagingValidationError);
    // Destination has had the trim check forever; pin it as a sibling assertion so a future regression can't silently revert it.
    expect(() => validateOutboundMessage({ destination: "   ", text: "hi" })).toThrow(MessagingValidationError);
    // Genuine content with surrounding whitespace stays allowed.
    expect(() => validateOutboundMessage({ destination: "u", text: "  hello  " })).not.toThrow();
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

  it("escapes outbound text for the active parse_mode so Telegram doesn't 400", async () => {
    let body = "";
    const provider = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (_url, init) => {
        body = String(init?.body);
        return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
      },
      parseMode: "MarkdownV2",
      token: "x"
    });
    // A perfectly ordinary reminder — periods, a hyphen, parens,
    // a bang. Pre-fix Telegram rejects this with 400.
    await provider.send({ destination: "@me", text: "Meeting at 3 p.m. — follow-up (room A)!" });
    const sent = JSON.parse(body) as { text: string; parse_mode: string };
    expect(sent.parse_mode).toBe("MarkdownV2");
    expect(sent.text).toBe("Meeting at 3 p\\.m\\. — follow\\-up \\(room A\\)\\!");
  });

  it("escapeForTelegramParseMode escapes per mode and is identity when unset", () => {
    expect(escapeForTelegramParseMode("a.b-c (d)!", "MarkdownV2")).toBe("a\\.b\\-c \\(d\\)\\!");
    expect(escapeForTelegramParseMode("a < b & c > d", "HTML")).toBe("a &lt; b &amp; c &gt; d");
    expect(escapeForTelegramParseMode("a.b-c (d)!", undefined)).toBe("a.b-c (d)!");
    // Backslash itself is escaped under MarkdownV2 (it is the escape char).
    expect(escapeForTelegramParseMode("path\\to", "MarkdownV2")).toBe("path\\\\to");
  });

  it("clampForTelegram keeps the ESCAPED text within Telegram's 4096 limit (escaping expands the body)", () => {
    // Plain text: the limit applies to the body directly.
    expect(clampForTelegram("a".repeat(5000), undefined).length).toBeLessThanOrEqual(4096);

    // MarkdownV2: a near-limit body of all-special chars roughly doubles
    // when escaped. clamp-then-escape (the bug) would send ~8000 chars
    // and Telegram 400s the whole message; clampForTelegram truncates the
    // SOURCE so the escaped form fits.
    const dense = "_".repeat(4000); // each "_" → "\_" (2 chars) when escaped
    const mdEscaped = escapeForTelegramParseMode(clampForTelegram(dense, "MarkdownV2"), "MarkdownV2");
    expect(mdEscaped.length).toBeLessThanOrEqual(4096);
    // No dangling half-escape: every backslash is paired with the char it escapes.
    expect(mdEscaped.endsWith("\\")).toBe(false);

    // HTML: "&" expands 5x ("&amp;"); the escaped result must still fit.
    const amps = "&".repeat(2000);
    const htmlEscaped = escapeForTelegramParseMode(clampForTelegram(amps, "HTML"), "HTML");
    expect(htmlEscaped.length).toBeLessThanOrEqual(4096);

    // A body that fits once escaped is passed through unchanged (no needless truncation).
    expect(clampForTelegram("hello *world*", "MarkdownV2")).toBe("hello *world*");
  });

  it("escapeForTelegramParseMode escapes every Telegram MarkdownV2 reserved char and leaves the rest alone", () => {
    // Telegram rejects sendMessage with 400 "can't parse entities"
    // if ANY of these 18 is unescaped — dropping the whole notice.
    // Each must be pinned individually so removing one from the
    // regex fails here, not silently in production.
    for (const ch of ["_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!"]) {
      expect(escapeForTelegramParseMode(ch, "MarkdownV2")).toBe(`\\${ch}`);
      expect(escapeForTelegramParseMode(`x${ch}y`, "MarkdownV2")).toBe(`x\\${ch}y`);
    }

    // Non-reserved characters must NOT be escaped: an over-eager
    // regex would corrupt every message's readability.
    for (const ch of ["a", "Z", "9", " ", "@", ":", "/", ",", "%", '"', "'", "&", "<", "?", "한"]) {
      expect(escapeForTelegramParseMode(ch, "MarkdownV2")).toBe(ch);
    }

    // HTML mode: exactly &,<,> and ampersand-first so an already-
    // entity-looking "&lt;" is not double-mangled into "&amp;lt;"
    // incorrectly; quotes/apostrophes/dots are NOT touched (Telegram
    // HTML text mode only requires the triple).
    expect(escapeForTelegramParseMode("<&>", "HTML")).toBe("&lt;&amp;&gt;");
    expect(escapeForTelegramParseMode("&lt;", "HTML")).toBe("&amp;lt;");
    expect(escapeForTelegramParseMode('a "b" .c- _d_', "HTML")).toBe('a "b" .c- _d_');

    // Empty string is identity under every mode.
    for (const mode of ["MarkdownV2", "HTML", undefined] as const) {
      expect(escapeForTelegramParseMode("", mode)).toBe("");
    }
  });

  it("throws MessagingProviderError on 401 with description", async () => {
    const provider = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Unauthorized", ok: false }, { status: 401 }),
      token: "x"
    });
    await expect(provider.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ code: "UPSTREAM_FAILED", providerId: "telegram", status: 401, retryable: false });
  });

  it("classifies 429 (rate limit) and 5xx as retryable", async () => {
    const provider429 = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Too Many Requests", ok: false }, { status: 429 }),
      token: "x"
    });
    await expect(provider429.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ status: 429, retryable: true });

    const provider503 = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Bad Gateway", ok: false }, { status: 503 }),
      token: "x"
    });
    await expect(provider503.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ status: 503, retryable: true });

    // 4xx other than 429 stays fail-fast.
    const provider404 = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Not Found", ok: false }, { status: 404 }),
      token: "x"
    });
    await expect(provider404.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ status: 404, retryable: false });
  });

  it("carries Telegram's body retry_after (seconds) as retryAfterMs on a 429", async () => {
    const provider = new TelegramProvider({
      fetch: async () => fakeJsonResponse({ description: "Too Many Requests", ok: false, parameters: { retry_after: 12 } }, { status: 429 }),
      token: "x"
    });
    await expect(provider.send({ destination: "1", text: "hi" }))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
  });

  it("disables link previews on every sendMessage — a URL an injected reply carries must not trigger Telegram's server-side preview crawler", async () => {
    let seenBody = "";
    const provider = new TelegramProvider({
      fetch: async (_url, init) => {
        seenBody = String(init?.body);
        return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
      },
      token: "x"
    });
    await provider.send({ destination: "1", text: "see https://attacker.example/t?d=secret" });
    const sent = JSON.parse(seenBody) as { link_preview_options?: { is_disabled: boolean } };
    expect(sent.link_preview_options).toEqual({ is_disabled: true });
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

  it("truncates a >2000-char message to Discord's content limit instead of dropping it", async () => {
    let sentContent = "";
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (_url, init) => {
        sentContent = (JSON.parse(String(init?.body)) as { content: string }).content;
        return fakeJsonResponse({ id: "msg-2" });
      },
      token: "BOT123"
    });
    await provider.send({ destination: "ch-9", text: "Z".repeat(5000) });
    expect(sentContent.length).toBe(2000);
    expect(sentContent.endsWith("… [truncated]")).toBe(true);

    // A short message is posted unchanged.
    await provider.send({ destination: "ch-9", text: "short" });
    expect(sentContent).toBe("short");
  });

  it("times out a stalled send so a wedged Discord API connection can't hang the proactive tick (timeoutMs threaded into fetchWithTimeout)", async () => {
    const neverResolves: typeof globalThis.fetch = (_input, init) =>
      (() => {
        const pending = Promise.withResolvers<Response>();
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), { once: true });
        return pending.promise;
      })();
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: neverResolves,
      timeoutMs: 10,
      token: "BOT123"
    });
    await expect(provider.send({ destination: "ch-9", text: "yo" })).rejects.toThrow(/timed out after 10ms/u);
  });

  it("suppresses all mention resolution so @everyone in text can't ping the server", async () => {
    let body: { content: string; allowed_mentions?: { parse: readonly string[] } } = { content: "" };
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return fakeJsonResponse({ id: "msg-3" });
      },
      token: "BOT123"
    });
    await provider.send({ destination: "ch-9", text: "reminder: ping @everyone and <@123> about it" });
    // Text is sent verbatim (not stripped) …
    expect(body.content).toBe("reminder: ping @everyone and <@123> about it");
    // … but Discord is told to resolve no mentions at all.
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("sets flags: 4 (SUPPRESS_EMBEDS) so a URL an injected reply carries can't trigger Discord's server-side preview crawler", async () => {
    let body: { flags?: number } = {};
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return fakeJsonResponse({ id: "msg-4" });
      },
      token: "BOT123"
    });
    await provider.send({ destination: "ch-9", text: "see https://attacker.example/t?d=secret" });
    expect(body.flags).toBe(4);
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

describe("discord-after-store", () => {
  it("readDiscordAfter returns undefined when the file is missing or malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-after-"));
    expect(await readDiscordAfter(join(dir, "missing.json"), "ch-1")).toBeUndefined();
    const garbage = join(dir, "garbage.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(garbage, "not json", "utf8");
    expect(await readDiscordAfter(garbage, "ch-1")).toBeUndefined();
  });

  it("write+read round-trips per-channel cursors without collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-after-"));
    const file = join(dir, "after.json");
    await writeDiscordAfter(file, "ch-a", "111");
    await writeDiscordAfter(file, "ch-b", "222");
    await writeDiscordAfter(file, "ch-a", "333"); // overwrite ch-a
    expect(await readDiscordAfter(file, "ch-a")).toBe("333");
    expect(await readDiscordAfter(file, "ch-b")).toBe("222");
    expect(await readDiscordAfter(file, "ch-missing")).toBeUndefined();
  });

  it("writeDiscordAfter persists the file with mode 0o600 (the sidecar names every channel polled + last seen snowflake)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-after-"));
    const file = join(dir, "after.json");
    await writeDiscordAfter(file, "ch-1", "1000000");
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode, "discord-after sidecar must be user-only, matching the credential store + inbound-thread-store convention").toBe(0o600);
  });
});

describe("DiscordProvider.fetchInbound inbox-file branch", () => {
  it("when inboxFile is configured, fetchInbound reads from the persisted store and does not hit Discord API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-inbox-"));
    const inboxFile = join(dir, "discord-inbox.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [
        { messageId: "1", providerId: "discord", receivedAtIso: "2026-05-11T00:00:00Z", source: "ch-a", text: "in ch-a" },
        { messageId: "2", providerId: "discord", receivedAtIso: "2026-05-11T00:01:00Z", source: "ch-b", text: "in ch-b" },
        { messageId: "3", providerId: "discord", receivedAtIso: "2026-05-11T00:02:00Z", source: "ch-a", text: "in ch-a again" }
      ],
      version: 1
    }), "utf8");
    let fetchCalls = 0;
    const provider = new DiscordProvider({
      fetch: async () => { fetchCalls += 1; return fakeJsonResponse([]); },
      inboxFile,
      token: "x"
    });
    // No `source` → all channels (newest-first).
    const all = await provider.fetchInbound({ limit: 10 });
    expect(all.map((m) => m.messageId)).toEqual(["3", "2", "1"]);
    // With `source` → filtered to that channel.
    const onlyA = await provider.fetchInbound({ limit: 10, source: "ch-a" });
    expect(onlyA.map((m) => m.messageId)).toEqual(["3", "1"]);
    expect(fetchCalls).toBe(0);
  });

  it("pollUpdates still hits Discord API even when inboxFile is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-poll-with-inbox-"));
    const inboxFile = join(dir, "discord-inbox.json");
    let seenUrl = "";
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (url) => { seenUrl = String(url); return fakeJsonResponse([]); },
      inboxFile,
      token: "x"
    });
    await provider.pollUpdates({ source: "ch-1" });
    expect(seenUrl).toBe("https://disc.test/api/v10/channels/ch-1/messages?limit=20");
  });
});

describe("DiscordProvider.pollUpdates", () => {
  it("without afterFile, polls without ?after= (snapshot mode)", async () => {
    let seenUrl = "";
    const provider = new DiscordProvider({
      baseUrl: "https://disc.test/api",
      fetch: async (url) => { seenUrl = String(url); return fakeJsonResponse([]); },
      token: "x"
    });
    await provider.pollUpdates({ source: "ch-9" });
    expect(seenUrl).not.toContain("after=");
  });

  it("with afterFile, passes ?after=<stored> and advances to the newest snowflake by BigInt compare", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-poll-"));
    const afterFile = join(dir, "after.json");
    await writeDiscordAfter(afterFile, "ch-9", "1000000000000000000");
    let seenUrl = "";
    const provider = new DiscordProvider({
      afterFile,
      baseUrl: "https://disc.test/api",
      fetch: async (url) => {
        seenUrl = String(url);
        return fakeJsonResponse([
          // Newest-first, but mix lengths to exercise BigInt compare.
          { author: { username: "u" }, channel_id: "ch-9", content: "newest", id: "1099999999999999999", timestamp: "2026-05-11T10:00:00Z" },
          { author: { username: "u" }, channel_id: "ch-9", content: "older", id: "999999999999999999", timestamp: "2026-05-11T09:00:00Z" }
        ]);
      },
      token: "x"
    });
    const inbound = await provider.pollUpdates({ source: "ch-9", limit: 50 });
    expect(seenUrl).toContain("&after=1000000000000000000");
    expect(inbound).toHaveLength(2);
    // BigInt(1099999999999999999) > BigInt(999999999999999999) → newest wins.
    expect(await readDiscordAfter(afterFile, "ch-9")).toBe("1099999999999999999");
  });

  it("with afterFile, empty response leaves the cursor untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-empty-"));
    const afterFile = join(dir, "after.json");
    await writeDiscordAfter(afterFile, "ch-9", "777");
    const provider = new DiscordProvider({
      afterFile,
      fetch: async () => fakeJsonResponse([]),
      token: "x"
    });
    await provider.pollUpdates({ source: "ch-9" });
    expect(await readDiscordAfter(afterFile, "ch-9")).toBe("777");
  });

  it("rejects calls without `source` (channel id) before any HTTP", async () => {
    let calls = 0;
    const provider = new DiscordProvider({
      fetch: async () => { calls += 1; return fakeJsonResponse([]); },
      token: "x"
    });
    await expect(provider.pollUpdates()).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
      message: expect.stringContaining("source")
    });
    expect(calls).toBe(0);
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

  it("times out a stalled chat.postMessage so a wedged Slack API connection can't hang the send path (timeoutMs threaded into fetchWithTimeout)", async () => {
    const neverResolves: typeof globalThis.fetch = (_input, init) =>
      (() => {
        const pending = Promise.withResolvers<Response>();
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), { once: true });
        return pending.promise;
      })();
    const provider = new SlackProvider({ fetch: neverResolves, timeoutMs: 10, token: "xoxb-test" });
    await expect(provider.send({ destination: "C123", text: "hi" })).rejects.toThrow(/timed out after 10ms/u);
  });

  it("escapes &/</> so Slack mrkdwn can't turn text into links/mentions", async () => {
    let sentText = "";
    const provider = new SlackProvider({
      fetch: async (_url, init) => {
        sentText = (JSON.parse(String(init?.body)) as { text: string }).text;
        return fakeJsonResponse({ channel: "C1", ok: true, ts: "1700000000.000100" });
      },
      token: "xoxb-test"
    });
    // A stray `<!channel>` substring would broadcast-ping the
    // whole channel; `<http…>` would auto-link; `&` mojibakes.
    await provider.send({ destination: "C1", text: "see <!channel> & docs at <https://x> when x < y" });
    expect(sentText).toBe(
      "see &lt;!channel&gt; &amp; docs at &lt;https://x&gt; when x &lt; y"
    );
  });

  it("disables link/media unfurling on every chat.postMessage — a URL an injected reply carries must not trigger Slack's server-side preview fetch", async () => {
    let seenBody = "";
    const provider = new SlackProvider({
      fetch: async (_url, init) => {
        seenBody = String(init?.body);
        return fakeJsonResponse({ channel: "C1", ok: true, ts: "1700000000.000100" });
      },
      token: "xoxb-test"
    });
    await provider.send({ destination: "C1", text: "see https://attacker.example/t?d=secret" });
    const sent = JSON.parse(seenBody) as { unfurl_links?: boolean; unfurl_media?: boolean };
    expect(sent.unfurl_links).toBe(false);
    expect(sent.unfurl_media).toBe(false);
  });

  it("escapeSlackText escapes exactly &, <, > (ampersand first)", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    // No double-escape: a literal `&lt;` stays one level escaped.
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
    // mrkdwn formatting chars are NOT escaped (Slack renders them).
    expect(escapeSlackText("*bold* _it_ ~s~ no change")).toBe("*bold* _it_ ~s~ no change");
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

  it("bounds a huge upstream error body in the thrown message (parity with Telegram/Discord)", async () => {
    const provider = new SlackProvider({
      fetch: async () => new Response("X".repeat(5000), { status: 502 }),
      token: "x"
    });
    let caught: unknown;
    await provider.send({ destination: "C1", text: "hi" }).catch((error: unknown) => { caught = error; });
    const message = (caught as { message: string }).message;
    expect(message.startsWith("Slack chat.postMessage failed: ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    // 240-char cap (DEFAULT_ERROR_BODY_CAP) + short prefix — the raw
    // 5000-char body must not flow unbounded into the error/logs.
    expect(message.length).toBeLessThan(300);
  });

  it("truncates a >4096-char message instead of dropping it on validation", async () => {
    let sentText = "";
    const provider = new SlackProvider({
      fetch: async (_url, init) => {
        sentText = (JSON.parse(String(init?.body)) as { text: string }).text;
        return fakeJsonResponse({ channel: "C123", ok: true, ts: "1700000000.000100" });
      },
      token: "xoxb-test"
    });
    const receipt = await provider.send({ destination: "C123", text: "Z".repeat(5000) });
    expect(sentText.length).toBe(4096);
    expect(sentText.endsWith("… [truncated]")).toBe(true);
    expect(receipt).toMatchObject({ providerId: "slack" });
  });
});

describe("slack-after-store", () => {
  it("readSlackAfter returns undefined when the file is missing or malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-after-"));
    expect(await readSlackAfter(join(dir, "missing.json"), "C-1")).toBeUndefined();
    const garbage = join(dir, "garbage.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(garbage, "not json", "utf8");
    expect(await readSlackAfter(garbage, "C-1")).toBeUndefined();
  });

  it("write+read round-trips per-channel cursors without collision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-after-"));
    const file = join(dir, "after.json");
    await writeSlackAfter(file, "C-A", "1700000000.000100");
    await writeSlackAfter(file, "C-B", "1700000001.000200");
    await writeSlackAfter(file, "C-A", "1700000099.999999"); // overwrite C-A
    expect(await readSlackAfter(file, "C-A")).toBe("1700000099.999999");
    expect(await readSlackAfter(file, "C-B")).toBe("1700000001.000200");
    expect(await readSlackAfter(file, "C-missing")).toBeUndefined();
  });

  it("writeSlackAfter persists the file with mode 0o600 (the sidecar names every Slack channel polled + ts cursor)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-after-"));
    const file = join(dir, "after.json");
    await writeSlackAfter(file, "C-1", "1700000000.000100");
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode, "slack-after sidecar must be user-only, matching the credential store + inbound-thread-store convention").toBe(0o600);
  });
});

describe("SlackProvider.fetchInbound inbox-file branch", () => {
  it("when inboxFile is configured, fetchInbound reads from the persisted store and does not hit Slack API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-inbox-"));
    const inboxFile = join(dir, "slack-inbox.json");
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(inboxFile, JSON.stringify({
      inbox: [
        { messageId: "1700000001.000100", providerId: "slack", receivedAtIso: "2026-05-11T00:00:00Z", source: "C-A", text: "in C-A" },
        { messageId: "1700000002.000200", providerId: "slack", receivedAtIso: "2026-05-11T00:01:00Z", source: "C-B", text: "in C-B" },
        { messageId: "1700000003.000300", providerId: "slack", receivedAtIso: "2026-05-11T00:02:00Z", source: "C-A", text: "in C-A again" }
      ],
      version: 1
    }), "utf8");
    let fetchCalls = 0;
    const provider = new SlackProvider({
      fetch: async () => { fetchCalls += 1; return fakeJsonResponse({ messages: [], ok: true }); },
      inboxFile,
      token: "x"
    });
    // No `source` → all channels (newest-first).
    const all = await provider.fetchInbound({ limit: 10 });
    expect(all.map((m) => m.messageId)).toEqual(["1700000003.000300", "1700000002.000200", "1700000001.000100"]);
    // With `source` → filtered to that channel.
    const onlyA = await provider.fetchInbound({ limit: 10, source: "C-A" });
    expect(onlyA.map((m) => m.messageId)).toEqual(["1700000003.000300", "1700000001.000100"]);
    expect(fetchCalls).toBe(0);
  });

  it("pollUpdates still hits Slack API even when inboxFile is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-poll-with-inbox-"));
    const inboxFile = join(dir, "slack-inbox.json");
    let seenBody = "";
    const provider = new SlackProvider({
      fetch: async (_url, init) => {
        seenBody = String(init?.body ?? "");
        return fakeJsonResponse({ messages: [], ok: true });
      },
      inboxFile,
      token: "x"
    });
    await provider.pollUpdates({ source: "C-1" });
    expect(seenBody).toContain("channel=C-1");
  });
});

describe("SlackProvider.pollUpdates", () => {
  it("without afterFile, polls without oldest= (snapshot mode)", async () => {
    let seenBody = "";
    const provider = new SlackProvider({
      fetch: async (_url, init) => {
        seenBody = String(init?.body ?? "");
        return fakeJsonResponse({ messages: [], ok: true });
      },
      token: "x"
    });
    await provider.pollUpdates({ source: "C-9" });
    expect(seenBody).not.toContain("oldest=");
  });

  it("with afterFile, passes oldest=<stored> and advances to the newest ts by parseFloat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-poll-"));
    const afterFile = join(dir, "after.json");
    await writeSlackAfter(afterFile, "C-9", "1700000000.000100");
    let seenBody = "";
    const provider = new SlackProvider({
      afterFile,
      fetch: async (_url, init) => {
        seenBody = String(init?.body ?? "");
        return fakeJsonResponse({
          messages: [
            // Newest-first response. Mix microsecond precision to
            // exercise parseFloat comparison.
            { text: "newest", ts: "1700000099.999999", user: "U1" },
            { text: "older", ts: "1700000050.500000", user: "U1" }
          ],
          ok: true
        });
      },
      token: "x"
    });
    const inbound = await provider.pollUpdates({ source: "C-9" });
    expect(seenBody).toContain("oldest=1700000000.000100");
    expect(inbound).toHaveLength(2);
    expect(await readSlackAfter(afterFile, "C-9")).toBe("1700000099.999999");
  });

  it("with afterFile, empty response leaves the cursor untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-empty-"));
    const afterFile = join(dir, "after.json");
    await writeSlackAfter(afterFile, "C-9", "1700000000.777777");
    const provider = new SlackProvider({
      afterFile,
      fetch: async () => fakeJsonResponse({ messages: [], ok: true }),
      token: "x"
    });
    await provider.pollUpdates({ source: "C-9" });
    expect(await readSlackAfter(afterFile, "C-9")).toBe("1700000000.777777");
  });

  it("rejects calls without `source` (channel id) before any HTTP", async () => {
    let calls = 0;
    const provider = new SlackProvider({
      fetch: async () => { calls += 1; return fakeJsonResponse({ messages: [], ok: true }); },
      token: "x"
    });
    await expect(provider.pollUpdates()).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
      message: expect.stringContaining("source")
    });
    expect(calls).toBe(0);
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

  it("times out a stalled push so a wedged LINE API connection can't hang the send path (timeoutMs threaded into fetchWithTimeout) — completes the messaging-provider timeout sweep", async () => {
    const neverResolves: typeof globalThis.fetch = (_input, init) =>
      (() => {
        const pending = Promise.withResolvers<Response>();
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => pending.reject(new DOMException("aborted", "AbortError")), { once: true });
        return pending.promise;
      })();
    const provider = new LineProvider({ fetch: neverResolves, timeoutMs: 10, token: "ch-token" });
    await expect(provider.send({ destination: "U-1", text: "hi" })).rejects.toThrow(/timed out after 10ms/u);
  });

  it("bounds a huge upstream error body in the thrown message (parity with Telegram/Discord)", async () => {
    const provider = new LineProvider({
      fetch: async () => new Response("X".repeat(5000), { status: 502 }),
      now: () => new Date("2026-05-10T08:00:00Z"),
      token: "x"
    });
    let caught: unknown;
    await provider.send({ destination: "U-1", text: "hi" }).catch((error: unknown) => { caught = error; });
    const message = (caught as { message: string }).message;
    expect(message.startsWith("LINE pushMessage failed: ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    expect(message.length).toBeLessThan(300);
  });

  it("truncates a >4096-char message instead of dropping it on validation", async () => {
    let sentText = "";
    const provider = new LineProvider({
      fetch: async (_url, init) => {
        sentText = (JSON.parse(String(init?.body)) as { messages: { text: string }[] }).messages[0]!.text;
        return new Response("{}", { status: 200 });
      },
      now: () => new Date("2026-05-10T08:00:00Z"),
      token: "ch-token"
    });
    const receipt = await provider.send({ destination: "U-123", text: "Z".repeat(5000) });
    expect(sentText.length).toBe(4096);
    expect(sentText.endsWith("… [truncated]")).toBe(true);
    expect(receipt).toMatchObject({ providerId: "line" });
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

  it("writeTelegramOffset persists the file with mode 0o600 (the sidecar reveals which bot updates this process has acknowledged)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-offset-"));
    const file = join(dir, "offset.json");
    await writeTelegramOffset(file, 42);
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode, "telegram offset sidecar must be user-only, matching the credential store + inbound-thread-store convention").toBe(0o600);
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

describe("isRetryableMessagingStatus", () => {
  it("classifies 429 + 5xx as retryable, everything else as fail-fast", () => {
    expect(isRetryableMessagingStatus(429)).toBe(true);
    expect(isRetryableMessagingStatus(500)).toBe(true);
    expect(isRetryableMessagingStatus(502)).toBe(true);
    expect(isRetryableMessagingStatus(599)).toBe(true);
    // 4xx other than 429: caller's problem.
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetryableMessagingStatus(s)).toBe(false);
    }
    // 2xx/3xx: success path — shouldn't be asked.
    expect(isRetryableMessagingStatus(200)).toBe(false);
    expect(isRetryableMessagingStatus(301)).toBe(false);
    // Out-of-spec, NaN, undefined.
    expect(isRetryableMessagingStatus(600)).toBe(false);
    expect(isRetryableMessagingStatus(Number.NaN)).toBe(false);
    expect(isRetryableMessagingStatus(undefined)).toBe(false);
  });

  it("MessagingProviderError carries retryable derived from status", () => {
    expect(new MessagingProviderError("telegram", "UPSTREAM_FAILED", "boom", 429).retryable).toBe(true);
    expect(new MessagingProviderError("telegram", "UPSTREAM_FAILED", "boom", 502).retryable).toBe(true);
    expect(new MessagingProviderError("telegram", "UPSTREAM_FAILED", "boom", 401).retryable).toBe(false);
    // Non-HTTP codes (no status) → not retryable.
    expect(new MessagingProviderError("telegram", "PROVIDER_NOT_FOUND", "not found").retryable).toBe(false);
    expect(new MessagingProviderError("telegram", "INVALID_DESTINATION", "bad dest").retryable).toBe(false);
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

  it("the unknown-id error names the registered providers so a misconfigured daemon is recoverable", () => {
    const empty = new MessagingProviderRegistry();
    expect(() => empty.require("telegram")).toThrow(/none registered/u);

    const tg = new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async () => fakeJsonResponse({ ok: true, result: { message_id: 1 } }),
      token: "x"
    });
    const registry = new MessagingProviderRegistry([tg]);
    expect(() => registry.require("telgram")).toThrow(/registered: telegram/u);
  });

  it("scrubs credential shapes from outbound text at the dispatch chokepoint", async () => {
    // Capture the text the provider actually sees so the assertion
    // pins the *post-redaction* form, not the pre-call form.
    let receivedText: string | undefined;
    const stub = {
      describe: () => ({ description: "stub", displayName: "Stub", id: "stub" }),
      id: "stub",
      send: async (message: { destination: string; text: string }) => {
        receivedText = message.text;
        return { destination: message.destination, messageId: "ok-1", providerId: "stub" };
      }
    } as unknown as Parameters<typeof MessagingProviderRegistry.prototype.register>[0];
    const registry = new MessagingProviderRegistry([stub]);

    await registry.send("stub", {
      destination: "@me",
      text: "rotate sk-proj-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyzABCDEF today"
    });

    // Provider receives the scrubbed form — verbatim secrets MUST NOT
    // hit Telegram / Discord / Slack / LINE / macOS Notification banner.
    expect(receivedText).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect(receivedText).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(receivedText).toContain("[redacted-openai-key]");
    expect(receivedText).toContain("[redacted-github-pat]");
    // Non-credential context survives so the human still gets the
    // surrounding sentence.
    expect(receivedText).toContain("rotate ");
    expect(receivedText).toContain("today");
  });

  it("leaves clean text unchanged (no double-flagging the proactive scrub)", async () => {
    let receivedText: string | undefined;
    const stub = {
      describe: () => ({ description: "stub", displayName: "Stub", id: "stub" }),
      id: "stub",
      send: async (message: { destination: string; text: string }) => {
        receivedText = message.text;
        return { destination: message.destination, messageId: "ok-2", providerId: "stub" };
      }
    } as unknown as Parameters<typeof MessagingProviderRegistry.prototype.register>[0];
    const registry = new MessagingProviderRegistry([stub]);

    await registry.send("stub", { destination: "@me", text: "Q3 budget memo due in 5 min" });
    expect(receivedText).toBe("Q3 budget memo due in 5 min");
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

  it("appendInbound ignores a webhook redelivery with the same provider, source, and message id", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-redelivery-"));
    const file = join(root, "inbox.json");
    await appendInbound(file, makeMessage({ messageId: "redelivery-1", text: "original" }));
    await appendInbound(file, makeMessage({ messageId: "redelivery-1", text: "duplicate delivery" }));

    expect(await readInbox(file)).toMatchObject([{ messageId: "redelivery-1", text: "original" }]);
  });

  it("retains webhook delivery receipts after inbox capacity evicts the original message", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-receipt-"));
    const file = join(root, "inbox.json");
    await appendInbound(file, makeMessage({ messageId: "evicted", text: "original" }), {
      capacity: 1,
      idempotencyKey: "line:event-1"
    });
    await appendInbound(file, makeMessage({ messageId: "new", text: "newest" }), {
      capacity: 1,
      idempotencyKey: "line:event-2"
    });

    await expect(appendInbound(file, makeMessage({ messageId: "evicted", text: "redelivery" }), {
      capacity: 1,
      idempotencyKey: "line:event-1"
    })).resolves.toBe(false);
    expect(await readInbox(file)).toMatchObject([{ messageId: "new", text: "newest" }]);
  });

  it("backfills a delivery receipt when a legacy inbox entry is redelivered", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-receipt-migration-"));
    const file = join(root, "inbox.json");
    await appendInbound(file, makeMessage({ messageId: "legacy", text: "original" }), { capacity: 1 });

    await expect(appendInbound(file, makeMessage({ messageId: "legacy", text: "redelivery" }), {
      capacity: 1,
      idempotencyKey: "line:legacy-event"
    })).resolves.toBe(false);
    await appendInbound(file, makeMessage({ messageId: "new", text: "newest" }), {
      capacity: 1,
      idempotencyKey: "line:new-event"
    });

    await expect(appendInbound(file, makeMessage({ messageId: "legacy", text: "late redelivery" }), {
      capacity: 1,
      idempotencyKey: "line:legacy-event"
    })).resolves.toBe(false);
    expect(await readInbox(file)).toMatchObject([{ messageId: "new", text: "newest" }]);
  });

  it("appendInbound persists inbound bodies with 0600 perms (not world-readable)", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-perm-"));
    const file = join(root, "inbox.json");
    await appendInbound(file, makeMessage({ messageId: "1", text: "my bank pin is 1234" }));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // A second append rewrites the file — perms must stay 0600.
    await appendInbound(file, makeMessage({ messageId: "2", text: "second" }));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("appendInbound serializes concurrent writes so two simultaneous webhook invocations can't both read the same snapshot and clobber each other's append — every message lands, none lost to the read-modify-write race", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-inbox-concurrent-"));
    const file = join(root, "inbox.json");
    const CONCURRENT = 20;
    await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        appendInbound(file, makeMessage({ messageId: `concurrent-${i.toString()}`, text: `body ${i.toString()}` }))
      )
    );
    const out = await readInbox(file);
    expect(out).toHaveLength(CONCURRENT);
    const ids = new Set(out.map((m) => m.messageId));
    expect(ids.size).toBe(CONCURRENT);
    for (let i = 0; i < CONCURRENT; i += 1) {
      expect(ids.has(`concurrent-${i.toString()}`)).toBe(true);
    }
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

  it("persists credentials with file mode 0600 (defense-in-depth on shared boxes)", async () => {
    if (process.platform === "win32") {
      // POSIX mode bits don't exist on Windows; the constructor + writes
      // still succeed but stat().mode is meaningless. Skip the assertion.
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "muse-msg-creds-mode-"));
    const file = join(root, "messaging.json");
    const store = new FileMessagingCredentialStore(file);
    await store.save("telegram", { token: "secret-bot-token" });
    const { statSync } = await import("node:fs");
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("is prototype-safe: a providerId like __proto__ / toString never false-hits Object.prototype", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-msg-creds-proto-"));
    const store = new FileMessagingCredentialStore(join(root, "messaging.json"));
    // Fresh store: these must be undefined, NOT a bogus inherited {} — the
    // providers map is null-prototype so an Object.prototype member name
    // can't be indexed (regression: a plain {} returned {} here).
    expect(await store.load("__proto__")).toBeUndefined();
    expect(await store.load("toString")).toBeUndefined();
    expect(await store.load("constructor")).toBeUndefined();
    // Survives the persisted-reparse path and round-trips as an ordinary key
    // without polluting siblings.
    await store.save("telegram", { token: "real" });
    expect(await store.load("toString")).toBeUndefined();
    await store.save("__proto__", { token: "x" });
    expect(await store.load("__proto__")).toEqual({ token: "x" });
    expect(await store.load("toString")).toBeUndefined();
    expect(await store.list()).toEqual(["__proto__", "telegram"]);
  });
});
