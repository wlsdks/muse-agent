import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { CalendarProviderRegistry, type CalendarProvider } from "@muse/calendar";
import { MessagingProviderError, MessagingProviderRegistry, readOutboundEffects, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { readProactiveFired, readProactiveHeartbeat, writeTasks } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


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
const execFileAsync = promisify(execFile);
const childFixture = new URL("./fixtures/proactive-notice-lock-child.ts", import.meta.url);

function countingCalendar(onRead: () => void): CalendarProviderRegistry {
  const provider: CalendarProvider = {
    createEvent: async () => { throw new Error("not used"); },
    deleteEvent: async () => { throw new Error("not used"); },
    describe: () => ({
      description: "counting calendar",
      displayName: "Counting",
      id: "counting",
      supportsReminders: false,
      supportsSearch: false
    }),
    id: "counting",
    listEvents: async () => {
      onRead();
      return [];
    },
    updateEvent: async () => { throw new Error("not used"); }
  };
  return new CalendarProviderRegistry([provider]);
}

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
          await sleep(40);
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

  it("releases the lock after an uncertain provider failure but never retries the sealed effect", async () => {
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
    expect(retry.fired).toBe(0);
    expect(retry.errors.join("\n")).toContain("delivery is unknown");
    expect(sent).toHaveLength(0);
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
    await writeFile(tasksFile, "{corrupt-task-store", "utf8");
    const filesBefore = (await readdir(dir)).sort();

    const sent: OutboundMessage[] = [];
    let calendarReads = 0;
    let investigated = 0;
    let synthesized = 0;
    let reverified = 0;
    let brokerCalls = 0;
    const historyFile = join(dir, "history.json");
    const trustFile = join(dir, "trust.json");
    const summary = await runDueProactiveNotices({
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      agentModel: "test-model",
      calendarRegistry: countingCalendar(() => { calendarReads += 1; }),
      destination: "555",
      heartbeatDir: null,
      historyFile,
      investigate: async () => {
        investigated += 1;
        return "finding";
      },
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      modelProvider: {
        generate: async () => {
          synthesized += 1;
          return { output: "notice" };
        }
      },
      now: () => NOW,
      providerId: "telegram",
      reverify: async () => {
        reverified += 1;
        return true;
      },
      sidecarFile,
      tasksFile,
      trustLedgerFile: trustFile
    });
    expect(summary.outcome).toBe("lock-held");
    expect(summary.fired).toBe(0);
    expect(summary.imminent).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(sent).toEqual([]);
    expect(calendarReads).toBe(0);
    expect(investigated).toBe(0);
    expect(synthesized).toBe(0);
    expect(reverified).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(await readFile(tasksFile, "utf8")).toBe("{corrupt-task-store");
    expect((await readdir(dir)).sort()).toEqual(filesBefore);
    expect(existsSync(historyFile)).toBe(false);
    expect(existsSync(trustFile)).toBe(false);
    // The sidecar the loop reads its dedupe state from is untouched.
    const fired = await readProactiveFired(sidecarFile);
    expect(fired).toEqual([]);
  });

  it("a BROKEN required lock records the pre-lock alive heartbeat but performs no downstream work", async () => {
    const blockingParent = join(dir, "not-a-directory");
    await writeFile(blockingParent, "file", "utf8");
    const brokenSidecar = join(blockingParent, "proactive-fired.json");
    const heartbeatDir = join(dir, "heartbeat");
    const historyFile = join(dir, "history.json");
    const trustFile = join(dir, "trust.json");
    const taskBytes = await readFile(tasksFile, "utf8");
    const sent: OutboundMessage[] = [];
    let calendarReads = 0;
    let investigated = 0;
    let synthesized = 0;
    let reverified = 0;
    let brokerCalls = 0;

    const summary = await runDueProactiveNotices({
      agentInitiatedNoticeBroker: { publish: () => { brokerCalls += 1; } },
      agentInitiatedNoticeUserId: "owner",
      agentModel: "test-model",
      calendarRegistry: countingCalendar(() => { calendarReads += 1; }),
      destination: "555",
      heartbeatDir,
      historyFile,
      investigate: async () => {
        investigated += 1;
        return "finding";
      },
      messagingRegistry: new MessagingProviderRegistry([capturingProvider(sent)]),
      modelProvider: {
        generate: async () => {
          synthesized += 1;
          return { output: "notice" };
        }
      },
      now: () => NOW,
      providerId: "telegram",
      reverify: async () => {
        reverified += 1;
        return true;
      },
      sidecarFile: brokenSidecar,
      tasksFile,
      trustLedgerFile: trustFile
    });

    expect(summary.outcome).toBe("lock-error");
    expect(summary.fired).toBe(0);
    expect(summary.imminent).toBe(0);
    expect(summary.errors.join("\n")).toContain("lock acquisition failed");
    expect(sent).toEqual([]);
    expect(calendarReads).toBe(0);
    expect(investigated).toBe(0);
    expect(synthesized).toBe(0);
    expect(reverified).toBe(0);
    expect(brokerCalls).toBe(0);
    expect(await readFile(tasksFile, "utf8")).toBe(taskBytes);
    expect(existsSync(historyFile)).toBe(false);
    expect(existsSync(trustFile)).toBe(false);
    expect(await readProactiveHeartbeat(heartbeatDir)).toMatchObject({
      alive: { at: NOW.toISOString() }
    });
    expect((await readProactiveHeartbeat(heartbeatDir)).fired).toBeUndefined();
  });

  it("admits at most one delivery section across two real OS processes", async () => {
    const callsFile = join(dir, "provider-calls.txt");
    const input = {
      callsFile,
      effectFile: join(dir, "outbound-effects.json"),
      nowIso: NOW.toISOString(),
      sidecarFile,
      tasksFile
    };
    const outputs = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)])
    ]);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const summaries = outputs.map(({ stdout }) => JSON.parse(stdout.trim()) as {
      readonly fired: number;
    });

    expect(calls).toHaveLength(1);
    expect(summaries.reduce((total, summary) => total + summary.fired, 0)).toBe(1);
    expect(await readOutboundEffects(input.effectFile)).toHaveLength(1);
    expect(await readProactiveFired(sidecarFile)).toHaveLength(1);
  }, 20_000);

  it("admits one qualified calendar effect and fired mark across two real OS processes", async () => {
    const callsFile = join(dir, "calendar-provider-calls.txt");
    const effectFile = join(dir, "calendar-outbound-effects.json");
    const calendarSidecar = join(dir, "calendar-proactive-fired.json");
    const input = {
      callsFile,
      calendarEvent: {
        id: "calendar-race",
        providerEventId: "remote-calendar-race",
        providerId: "caldav",
        startsAtIso: "2026-05-18T09:05:00.000Z",
        title: "Calendar race"
      },
      effectFile,
      nowIso: NOW.toISOString(),
      sidecarFile: calendarSidecar
    };
    const outputs = await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)]),
      execFileAsync(process.execPath, ["--import", "tsx", childFixture.pathname, JSON.stringify(input)])
    ]);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const summaries = outputs.map(({ stdout }) => JSON.parse(stdout.trim()) as {
      readonly fired: number;
    });

    expect(calls).toHaveLength(1);
    expect(summaries.reduce((total, summary) => total + summary.fired, 0)).toBe(1);
    expect(await readOutboundEffects(effectFile)).toHaveLength(1);
    expect(await readProactiveFired(calendarSidecar)).toEqual([
      expect.objectContaining({
        id: "calendar-race",
        kind: "calendar",
        providerEventId: "remote-calendar-race",
        providerId: "caldav"
      })
    ]);
  }, 20_000);
});
