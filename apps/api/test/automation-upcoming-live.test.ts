import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  DiscordProvider,
  MessagingProviderRegistry,
  SlackProvider,
  type MessagingProvider,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import type { ModelProvider } from "@muse/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

const NOW = new Date("2026-08-08T08:00:00.000Z");

function localProvider(send: (message: OutboundMessage) => Promise<OutboundReceipt>): MessagingProvider {
  return {
    describe: () => ({ description: "local test provider", displayName: "Local test gateway", id: "log", local: true }),
    id: "log",
    send
  };
}

interface RootEntrySnapshot {
  readonly byteLength: number | null;
  readonly contentSha256: string | null;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly path: string;
  readonly type: "directory" | "file" | "other";
}

async function snapshotRoot(root: string): Promise<readonly RootEntrySnapshot[]> {
  const snapshots: RootEntrySnapshot[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      const isFile = stats.isFile();
      const isDirectory = stats.isDirectory();
      const content = isFile ? await readFile(absolutePath) : undefined;
      snapshots.push({
        byteLength: content?.byteLength ?? null,
        contentSha256: content ? createHash("sha256").update(content).digest("hex") : null,
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
        path: relative(root, absolutePath),
        type: isDirectory ? "directory" : isFile ? "file" : "other"
      });
      if (isDirectory) {
        await visit(absolutePath);
      }
    }
  }

  await visit(root);
  return snapshots;
}

