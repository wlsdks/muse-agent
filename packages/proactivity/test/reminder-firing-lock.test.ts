import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { readReminders } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueReminders } from "../src/reminder-firing-loop.js";

function capturingProvider(sent: OutboundMessage[], options: { readonly failWith?: Error } = {}): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      if (options.failWith) throw options.failWith;
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

let dir: string;
let remindersFile: string;
const lockPath = (): string => `${remindersFile}.firing.lock`;

async function seedReminders(dueAt: string, count = 1): Promise<void> {
  const reminders = Array.from({ length: count }, (_, index) => ({
    createdAt: "2026-01-01T00:00:00Z",
    dueAt,
    id: `rem_${index.toString()}`,
    status: "pending",
    text: `reminder ${index.toString()}`
  }));
  await writeFile(remindersFile, JSON.stringify({ reminders }), "utf8");
}

async function lockFileExists(): Promise<boolean> {
  try {
    await stat(lockPath());
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-reminder-lock-"));
  remindersFile = join(dir, "reminders.json");
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDueReminders — cross-process firing lock (two daemons, same reminders file)", () => {
  it("TWO CONCURRENT daemons racing the same due reminder: delivered EXACTLY once total, one run reports lock-held", async () => {
    await seedReminders("1970-01-01T00:00:00Z");
    const sent: OutboundMessage[] = [];
    let concurrentSends = 0;
    let maxConcurrentSends = 0;
    const registry = new MessagingProviderRegistry([
      {
        describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
        id: "telegram",
        async send(message: OutboundMessage): Promise<OutboundReceipt> {
          concurrentSends += 1;
          maxConcurrentSends = Math.max(maxConcurrentSends, concurrentSends);
          // Slow provider — widens the race window a real double-send bug needs.
          await new Promise((resolve) => setTimeout(resolve, 40));
          concurrentSends -= 1;
          sent.push(message);
          return { destination: message.destination, messageId: "m1", providerId: "telegram" };
        }
      }
    ]);
    const runTick = () => runDueReminders({ destination: "@me", file: remindersFile, providerId: "telegram", registry });

    const [a, b] = await Promise.all([runTick(), runTick()]);

    const outcomes = [a.outcome ?? "ran", b.outcome ?? "ran"].sort();
    expect(outcomes).toEqual(["lock-held", "ran"]);
    // Delivered exactly once total across BOTH runs — the double-send this fire closes.
    expect(sent).toHaveLength(1);
    expect(maxConcurrentSends).toBe(1);
    const after = await readReminders(remindersFile);
    expect(after.filter((entry) => entry.status === "fired")).toHaveLength(1);
  });

  it("releases the lock after a successful tick — a later tick is not blocked", async () => {
    await seedReminders("1970-01-01T00:00:00Z");
    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders({
      destination: "@me",
      file: remindersFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(1);
    expect(summary.outcome).toBeUndefined();
    expect(await lockFileExists()).toBe(false);
  });

  it("releases the lock after a provider-failure tick — the next tick can retry rather than being permanently blocked", async () => {
    await seedReminders("1970-01-01T00:00:00Z");
    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders({
      destination: "@me",
      file: remindersFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent, { failWith: new Error("upstream 500") })])
    });
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);

    const retry = await runDueReminders({
      destination: "@me",
      file: remindersFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(retry.delivered).toBe(1);
  });

  it("a STALE lock left behind by a crashed daemon does not permanently block firing — the tick proceeds", async () => {
    await seedReminders("1970-01-01T00:00:00Z");
    await writeFile(lockPath(), "crashed-daemon-pid", "utf8");
    const oldMtime = new Date(2026, 6, 1);
    await utimes(lockPath(), oldMtime, oldMtime);

    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders({
      destination: "@me",
      file: remindersFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);
  });

  it("a LIVE lock (another daemon actively firing) short-circuits to lock-held with no send attempted and no marks", async () => {
    await seedReminders("1970-01-01T00:00:00Z");
    await writeFile(lockPath(), "other-daemon-pid", "utf8"); // fresh mtime — live

    const sent: OutboundMessage[] = [];
    const summary = await runDueReminders({
      destination: "@me",
      file: remindersFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)])
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(sent).toEqual([]);
    const after = await readReminders(remindersFile);
    expect(after.every((entry) => entry.status === "pending")).toBe(true); // untouched
  });
});
