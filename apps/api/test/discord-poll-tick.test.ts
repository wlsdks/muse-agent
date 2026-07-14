import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { DiscordProvider, InboundFetchOptions, InboundMessage } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { parseDiscordPollChannels, startDiscordPollTick } from "../src/discord-poll-tick.js";

function makeMessage(messageId: string, source: string, text: string): InboundMessage {
  return {
    messageId,
    providerId: "discord",
    receivedAtIso: "2026-05-11T00:00:00.000Z",
    source,
    text
  };
}

/**
 * Per-channel script: each call to pollUpdates(source) consumes one
 * entry from the channel's queue. Lets a test thread distinct
 * responses (or errors) per channel without stubbing the registry.
 */
function fakeProvider(scripts: Record<string, readonly (readonly InboundMessage[] | Error)[]>): DiscordProvider {
  const cursors: Record<string, number> = {};
  return {
    pollUpdates: async (options?: InboundFetchOptions) => {
      const source = options?.source ?? "";
      const script = scripts[source] ?? [];
      const idx = cursors[source] ?? 0;
      cursors[source] = idx + 1;
      const next = script[idx] ?? [];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }
  } as unknown as DiscordProvider;
}

describe("parseDiscordPollChannels", () => {
  it("returns undefined for missing or blank input", () => {
    expect(parseDiscordPollChannels(undefined)).toBeUndefined();
    expect(parseDiscordPollChannels("")).toBeUndefined();
    expect(parseDiscordPollChannels("   ")).toBeUndefined();
    expect(parseDiscordPollChannels(",,,")).toBeUndefined();
  });

  it("splits on comma, trims, drops empties", () => {
    expect(parseDiscordPollChannels("ch-1")).toEqual(["ch-1"]);
    expect(parseDiscordPollChannels("ch-1, ch-2 ,ch-3,")).toEqual(["ch-1", "ch-2", "ch-3"]);
  });
});

describe("startDiscordPollTick", () => {
  it("tickOnce iterates every channel and appends each message to the inbox file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-poll-"));
    const inboxFile = join(dir, "discord-inbox.json");
    const logged: string[] = [];
    const handle = startDiscordPollTick({
      channels: ["ch-1", "ch-2"],
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider({
        "ch-1": [[makeMessage("1", "ch-1", "hi")]],
        "ch-2": [[makeMessage("2", "ch-2", "yo"), makeMessage("3", "ch-2", "hey")]]
      })
    });
    try {
      await handle.tickOnce();
      const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as { inbox: InboundMessage[] };
      expect(inbox.inbox.map((m) => m.messageId).sort()).toEqual(["1", "2", "3"]);
      expect(logged).toEqual(["discord-poll: ingested 3 message(s) across 2 channel(s)"]);
    } finally {
      handle.stop();
    }
  });

  it("empty fetches across all channels is a no-op: no file write, no log line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-empty-"));
    const inboxFile = join(dir, "discord-inbox.json");
    const logged: string[] = [];
    const handle = startDiscordPollTick({
      channels: ["ch-1"],
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider({ "ch-1": [[]] })
    });
    try {
      await handle.tickOnce();
      expect(logged).toEqual([]);
      expect(() => readFileSync(inboxFile, "utf8")).toThrow();
    } finally {
      handle.stop();
    }
  });

  it("a single bad channel doesn't poison the tick: error logged, other channels still poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-mixed-"));
    const inboxFile = join(dir, "discord-inbox.json");
    const errors: string[] = [];
    const handle = startDiscordPollTick({
      channels: ["ch-bad", "ch-ok"],
      errorLogger: (m) => errors.push(m),
      inboxFile,
      provider: fakeProvider({
        "ch-bad": [new Error("Missing Access")],
        "ch-ok": [[makeMessage("9", "ch-ok", "still works")]]
      })
    });
    try {
      await handle.tickOnce();
      const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as { inbox: InboundMessage[] };
      expect(inbox.inbox.map((m) => m.messageId)).toEqual(["9"]);
      expect(errors.some((e) => e.includes("ch-bad") && e.includes("Missing Access"))).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it("single-flight: overlapping ticks don't double-poll the same channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-disc-overlap-"));
    const inboxFile = join(dir, "discord-inbox.json");
    let calls = 0;
    let inflight = 0;
    let peak = 0;
    const slowProvider: DiscordProvider = {
      pollUpdates: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        calls += 1;
        inflight -= 1;
        return [];
      }
    } as unknown as DiscordProvider;
    const handle = startDiscordPollTick({
      channels: ["ch-1", "ch-2"],
      inboxFile,
      provider: slowProvider
    });
    try {
      await Promise.all([handle.tickOnce(), handle.tickOnce()]);
      // Only one full iteration ran (2 channels × 1 tick = 2 calls).
      expect(calls).toBe(2);
      expect(peak).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