describe("assembled GET /api/automation/upcoming", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the live explicit Gateway and digest config without model, send, or file work", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["clearInterval", "Date", "setInterval"] });
    const root = mkdtempSync(join(tmpdir(), "muse-automation-upcoming-live-"));
    const send = vi.fn(async (message: OutboundMessage): Promise<OutboundReceipt> => ({
      destination: message.destination,
      messageId: "unused",
      providerId: "log"
    }));
    const generate = vi.fn(async () => ({ output: "unused" }));
    const registry = new MessagingProviderRegistry([localProvider(send)]);
    const authService = createAuthService();
    const registered = authService.register({
      email: "automation-upcoming-owner",
      name: "Automation owner",
      password: "password-1"
    });
    const env = {
      HOME: root,
      MUSE_CHANNEL_OWNERS_FILE: join(root, "channel-owners.json"),
      MUSE_DAEMON_DELIVERY_ENABLED: "true",
      MUSE_DIGEST_ENABLED: "true",
      MUSE_DIGEST_HOUR: "9",
      MUSE_DIGEST_QUEUE_FILE: join(root, "digest-queue.json"),
      MUSE_DIGEST_SENT_FILE: join(root, "digest-sent.json"),
      MUSE_DIGEST_TICK_MS: "60000",
      MUSE_INTERRUPTION_LEDGER_FILE: join(root, "interruption-ledger.json"),
      MUSE_LOCAL_ONLY: "true",
      MUSE_PROACTIVE_DESTINATION: "desktop",
      MUSE_PROACTIVE_PROVIDER: "log",
      MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "false"
    };
    await Promise.all([
      writeFile(env.MUSE_CHANNEL_OWNERS_FILE, '{"owners":{},"version":1}\n'),
      writeFile(env.MUSE_DIGEST_QUEUE_FILE, '{"queued":[]}\n'),
      writeFile(env.MUSE_DIGEST_SENT_FILE, '{"lastSentDate":"2026-08-07"}\n'),
      writeFile(env.MUSE_INTERRUPTION_LEDGER_FILE, '{"deliveries":[]}\n')
    ]);
    const modelProvider = { generate } as unknown as ModelProvider;
    const server = buildServer({
      authService,
      defaultModel: "test/model",
      env,
      logger: false,
      messaging: registry,
      modelProvider,
      requireAuth: true
    });
    try {
      const unauthenticated = await server.inject({ method: "GET", url: "/api/automation/upcoming" });
      expect(unauthenticated.statusCode).toBe(401);
      const beforeSnapshot = await snapshotRoot(root);

      const response = await server.inject({
        headers: { authorization: `Bearer ${registered.token}` },
        method: "GET",
        url: "/api/automation/upcoming"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        digest: { enabled: true, hour: 9 },
        digestRuntime: {
          availability: "dormant",
          lastDecision: "startup",
          phase: "startup"
        },
        gateway: {
          destination: "desktop",
          localOnly: true,
          providerId: "log",
          reason: null,
          source: "explicit-config",
          status: "resolved"
        }
      });
      expect(typeof response.json().digest.nextAtIso).toBe("string");
      expect(generate).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await expect(snapshotRoot(root)).resolves.toEqual(beforeSnapshot);
    } finally {
      await server.close();
    }

    expect(vi.getTimerCount()).toBe(0);
  });

  it("projects live Slack and Discord poll handles through the channel supervisor", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-automation-channel-runtime-"));
    const authService = createAuthService();
    const registered = authService.register({
      email: "channel-runtime-owner",
      name: "Channel runtime owner",
      password: "password-1"
    });
    const env = {
      HOME: root,
      MUSE_CHANNEL_OWNERS_FILE: join(root, "channel-owners.json"),
      MUSE_DISCORD_POLL_CHANNELS: "discord-channel",
      MUSE_DISCORD_POLL_ENABLED: "true",
      MUSE_DISCORD_POLL_INTERVAL_MS: "3600000",
      MUSE_INTERRUPTION_LEDGER_FILE: join(root, "interruption-ledger.json"),
      MUSE_SLACK_POLL_CHANNELS: "slack-channel",
      MUSE_SLACK_POLL_ENABLED: "true",
      MUSE_SLACK_POLL_INTERVAL_MS: "3600000"
    };
    const slack = new SlackProvider({
      afterFile: join(root, "slack-after.json"),
      fetch: async () => new Response(JSON.stringify({ messages: [], ok: true })),
      inboxFile: join(root, "slack-inbox.json"),
      token: "test-slack-token"
    });
    const discord = new DiscordProvider({
      afterFile: join(root, "discord-after.json"),
      fetch: async () => new Response(JSON.stringify([])),
      inboxFile: join(root, "discord-inbox.json"),
      token: "test-discord-token"
    });
    const server = buildServer({
      authService,
      env,
      logger: false,
      messaging: new MessagingProviderRegistry([slack, discord]),
      requireAuth: true,
      slackInboxFile: join(root, "slack-inbox.json"),
      discordInboxFile: join(root, "discord-inbox.json")
    });

    try {
      const response = await server.inject({
        headers: { authorization: `Bearer ${registered.token}` },
        method: "GET",
        url: "/api/automation/upcoming"
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().channelRuntime).toEqual({
        daemons: [
          {
            hasError: false,
            kind: "slack-poll",
            lastErrorAtIso: null,
            lastIngestAtIso: null,
            lastIngestCount: null,
            running: true
          },
          {
            hasError: false,
            kind: "discord-poll",
            lastErrorAtIso: null,
            lastIngestAtIso: null,
            lastIngestCount: null,
            running: true
          }
        ],
        status: "observed"
      });
    } finally {
      await server.close();
    }
  });

  it("surfaces the real digest tick decision through buildServer without waiting on wall time", async () => {
    const tickNow = new Date(2026, 7, 8, 9, 0, 0);
    vi.useFakeTimers({ now: tickNow, toFake: ["clearInterval", "Date", "setInterval"] });
    const root = mkdtempSync(join(tmpdir(), "muse-automation-upcoming-runtime-"));
    const digestQueueFile = join(root, "digest-queue.json");
    const send = vi.fn(async (message: OutboundMessage): Promise<OutboundReceipt> => ({
      destination: message.destination,
      messageId: "sent",
      providerId: "log"
    }));
    const registry = new MessagingProviderRegistry([localProvider(send)]);
    const authService = createAuthService();
    const registered = authService.register({
      email: "automation-upcoming-runtime-owner",
      name: "Automation runtime owner",
      password: "password-1"
    });
    const env = {
      HOME: root,
      MUSE_CHANNEL_OWNERS_FILE: join(root, "channel-owners.json"),
      MUSE_DAEMON_DELIVERY_ENABLED: "true",
      MUSE_DIGEST_ENABLED: "true",
      MUSE_DIGEST_HOUR: "9",
      MUSE_DIGEST_QUEUE_FILE: digestQueueFile,
      MUSE_DIGEST_SENT_FILE: join(root, "digest-sent.json"),
      MUSE_DIGEST_TICK_MS: "5000",
      MUSE_INTERRUPTION_LEDGER_FILE: join(root, "interruption-ledger.json"),
      MUSE_LOCAL_ONLY: "true",
      MUSE_PROACTIVE_DESTINATION: "desktop",
      MUSE_PROACTIVE_PROVIDER: "log",
      MUSE_SKILL_CONSOLIDATE_IDLE_ENABLED: "false"
    };
    await Promise.all([
      writeFile(env.MUSE_CHANNEL_OWNERS_FILE, '{"owners":{},"version":1}\n'),
      writeFile(digestQueueFile, '{"queued":[{"at":"2026-08-08T00:00:00.000Z","source":"test","text":"private notice"}]}\n'),
      writeFile(env.MUSE_INTERRUPTION_LEDGER_FILE, '{"deliveries":[]}\n')
    ]);
    let tickHandle: { readonly tickOnce: () => Promise<void>; readonly stop: () => void } | undefined;
    const server = buildServer({
      authService,
      digestTick: {
        now: () => tickNow,
        onHandle: (handle) => { tickHandle = handle; }
      },
      env,
      logger: false,
      messaging: registry,
      requireAuth: true
    });
    try {
      expect(tickHandle).toBeDefined();
      const before = await server.inject({
        headers: { authorization: `Bearer ${registered.token}` },
        method: "GET",
        url: "/api/automation/upcoming"
      });
      expect(before.json()).toMatchObject({
        digest: { hour: 9 },
        digestRuntime: {
          availability: "dormant",
          lastDecision: "startup",
          phase: "startup"
        }
      });

      await tickHandle!.tickOnce();
      expect(send).toHaveBeenCalledTimes(1);

      const after = await server.inject({
        headers: { authorization: `Bearer ${registered.token}` },
        method: "GET",
        url: "/api/automation/upcoming"
      });
      expect(after.json()).toMatchObject({
        digest: { hour: 9, nextAtIso: expect.any(String) },
        digestRuntime: {
          availability: "observed",
          lastDecision: "sent",
          lastErrorCount: 0,
          lastItemCount: 1,
          lastObservedAtIso: tickNow.toISOString(),
          phase: "tick"
        }
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
