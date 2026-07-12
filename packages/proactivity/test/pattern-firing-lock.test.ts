import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderError, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { readPatternsFired } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDuePatternNotices } from "../src/pattern-firing-loop.js";

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
let notesDir: string;
let patternsFiredFile: string;
const lockPath = (): string => `${patternsFiredFile}.firing.lock`;
// A Tuesday 21:30 — the "now" slot the weekly journal pattern fires in
// (mirrors pattern-firing-retry.test.ts's fixture).
const NOW = new Date(2026, 4, 12, 21, 30, 0);

async function seedFireablePattern(): Promise<void> {
  await mkdir(join(notesDir, "journal"), { recursive: true });
  for (let k = 1; k <= 5; k += 1) {
    const file = join(notesDir, "journal", `entry-${k.toString()}.md`);
    await writeFile(file, `journal ${k.toString()}`, "utf8");
    const when = new Date(NOW.getTime() - k * 7 * 86_400_000);
    await utimes(file, when, when);
  }
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
  dir = await mkdtemp(join(tmpdir(), "muse-pattern-lock-"));
  notesDir = join(dir, "notes");
  patternsFiredFile = join(dir, "patterns-fired.json");
  await seedFireablePattern();
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runDuePatternNotices — cross-process firing lock (two daemons, same patterns-fired sidecar)", () => {
  it("TWO CONCURRENT daemons racing the same fireable pattern: delivered EXACTLY once total, one run reports lock-held", async () => {
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
      runDuePatternNotices({
        destination: "555",
        now: () => NOW,
        patternsFiredFile,
        providerId: "telegram",
        registry,
        signals: { notesDir, now: () => NOW.getTime() }
      });

    const [a, b] = await Promise.all([runTick(), runTick()]);

    const outcomes = [a.outcome ?? "ran", b.outcome ?? "ran"].sort();
    expect(outcomes).toEqual(["lock-held", "ran"]);
    // Delivered exactly once total across BOTH runs — the double-send this fire closes.
    expect(sent).toHaveLength(1);
    expect(maxConcurrentSends).toBe(1);
    const fired = await readPatternsFired(patternsFiredFile);
    expect(fired).toHaveLength(1);
  });

  it("releases the lock after a successful tick — a later tick is not blocked", async () => {
    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(summary.outcome).toBeUndefined();
    expect(await lockFileExists()).toBe(false);
  });

  it("releases the lock after a provider-failure tick — the next tick can retry rather than being permanently blocked", async () => {
    const failing = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([alwaysFailingProvider()]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(failing.delivered).toBe(0);
    expect(failing.errors).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);

    const sent: OutboundMessage[] = [];
    const retry = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(retry.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a STALE lock left behind by a crashed daemon does not permanently block firing — the tick proceeds", async () => {
    await writeFile(lockPath(), "crashed-daemon-pid", "utf8");
    const oldMtime = new Date(2026, 0, 1);
    await utimes(lockPath(), oldMtime, oldMtime);

    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await lockFileExists()).toBe(false);
  });

  it("a LIVE lock (another daemon actively firing) short-circuits to lock-held with no send attempted and no marks", async () => {
    await writeFile(lockPath(), "other-daemon-pid", "utf8"); // fresh mtime — live

    const sent: OutboundMessage[] = [];
    const summary = await runDuePatternNotices({
      destination: "555",
      now: () => NOW,
      patternsFiredFile,
      providerId: "telegram",
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      signals: { notesDir, now: () => NOW.getTime() }
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.delivered).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(sent).toEqual([]);
    // The sidecar the loop reads its cooldown state from is untouched — no
    // fired mark was recorded for this tick.
    const fired = await readPatternsFired(patternsFiredFile);
    expect(fired).toEqual([]);
  });
});
