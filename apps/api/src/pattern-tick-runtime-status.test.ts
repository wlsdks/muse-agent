import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider } from "@muse/messaging";
import { appendInterruptionDelivery } from "@muse/stores";
import type { RunDuePatternNoticesSummary } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { classifyPatternRuntimeDecision, startPatternTick } from "./pattern-tick.js";
import { createPatternRuntimeStatusStore } from "./pattern-runtime-status.js";

const NOW = new Date(2026, 4, 12, 21, 30, 0);

function seedPattern(root: string): string {
  const notesDir = join(root, "notes");
  mkdirSync(join(notesDir, "journal"), { recursive: true });
  for (let index = 1; index <= 5; index += 1) {
    const file = join(notesDir, "journal", `entry-${index.toString()}.md`);
    writeFileSync(file, `journal ${index.toString()}`, "utf8");
    const when = new Date(NOW.getTime() - index * 7 * 86_400_000);
    utimesSync(file, when, when);
  }
  return notesDir;
}

function registry(send: MessagingProvider["send"]): MessagingProviderRegistry {
  return new MessagingProviderRegistry([{
    describe: () => ({ description: "test", displayName: "Telegram", id: "telegram" }),
    id: "telegram",
    send
  }]);
}

function summary(overrides: Partial<RunDuePatternNoticesSummary>): RunDuePatternNoticesSummary {
  return { delivered: 0, errors: [], fireable: 0, fired: [], ...overrides };
}

describe("pattern runtime decision mapping", () => {
  it.each([
    ["lock-held", summary({ outcome: "lock-held" })],
    ["lock-error", summary({ outcome: "lock-error", errors: ["redacted"] })],
    ["error", summary({ errors: ["redacted"], fireable: 1 })],
    ["fired", summary({ fireable: 1, fired: [{} as never] })],
    ["no-fireable", summary({ fireable: 0 })],
    ["completed", summary({ fireable: 1 })]
  ] as const)("maps a firing summary to %s", (expected, input) => {
    expect(classifyPatternRuntimeDecision(input)).toBe(expected);
  });
});

describe("pattern tick runtime status", () => {
  it("records re-entry and quiet-hours with one observed clock snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-status-"));
    const notesDir = seedPattern(root);
    let nowCalls = 0;
    const runtimeStatus = createPatternRuntimeStatusStore();
    const now = () => {
      nowCalls += 1;
      return NOW;
    };
    let release!: () => void;
    let started!: () => void;
    const sendStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const handle = startPatternTick({
      destination: "123",
      intervalMs: 60_000,
      now,
      notesDir,
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: registry(async (message) => {
        started();
        await blocked;
        return { destination: message.destination, messageId: "test", providerId: "telegram" };
      }),
      runtimeStatus
    });
    try {
      const first = handle.tickOnce();
      await sendStarted;
      await handle.tickOnce();
      expect(runtimeStatus.get()).toMatchObject({ lastDecision: "already-running" });
      release();
      await first;
      expect(nowCalls).toBe(2);
    } finally {
      handle.stop();
    }

    const quietStatus = createPatternRuntimeStatusStore();
    const quiet = startPatternTick({
      destination: "123",
      intervalMs: 60_000,
      now: () => new Date(2026, 4, 12, 2, 0),
      patternsFiredFile: join(root, "quiet-patterns-fired.json"),
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 23 },
      registry: registry(async (message) => ({ destination: message.destination, messageId: "unused", providerId: "telegram" })),
      runtimeStatus: quietStatus
    });
    try {
      await quiet.tickOnce();
      expect(quietStatus.get()).toMatchObject({ lastDecision: "quiet-hours" });
    } finally {
      quiet.stop();
    }
  });

  it("records fired when interruption budget digests with zero direct delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-budget-"));
    const notesDir = seedPattern(root);
    const ledgerFile = join(root, "interruption.json");
    await appendInterruptionDelivery(ledgerFile, { at: NOW, source: "other" });
    const runtimeStatus = createPatternRuntimeStatusStore();
    const sent: string[] = [];
    const handle = startPatternTick({
      destination: "123",
      interruptionBudget: {
        dailyCap: 1,
        digestFile: join(root, "digest.json"),
        hourlyCap: 1,
        ledgerFile
      },
      intervalMs: 60_000,
      notesDir,
      now: () => NOW,
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: registry(async (message) => {
        sent.push(message.text);
        return { destination: message.destination, messageId: "unused", providerId: "telegram" };
      }),
      runtimeStatus
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([]);
      expect(runtimeStatus.get()).toMatchObject({
        lastDecision: "fired",
        lastDeliveredCount: 0,
        lastFiredCount: 1
      });
    } finally {
      handle.stop();
    }
  });

  it("continues delivery when the process-local status writer fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-pattern-tick-status-failure-"));
    const notesDir = seedPattern(root);
    const sent: string[] = [];
    const handle = startPatternTick({
      destination: "123",
      intervalMs: 60_000,
      notesDir,
      now: () => NOW,
      patternsFiredFile: join(root, "patterns-fired.json"),
      providerId: "telegram",
      registry: registry(async (message) => {
        sent.push(message.text);
        return { destination: message.destination, messageId: "test", providerId: "telegram" };
      }),
      runtimeStatus: { get: () => null, record: () => { throw new Error("status store failed"); } }
    });
    try {
      await expect(handle.tickOnce()).resolves.toBeUndefined();
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });
});
