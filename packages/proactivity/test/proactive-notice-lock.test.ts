import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderError, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { readProactiveFired, writeTasks } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDueProactiveNotices } from "../src/proactive-notice-loop.js";

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
    }
  };
}

function alwaysFailingProvider(): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(): Promise<OutboundReceipt> {
      throw new MessagingProviderError("telegram", "INVALID_DESTINATION", "permanently invalid", 400);
    }
  };
}

let dir: string;
let tasksFile: string;
let sidecarFile: string;
const lockPath = (): string => `${sidecarFile}.firing.lock`;
const NOW = new Date("2026-05-18T09:00:00.000Z");

async function seedImminentTask(): Promise<void> {
  await writeTasks(tasksFile, [{
    createdAt: "2026-05-18T08:00:00.000Z",
    dueAt: "2026-05-18T09:05:00.000Z",
    id: "t-q3",
    status: "open" as const,
    title: "Send the Q3 budget memo"
  }]);
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
  dir = await mkdtemp(join(tmpdir(), "muse-proactive-lock-"));
  tasksFile = join(dir, "tasks.json");
  sidecarFile = join(dir, "proactive-fired.json");
  await seedImminentTask();
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDueProactiveNotices — cross-process firing lock (two daemons, same sidecar file)", () => {
  it("TWO CONCURRENT daemons racing the same imminent task: delivered EXACTLY once total, one run reports lock-held", async () => {
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
    const runTick = () =>
      runDueProactiveNotices({
        destination: "555",
        messagingRegistry: registry,
        now: () => NOW,
        providerId: "telegram",
        sidecarFile,
        tasksFile
      });

    const [a, b] = await Promise.all([runTick(), runTick()]);

    const outcomes = [a.outcome ?? "ran", b.outcome ?? "ran"].sort();
    expect(outcomes).toEqual(["lock-held", "ran"]);
    // Delivered exactly once total across BOTH runs — the double-send this fire closes.
    expect(sent).toHaveLength(1);
    expect(maxConcurrentSends).toBe(1);
    const fired = await readProactiveFired(sidecarFile);
    expect(fired).toHaveLength(1);
  });

  it("releases the lock after a successful tick — a later tick is not blocked", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary.fired).toBe(1);
    expect(summary.outcome).toBeUndefined();
    expect(await lockFileExists()).toBe(false);
  });

  it("releases the lock after a provider-failure tick — the next tick can retry rather than being permanently blocked", async () => {
    const failing = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: new MessagingProviderRegistry([alwaysFailingProvider()]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(failing.fired).toBe(0);
    expect(failing.errors.length).toBeGreaterThan(0);
    expect(await lockFileExists()).toBe(false);

    const sent: OutboundMessage[] = [];
    const retry = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(retry.fired).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a STALE lock left behind by a crashed daemon does not permanently block firing — the tick proceeds", async () => {
    await writeFile(lockPath(), "crashed-daemon-pid", "utf8");
    const oldMtime = new Date(2026, 0, 1);
    await utimes(lockPath(), oldMtime, oldMtime);

    const sent: OutboundMessage[] = [];
    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary.fired).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);
  });

  it("a LIVE lock (another daemon actively firing) short-circuits to lock-held with no send attempted and no marks", async () => {
    await writeFile(lockPath(), "other-daemon-pid", "utf8"); // fresh mtime — live

    const sent: OutboundMessage[] = [];
    const summary = await runDueProactiveNotices({
      destination: "555",
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      now: () => NOW,
      providerId: "telegram",
      sidecarFile,
      tasksFile
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.fired).toBe(0);
    expect(summary.imminent).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(sent).toEqual([]);
    // The sidecar the loop reads its dedupe state from is untouched.
    const fired = await readProactiveFired(sidecarFile);
    expect(fired).toEqual([]);
  });
});
