/**
 * The S5 in-channel slash commands (/new /status /model /help,
 * inbound-slash-commands.ts) only autocomplete in Telegram's client if
 * the bot has called `setMyCommands` (Bot API). This covers the boot
 * wiring in server.ts: fires once when the telegram channel starts
 * polling, never per tick, and never at all when telegram isn't
 * configured.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { afterEach, describe, expect, it } from "vitest";

import { writeDaemonSetting } from "../src/daemon-settings-store.js";
import { buildServer } from "../src/server.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function fakeTelegramFetch(calls: { url: string; body: unknown }[]): typeof globalThis.fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, url: String(url) });
    return jsonResponse(200, { ok: true, result: [] });
  }) as unknown as typeof globalThis.fetch;
}

const originalDaemonSettingsFileEnv = process.env.MUSE_DAEMON_SETTINGS_FILE;
const originalLongPollEnv = process.env.MUSE_TELEGRAM_LONG_POLL_SECONDS;

afterEach(() => {
  if (originalDaemonSettingsFileEnv === undefined) {
    delete process.env.MUSE_DAEMON_SETTINGS_FILE;
  } else {
    process.env.MUSE_DAEMON_SETTINGS_FILE = originalDaemonSettingsFileEnv;
  }
  if (originalLongPollEnv === undefined) {
    delete process.env.MUSE_TELEGRAM_LONG_POLL_SECONDS;
  } else {
    process.env.MUSE_TELEGRAM_LONG_POLL_SECONDS = originalLongPollEnv;
  }
});

describe("telegram setMyCommands boot registration", () => {
  it("registers the exact command list once when the channel starts polling at boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-cmds-"));
    const daemonSettingsFile = join(dir, "daemon-settings.json");
    await writeDaemonSetting(daemonSettingsFile, "MUSE_TELEGRAM_POLL_ENABLED", true);
    process.env.MUSE_DAEMON_SETTINGS_FILE = daemonSettingsFile;
    // Interval mode (no immediate getUpdates call) keeps the boot-time
    // assertion window deterministic — only setMyCommands should fire
    // before we inspect `calls`.
    process.env.MUSE_TELEGRAM_LONG_POLL_SECONDS = "0";

    const calls: { url: string; body: unknown }[] = [];
    const registry = new MessagingProviderRegistry();
    registry.register(new TelegramProvider({ fetch: fakeTelegramFetch(calls), token: "T" }));

    const server = buildServer({
      logger: false,
      messaging: registry,
      telegramInboxFile: join(dir, "telegram-inbox.json")
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const commandCalls = calls.filter((c) => c.url.endsWith("/setMyCommands"));
      expect(commandCalls).toHaveLength(1);
      expect(commandCalls[0]?.url).toBe("https://api.telegram.org/botT/setMyCommands");
      // Hard-coded, not a re-import of TELEGRAM_BOT_COMMANDS — proves the
      // boot wiring actually reaches the Bot API with the real list.
      expect(commandCalls[0]?.body).toEqual({
        commands: [
          { command: "new", description: "Start a fresh conversation, clearing this chat's history" },
          { command: "status", description: "Show the current model, pending approvals, and turn count" },
          { command: "model", description: "Show the current default model" },
          { command: "help", description: "List available commands" }
        ]
      });
    } finally {
      await server.close();
    }
  });

  it("toggling the poll daemon off then on again does not re-register commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-cmds-toggle-"));
    const daemonSettingsFile = join(dir, "daemon-settings.json");
    await writeDaemonSetting(daemonSettingsFile, "MUSE_TELEGRAM_POLL_ENABLED", true);
    process.env.MUSE_DAEMON_SETTINGS_FILE = daemonSettingsFile;
    process.env.MUSE_TELEGRAM_LONG_POLL_SECONDS = "0";

    const calls: { url: string; body: unknown }[] = [];
    const registry = new MessagingProviderRegistry();
    registry.register(new TelegramProvider({ fetch: fakeTelegramFetch(calls), token: "T" }));

    const server = buildServer({
      logger: false,
      messaging: registry,
      telegramInboxFile: join(dir, "telegram-inbox.json")
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));

      await server.inject({
        method: "PATCH",
        payload: { enabled: false, key: "MUSE_TELEGRAM_POLL_ENABLED" },
        url: "/api/settings/daemon-flags"
      });
      await server.inject({
        method: "PATCH",
        payload: { enabled: true, key: "MUSE_TELEGRAM_POLL_ENABLED" },
        url: "/api/settings/daemon-flags"
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const commandCalls = calls.filter((c) => c.url.endsWith("/setMyCommands"));
      expect(commandCalls).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("boot without telegram configured makes zero Telegram Bot API calls", async () => {
    const originalFetch = globalThis.fetch;
    const telegramCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        telegramCalls.push(url);
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    // No `messaging` registry and no `telegramInboxFile` — the exact
    // "telegram not configured" boot shape.
    const server = buildServer({ logger: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(telegramCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});
