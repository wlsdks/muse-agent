import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startTelegramPollTick } from "../src/telegram-poll-tick.js";

import type { InboundMessage, TelegramProvider } from "@muse/messaging";

function makeMessage(messageId: string): InboundMessage {
  return {
    messageId,
    providerId: "telegram",
    receivedAtIso: "2026-07-11T00:00:00.000Z",
    source: "999",
    text: `m${messageId}`
  };
}

describe("startTelegramPollTick long-poll mode", () => {
  it("passes longPollSeconds to the provider and immediately re-polls (no interval wait)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-lp-"));
    const seenOptions: unknown[] = [];
    let calls = 0;
    const provider = {
      pollUpdates: async (options?: unknown) => {
        seenOptions.push(options);
        calls += 1;
        return calls === 1 ? [makeMessage("1")] : [];
      }
    } as unknown as TelegramProvider;

    const handle = startTelegramPollTick({
      inboxFile: join(dir, "inbox.json"),
      intervalMs: 60_000,
      longPollSeconds: 25,
      provider,
      relaunchDelayMs: 5
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    handle.stop();

    // With a 60s interval, >1 call proves the continuous loop re-polled on
    // its own instead of waiting for the timer.
    expect(calls).toBeGreaterThan(1);
    expect(seenOptions[0]).toMatchObject({ longPollSeconds: 25 });
  });

  it("fires onIngested with the count when messages land, and not on empty polls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-lp2-"));
    let calls = 0;
    const provider = {
      pollUpdates: async () => {
        calls += 1;
        return calls === 1 ? [makeMessage("1"), makeMessage("2")] : [];
      }
    } as unknown as TelegramProvider;

    const ingests: number[] = [];
    const handle = startTelegramPollTick({
      inboxFile: join(dir, "inbox.json"),
      intervalMs: 60_000,
      longPollSeconds: 25,
      onIngested: (count) => {
        ingests.push(count);
      },
      provider,
      relaunchDelayMs: 5
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    handle.stop();

    expect(ingests).toEqual([2]);
  });

  it("stop() halts the continuous loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-lp3-"));
    let calls = 0;
    const provider = {
      pollUpdates: async () => {
        calls += 1;
        return [];
      }
    } as unknown as TelegramProvider;

    const handle = startTelegramPollTick({
      inboxFile: join(dir, "inbox.json"),
      longPollSeconds: 25,
      provider,
      relaunchDelayMs: 5
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls).toBe(after);
  });
});
