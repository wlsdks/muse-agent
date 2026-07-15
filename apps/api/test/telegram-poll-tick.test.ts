import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isErrorLike } from "@muse/shared";

import type { InboundMessage, TelegramProvider } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startTelegramPollTick } from "../src/telegram-poll-tick.js";

function makeMessage(messageId: string, text: string): InboundMessage {
  return {
    messageId,
    providerId: "telegram",
    receivedAtIso: "2026-05-11T00:00:00.000Z",
    source: "999",
    text
  };
}

// Lightweight TelegramProvider stub — the daemon only calls pollUpdates,
// so the rest of the provider surface is unused. Cast through unknown
// to keep test fixtures from depending on the full class shape.
function fakeProvider(batches: readonly (readonly InboundMessage[] | Error)[]): TelegramProvider {
  let call = 0;
  return {
    pollUpdates: async () => {
      const next = batches[call] ?? [];
      call += 1;
      if (isErrorLike(next)) {
        throw next;
      }
      return next;
    }
  } as unknown as TelegramProvider;
}

describe("startTelegramPollTick", () => {
  it("tickOnce fetches via the registry and appends each message to the inbox file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-poll-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const logged: string[] = [];
    const handle = startTelegramPollTick({
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider([[makeMessage("1", "hi"), makeMessage("2", "second")]])
    });
    try {
      await handle.tickOnce();
      const inbox = JSON.parse(readFileSync(inboxFile, "utf8")) as { inbox: InboundMessage[] };
      expect(inbox.inbox.map((m) => m.messageId)).toEqual(["1", "2"]);
      expect(logged).toEqual(["telegram-poll: ingested 2 message(s)"]);
    } finally {
      handle.stop();
    }
  });

  it("empty fetch is a no-op: no file write, no log line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-poll-empty-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const logged: string[] = [];
    const handle = startTelegramPollTick({
      inboxFile,
      logger: (m) => logged.push(m),
      provider: fakeProvider([[]])
    });
    try {
      await handle.tickOnce();
      expect(logged).toEqual([]);
      // No file written when there's nothing to append.
      expect(() => readFileSync(inboxFile, "utf8")).toThrow();
    } finally {
      handle.stop();
    }
  });

  it("single-flight: overlapping ticks while a slow fetch is in flight don't double-call the registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-poll-overlap-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    let inflight = 0;
    let peak = 0;
    let calls = 0;
    const slowProvider: TelegramProvider = {
      pollUpdates: async () => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await sleep(5);
        calls += 1;
        inflight -= 1;
        return [];
      }
    } as unknown as TelegramProvider;
    const handle = startTelegramPollTick({ inboxFile, provider: slowProvider });
    try {
      await Promise.all([handle.tickOnce(), handle.tickOnce()]);
      expect(calls).toBe(1);
      expect(peak).toBe(1);
    } finally {
      handle.stop();
    }
  });

  it("logs upstream failures via errorLogger without crashing the tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tg-poll-err-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const errors: string[] = [];
    const handle = startTelegramPollTick({
      errorLogger: (m) => errors.push(m),
      inboxFile,
      provider: fakeProvider([new Error("Telegram getUpdates failed: 503")])
    });
    try {
      await handle.tickOnce();
      expect(errors.some((e) => e.includes("Telegram getUpdates failed: 503"))).toBe(true);
      // Another tick can still run (the polling latch reset in finally).
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
  });
});

