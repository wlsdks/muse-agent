import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { InboundFetchOptions, InboundMessage, SlackProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { parseSlackPollChannels, startSlackPollTick } from "../src/slack-poll-tick.js";

function makeMessage(messageId: string, source: string, text: string): InboundMessage {
  return {
    messageId,
    providerId: "slack",
    receivedAtIso: "2026-05-11T00:00:00.000Z",
    source,
    text
  };
}

function fakeProvider(scripts: Record<string, readonly (readonly InboundMessage[] | Error)[]>): SlackProvider {
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
  } as unknown as SlackProvider;
}

describe("parseSlackPollChannels", () => {
  it("returns undefined for missing or blank input", () => {
    expect(parseSlackPollChannels(undefined)).toBeUndefined();
    expect(parseSlackPollChannels("")).toBeUndefined();
    expect(parseSlackPollChannels("   ")).toBeUndefined();
    expect(parseSlackPollChannels(",,,")).toBeUndefined();
  });

  it("splits on comma, trims, drops empties", () => {
    expect(parseSlackPollChannels("C0123ABCD")).toEqual(["C0123ABCD"]);
    expect(parseSlackPollChannels("C0123ABCD, C0456EFGH ,C0789IJKL,")).toEqual(["C0123ABCD", "C0456EFGH", "C0789IJKL"]);
  });
});

describe("startSlackPollTick", () => {
  it("tickOnce iterates every channel and appends each message to the inbox file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-poll-"));
    const inboxFile = join(dir, "slack-inbox.json");
    const logged: string[] = [];
    const handle = startSlackPollTick({
      channels: ["C-A", "C-B"],
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider({
        "C-A": [[makeMessage("1700000001.000100", "C-A", "hi")]],
        "C-B": [[makeMessage("1700000002.000200", "C-B", "yo"), makeMessage("1700000003.000300", "C-B", "hey")]]
      })
    });
    try {
      await handle.tickOnce();
      const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as { inbox: InboundMessage[] };
      expect(inbox.inbox.map((m) => m.messageId).sort()).toEqual([
        "1700000001.000100",
        "1700000002.000200",
        "1700000003.000300"
      ]);
      expect(logged).toEqual(["slack-poll: ingested 3 message(s) across 2 channel(s)"]);
    } finally {
      handle.stop();
    }
  });

  it("empty fetches across all channels is a no-op: no file write, no log line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-empty-"));
    const inboxFile = join(dir, "slack-inbox.json");
    const logged: string[] = [];
    const handle = startSlackPollTick({
      channels: ["C-A"],
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider({ "C-A": [[]] })
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
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-mixed-"));
    const inboxFile = join(dir, "slack-inbox.json");
    const errors: string[] = [];
    const handle = startSlackPollTick({
      channels: ["C-bad", "C-ok"],
      errorLogger: (m) => errors.push(m),
      inboxFile,
      provider: fakeProvider({
        "C-bad": [new Error("channel_not_found")],
        "C-ok": [[makeMessage("1700000010.000000", "C-ok", "still works")]]
      })
    });
    try {
      await handle.tickOnce();
      const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as { inbox: InboundMessage[] };
      expect(inbox.inbox.map((m) => m.messageId)).toEqual(["1700000010.000000"]);
      expect(errors.some((e) => e.includes("C-bad") && e.includes("channel_not_found"))).toBe(true);
    } finally {
      handle.stop();
    }
  });

  it("single-flight: overlapping ticks don't double-poll the same channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-slack-overlap-"));
    const inboxFile = join(dir, "slack-inbox.json");
    let calls = 0;
    let inflight = 0;
    let peak = 0;
    const slowProvider: SlackProvider = {
      pollUpdates: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        calls += 1;
        inflight -= 1;
        return [];
      }
    } as unknown as SlackProvider;
    const handle = startSlackPollTick({
      channels: ["C-A", "C-B"],
      inboxFile,
      provider: slowProvider
    });
    try {
      await Promise.all([handle.tickOnce(), handle.tickOnce()]);
      expect(calls).toBe(2);
      expect(peak).toBe(1);
    } finally {
      handle.stop();
    }
  });
});
