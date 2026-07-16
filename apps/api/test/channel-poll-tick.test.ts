import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DiscordProvider, readDiscordAfter, readInbox } from "@muse/messaging";
import type { InboundFetchOptions, InboundMessage } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePollChannelsCsv, startChannelPollTick } from "../src/channel-poll-tick.js";

describe("parsePollChannelsCsv", () => {
  it("returns undefined for missing / blank / all-empty input", () => {
    expect(parsePollChannelsCsv(undefined)).toBeUndefined();
    expect(parsePollChannelsCsv("")).toBeUndefined();
    expect(parsePollChannelsCsv("  ,, ")).toBeUndefined();
  });

  it("splits a comma list, trimming entries and dropping empties", () => {
    expect(parsePollChannelsCsv(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(parsePollChannelsCsv("solo")).toEqual(["solo"]);
  });
});

describe("startChannelPollTick", () => {
  let dir: string;
  let counter = 0;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "channel-poll-tick-"));
    counter = 0;
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const inboxFile = () => join(dir, `inbox-${counter++}.json`);
  const msg = (messageId: string, source: string): InboundMessage =>
    ({ messageId, providerId: "discord", receivedAtIso: "2026-01-01T00:00:00Z", source, text: `t-${messageId}` }) as InboundMessage;

  it("exposes a stop + tickOnce handle, and stop() does not throw", () => {
    const handle = startChannelPollTick({ channels: [], inboxFile: inboxFile(), logPrefix: "X", provider: { pollUpdates: async () => [] } });
    expect(Object.keys(handle).sort()).toEqual(["stop", "tickOnce"]);
    expect(() => handle.stop()).not.toThrow();
  });

  it("polls each channel with source + fetchLimit, ingests messages, and logs the summary", async () => {
    const calls: InboundFetchOptions[] = [];
    const logs: string[] = [];
    const file = inboxFile();
    const handle = startChannelPollTick({
      channels: ["c1", "c2"],
      fetchLimit: 50,
      inboxFile: file,
      logPrefix: "TEST",
      logger: (m) => logs.push(m),
      provider: {
        pollUpdates: async (o) => {
          calls.push(o!);
          return o!.source === "c1" ? [msg("m1", "c1"), msg("m2", "c1")] : [msg("m3", "c2")];
        }
      }
    });
    await handle.tickOnce();
    handle.stop();

    expect(calls).toEqual([
      { deferCursorCommit: true, limit: 50, source: "c1" },
      { deferCursorCommit: true, limit: 50, source: "c2" }
    ]);
    expect((await readInbox(file)).map((m) => m.messageId)).toEqual(["m3", "m2", "m1"]);
    expect(logs).toEqual(["TEST: ingested 3 message(s) across 2 channel(s)"]);
  });

  it("omits the limit when no fetchLimit is configured", async () => {
    const calls: InboundFetchOptions[] = [];
    const handle = startChannelPollTick({
      channels: ["only"],
      inboxFile: inboxFile(),
      logPrefix: "X",
      provider: { pollUpdates: async (o) => { calls.push(o!); return []; } }
    });
    await handle.tickOnce();
    handle.stop();
    expect(calls).toEqual([{ deferCursorCommit: true, source: "only" }]);
  });

  it("logs and skips a failing channel without poisoning the others", async () => {
    const errors: string[] = [];
    const file = inboxFile();
    const handle = startChannelPollTick({
      channels: ["bad", "good"],
      errorLogger: (m) => errors.push(m),
      inboxFile: file,
      logPrefix: "T2",
      provider: {
        pollUpdates: async (o) => {
          if (o!.source === "bad") throw new Error("no access");
          return [msg("ok", "good")];
        }
      }
    });
    await handle.tickOnce();
    handle.stop();

    expect(errors).toEqual(["T2: channel bad: no access"]);
    expect((await readInbox(file)).map((m) => m.messageId)).toEqual(["ok"]);
  });

  it("does not log a summary when nothing was ingested", async () => {
    const logs: string[] = [];
    const handle = startChannelPollTick({
      channels: ["x"],
      inboxFile: inboxFile(),
      logPrefix: "T3",
      logger: (m) => logs.push(m),
      provider: { pollUpdates: async () => [] }
    });
    await handle.tickOnce();
    handle.stop();
    expect(logs).toHaveLength(0);
  });

  it("is single-flight — a concurrent tickOnce returns early instead of overlapping", async () => {
    let active = 0;
    let maxActive = 0;
    const handle = startChannelPollTick({
      channels: ["a", "b"],
      inboxFile: inboxFile(),
      logPrefix: "T4",
      provider: {
        pollUpdates: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active -= 1;
          return [];
        }
      }
    });
    await Promise.all([handle.tickOnce(), handle.tickOnce()]);
    handle.stop();
    expect(maxActive).toBe(1);
  });

  it("commits a deferred provider cursor only after durable inbox storage", async () => {
    const file = inboxFile();
    const commits: number[] = [];
    const handle = startChannelPollTick({
      channels: ["c1"],
      inboxFile: file,
      logPrefix: "COMMIT",
      provider: {
        commitPolledInbound: async () => { commits.push((await readInbox(file)).length); },
        pollUpdates: async () => [msg("m1", "c1")]
      }
    });

    await handle.tickOnce();
    handle.stop();
    expect(commits).toEqual([1]);
  });

  it("does not commit a deferred provider cursor when inbox persistence fails", async () => {
    const events: string[] = [];
    const handle = startChannelPollTick({
      channels: ["c1"],
      errorLogger: (message) => events.push(`error:${message}`),
      inboxFile: dir,
      logPrefix: "FAILED",
      provider: {
        commitPolledInbound: async () => { events.push("commit"); },
        pollUpdates: async () => [msg("m1", "c1")]
      }
    });

    await handle.tickOnce();
    handle.stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("FAILED: channel c1:");
  });

  it("does not commit a stale cursor after a failed append followed by an empty poll", async () => {
    const afterFile = join(dir, "discord-after.json");
    let fetches = 0;
    const provider = new DiscordProvider({
      afterFile,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify(fetches === 1 ? [{
          content: "must not be acknowledged",
          id: "1234567890123456789",
          timestamp: "2026-07-16T00:00:00.000Z"
        }] : []));
      },
      token: "test"
    });
    const handle = startChannelPollTick({
      channels: ["c1"],
      inboxFile: dir,
      logPrefix: "STALE",
      provider
    });

    await handle.tickOnce();
    await handle.tickOnce();
    handle.stop();
    expect(await readDiscordAfter(afterFile, "c1")).toBeUndefined();
  });

  it("retries a cursor commit after storage succeeds even when the next poll is empty", async () => {
    const afterFile = join(dir, "discord-after-retry.json");
    await fs.mkdir(afterFile);
    const inboxFile = join(dir, "inbox.json");
    let fetches = 0;
    const provider = new DiscordProvider({
      afterFile,
      fetch: async () => {
        fetches += 1;
        return new Response(JSON.stringify(fetches === 1 ? [{
          content: "persisted before commit failure",
          id: "2234567890123456789",
          timestamp: "2026-07-16T00:00:00.000Z"
        }] : []));
      },
      token: "test"
    });
    const handle = startChannelPollTick({
      channels: ["c1"],
      inboxFile,
      logPrefix: "RETRY",
      provider
    });

    await handle.tickOnce();
    await fs.rm(afterFile, { force: true, recursive: true });
    await handle.tickOnce();
    handle.stop();
    expect(await readInbox(inboxFile)).toHaveLength(1);
    expect(await readDiscordAfter(afterFile, "c1")).toBe("2234567890123456789");
  });
});
