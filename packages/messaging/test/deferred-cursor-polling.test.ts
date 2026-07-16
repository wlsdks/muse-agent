import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readDiscordAfter } from "../src/discord-after-store.js";
import { DiscordProvider } from "../src/discord-provider.js";
import { readSlackAfter } from "../src/slack-after-store.js";
import { SlackProvider } from "../src/slack-provider.js";

describe("deferred polling cursor commits", () => {
  it("keeps a Discord cursor pending until a durable consumer commits it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-discord-deferred-cursor-"));
    const afterFile = join(directory, "after.json");
    const provider = new DiscordProvider({
      afterFile,
      fetch: async () => new Response(JSON.stringify([{
        content: "persist me",
        id: "1234567890123456789",
        timestamp: "2026-07-16T00:00:00.000Z"
      }])),
      token: "test"
    });

    try {
      await provider.pollUpdates({ deferCursorCommit: true, source: "channel-1" });
      expect(await readDiscordAfter(afterFile, "channel-1")).toBeUndefined();
      await provider.commitPolledInbound({ source: "channel-1" });
      expect(await readDiscordAfter(afterFile, "channel-1")).toBe("1234567890123456789");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps a Slack cursor pending until a durable consumer commits it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-slack-deferred-cursor-"));
    const afterFile = join(directory, "after.json");
    const provider = new SlackProvider({
      afterFile,
      fetch: async () => new Response(JSON.stringify({
        messages: [{ text: "persist me", ts: "1700000000.000001" }],
        ok: true
      })),
      token: "test"
    });

    try {
      await provider.pollUpdates({ deferCursorCommit: true, source: "C1" });
      expect(await readSlackAfter(afterFile, "C1")).toBeUndefined();
      await provider.commitPolledInbound({ source: "C1" });
      expect(await readSlackAfter(afterFile, "C1")).toBe("1700000000.000001");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
