import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInbox } from "@muse/messaging";
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

    expect(calls).toEqual([{ limit: 50, source: "c1" }, { limit: 50, source: "c2" }]);
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
    expect(calls).toEqual([{ source: "only" }]);
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
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return [];
        }
      }
    });
    await Promise.all([handle.tickOnce(), handle.tickOnce()]);
    handle.stop();
    expect(maxActive).toBe(1);
  });
});
