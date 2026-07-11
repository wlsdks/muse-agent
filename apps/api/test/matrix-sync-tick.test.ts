import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readInbox } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { startMatrixSyncTick } from "../src/matrix-sync-tick.js";

import type { InboundMessage, MatrixProvider } from "@muse/messaging";

function makeMessage(messageId: string): InboundMessage {
  return {
    messageId,
    providerId: "matrix",
    receivedAtIso: "2026-07-11T00:00:00.000Z",
    sender: "@jinan:hs.test",
    source: "!room:hs.test",
    text: `m${messageId}`
  };
}

describe("startMatrixSyncTick", () => {
  it("passes longPollSeconds to the provider and immediately re-syncs (no interval wait)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-tick-"));
    const seenOptions: unknown[] = [];
    let calls = 0;
    const provider = {
      pollUpdates: async (options?: unknown) => {
        seenOptions.push(options);
        calls += 1;
        return calls === 1 ? [makeMessage("$1")] : [];
      }
    } as unknown as MatrixProvider;

    const handle = startMatrixSyncTick({
      inboxFile: join(dir, "inbox.json"),
      intervalMs: 60_000,
      longPollSeconds: 25,
      provider,
      relaunchDelayMs: 5
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    handle.stop();

    expect(calls).toBeGreaterThan(1);
    expect(seenOptions[0]).toMatchObject({ longPollSeconds: 25 });
  });

  it("appends ingested messages to the inbox and fires onIngested with the count (not on empty syncs)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-tick2-"));
    const inboxFile = join(dir, "inbox.json");
    let calls = 0;
    const provider = {
      pollUpdates: async () => {
        calls += 1;
        return calls === 1 ? [makeMessage("$1"), makeMessage("$2")] : [];
      }
    } as unknown as MatrixProvider;

    const ingests: number[] = [];
    const handle = startMatrixSyncTick({
      inboxFile,
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
    const inbox = await readInbox(inboxFile, 10);
    expect(inbox.map((m) => m.messageId).sort()).toEqual(["$1", "$2"]);
  });

  it("stop() halts the continuous loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-tick3-"));
    let calls = 0;
    const provider = {
      pollUpdates: async () => {
        calls += 1;
        return [];
      }
    } as unknown as MatrixProvider;

    const handle = startMatrixSyncTick({
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

  it("backs off to intervalMs after an error instead of hot-looping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-tick4-"));
    const errors: string[] = [];
    let calls = 0;
    const provider = {
      pollUpdates: async () => {
        calls += 1;
        throw new Error("M_UNKNOWN_TOKEN");
      }
    } as unknown as MatrixProvider;

    const handle = startMatrixSyncTick({
      errorLogger: (message) => {
        errors.push(message);
      },
      inboxFile: join(dir, "inbox.json"),
      intervalMs: 60_000,
      longPollSeconds: 25,
      provider,
      relaunchDelayMs: 5
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    handle.stop();

    expect(calls).toBe(1);
    expect(errors[0]).toContain("M_UNKNOWN_TOKEN");
  });
});
