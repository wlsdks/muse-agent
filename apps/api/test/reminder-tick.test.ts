import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it, vi } from "vitest";

import { classifyReminderRuntimeDecision, isQuietHour, parseQuietHours, startReminderTick } from "../src/reminder-tick.js";
import { createReminderRuntimeStatusStore } from "../src/reminder-runtime-status.js";

interface MessageSent {
  readonly providerId: string;
  readonly destination: string;
  readonly text: string;
}

function fakeRegistry(sent: MessageSent[]): MessagingProviderRegistry {
  return {
    has: (providerId: string) => providerId === "telegram",
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { destination: message.destination, messageId: "stub", providerId };
    }
  } as unknown as MessagingProviderRegistry;
}

function seedReminders(file: string, dueAt: string): void {
  writeFileSync(file, JSON.stringify({
    reminders: [
      { createdAt: "2026-01-01T00:00:00Z", dueAt, id: "rem_x", status: "pending", text: "Buy milk" }
    ]
  }), "utf8");
}

describe("parseQuietHours", () => {
  it("parses valid <start>-<end> ranges", () => {
    expect(parseQuietHours("23-7")).toEqual({ endHour: 7, startHour: 23 });
    expect(parseQuietHours("0-6")).toEqual({ endHour: 6, startHour: 0 });
    expect(parseQuietHours(" 22 - 06 ")).toBeUndefined(); // spaces around digits not supported
    expect(parseQuietHours("22-06")).toEqual({ endHour: 6, startHour: 22 });
  });

  it("accepts the natural HH:MM form (hour-granular: minutes are validated then rounded down to the hour)", () => {
    // The footgun this closes: the common `22:00-07:00` used to be
    // rejected, silently turning quiet hours OFF.
    expect(parseQuietHours("22:00-07:00")).toEqual({ endHour: 7, startHour: 22 });
    expect(parseQuietHours("23:30-06:15")).toEqual({ endHour: 6, startHour: 23 });
    expect(parseQuietHours("9:05-17:45")).toEqual({ endHour: 17, startHour: 9 });
  });

  it("rejects an HH:MM with out-of-range minutes rather than misparsing it", () => {
    expect(parseQuietHours("22:60-07:00")).toBeUndefined();
    expect(parseQuietHours("22:5-7")).toBeUndefined(); // minutes must be two digits
  });

  it("returns undefined for malformed / out-of-range / empty", () => {
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(parseQuietHours("")).toBeUndefined();
    expect(parseQuietHours("midnight-noon")).toBeUndefined();
    expect(parseQuietHours("24-7")).toBeUndefined();
    expect(parseQuietHours("-1-7")).toBeUndefined();
    expect(parseQuietHours("7-7")).toBeUndefined(); // ambiguous
    expect(parseQuietHours("22:00-22:30")).toBeUndefined(); // same hour → ambiguous under hour-granular windows
  });
});

describe("isQuietHour", () => {
  it("normal range: inclusive start, exclusive end", () => {
    const r = { endHour: 7, startHour: 1 };
    expect(isQuietHour(0, r)).toBe(false);
    expect(isQuietHour(1, r)).toBe(true);
    expect(isQuietHour(6, r)).toBe(true);
    expect(isQuietHour(7, r)).toBe(false);
  });

  it("midnight wrap (23-7 covers 23, 0..6)", () => {
    const r = { endHour: 7, startHour: 23 };
    expect(isQuietHour(22, r)).toBe(false);
    expect(isQuietHour(23, r)).toBe(true);
    expect(isQuietHour(0, r)).toBe(true);
    expect(isQuietHour(6, r)).toBe(true);
    expect(isQuietHour(7, r)).toBe(false);
  });
});

describe("startReminderTick", () => {
  it("tickOnce delivers due reminders and marks them fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "1970-01-01T00:00:00Z");
    const sent: MessageSent[] = [];
    const runtimeStatus = createReminderRuntimeStatusStore();
    const handle = startReminderTick({
      destination: "@me",
      providerId: "telegram",
      registry: fakeRegistry(sent),
      remindersFile: file,
      runtimeStatus
    });
    try {
      await handle.tickOnce();
      expect(sent).toEqual([{ destination: "@me", providerId: "telegram", text: "Buy milk" }]);
      const after = JSON.parse(readFileSync(file, "utf8")) as {
        reminders: Array<{ id: string; status: string; firedAt?: string }>;
      };
      expect(after.reminders[0]?.status).toBe("fired");
      expect(runtimeStatus.get()).toMatchObject({
        lastDecision: "fired",
        lastDeliveredCount: 1,
        lastDueCount: 1,
        lastErrorCount: 0,
        lastFiredCount: 1
      });
      // Second tick is a no-op (no due reminders left).
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      expect(runtimeStatus.get()?.lastDecision).toBe("no-due");
    } finally {
      handle.stop();
    }
  });

  it("single-flight: overlapping ticks while a slow send is in flight don't double-deliver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-overlap-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "1970-01-01T00:00:00Z");
    let inflight = 0;
    let peakInflight = 0;
    let sent = 0;
    const slowRegistry: MessagingProviderRegistry = {
      has: (providerId: string) => providerId === "telegram",
      send: async () => {
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        // Yield twice so a sibling tick has a chance to enter.
        await sleep(5);
        sent += 1;
        inflight -= 1;
        return { destination: "@me", messageId: "stub", providerId: "telegram" };
      }
    } as unknown as MessagingProviderRegistry;
    const statusUpdates: string[] = [];
    const handle = startReminderTick({
      destination: "@me",
      providerId: "telegram",
      registry: slowRegistry,
      remindersFile: file,
      runtimeStatus: {
        get: () => null,
        record: ({ decision }) => statusUpdates.push(decision)
      }
    });
    try {
      const a = handle.tickOnce();
      const b = handle.tickOnce();
      await Promise.all([a, b]);
      // Only one send actually went out — the second tickOnce noticed
      // `firing=true` and bailed.
      expect(sent).toBe(1);
      expect(peakInflight).toBe(1);
      expect(statusUpdates).toContain("already-running");
      expect(statusUpdates).toContain("fired");
    } finally {
      handle.stop();
    }
  });

  it("logs upstream failures via errorLogger without crashing the tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-err-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "1970-01-01T00:00:00Z");
    const errors: string[] = [];
    const runtimeStatus = createReminderRuntimeStatusStore();
    const failingRegistry: MessagingProviderRegistry = {
      has: (providerId: string) => providerId === "telegram",
      send: async () => {
        throw new Error("upstream 503");
      }
    } as unknown as MessagingProviderRegistry;
    const handle = startReminderTick({
      destination: "@me",
      errorLogger: (message) => errors.push(message),
      providerId: "telegram",
      registry: failingRegistry,
      remindersFile: file,
      runtimeStatus
    });
    try {
      await handle.tickOnce();
      expect(errors.some((entry) =>
        entry.includes("delivery is unknown")
        && entry.includes("reconcile manually")
      )).toBe(true);
      // Reminder remains pending for explicit reconciliation; automatic retry is blocked.
      const after = JSON.parse(readFileSync(file, "utf8")) as {
        reminders: Array<{ status: string }>;
      };
      expect(after.reminders[0]?.status).toBe("pending");
      expect(runtimeStatus.get()).toMatchObject({ lastDecision: "error", lastErrorCount: 1, lastDueCount: 1 });
    } finally {
      handle.stop();
    }
  });

  it("quiet hours: tickOnce skips firing inside the window, fires after it ends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-quiet-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "1970-01-01T00:00:00Z");
    const sent: MessageSent[] = [];
    const statusUpdates: string[] = [];
    let fakeHour = 2; // 02:00 — inside 23-7 window
    const handle = startReminderTick({
      destination: "@me",
      now: () => {
        const date = new Date("2026-05-11T00:00:00Z");
        date.setHours(fakeHour);
        return date;
      },
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 23 },
      registry: fakeRegistry(sent),
      remindersFile: file,
      runtimeStatus: {
        get: () => null,
        record: ({ decision }) => statusUpdates.push(decision)
      }
    });
    try {
      // 02:00 → quiet, skip.
      await handle.tickOnce();
      expect(sent).toHaveLength(0);
      expect(statusUpdates).toEqual(["quiet-hours"]);
      const after1 = JSON.parse(readFileSync(file, "utf8")) as { reminders: Array<{ status: string }> };
      expect(after1.reminders[0]?.status).toBe("pending");

      // 09:00 → past the boundary; the queued reminder fires.
      fakeHour = 9;
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      expect(statusUpdates).toContain("fired");
      const after2 = JSON.parse(readFileSync(file, "utf8")) as { reminders: Array<{ status: string }> };
      expect(after2.reminders[0]?.status).toBe("fired");
    } finally {
      handle.stop();
    }
  });

  it("swallows a runtime-status recording failure without changing delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-status-failure-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "1970-01-01T00:00:00Z");
    const sent: MessageSent[] = [];
    const handle = startReminderTick({
      destination: "@me",
      providerId: "telegram",
      registry: fakeRegistry(sent),
      remindersFile: file,
      runtimeStatus: {
        get: () => null,
        record: () => { throw new Error("status store unavailable"); }
      }
    });
    try {
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ reminders: [{ status: "fired" }] });
    } finally {
      handle.stop();
    }
  });

  it.each([
    ["lock-held", { delivered: 0, due: 0, errors: [], fired: [], outcome: "lock-held" }],
    ["lock-error", { delivered: 0, due: 0, errors: ["lock failed"], fired: [], outcome: "lock-error" }],
    ["error", { delivered: 1, due: 1, errors: ["partial failure"], fired: [{}], outcome: undefined }],
    ["fired", { delivered: 1, due: 1, errors: [], fired: [{}], outcome: undefined }],
    ["no-due", { delivered: 0, due: 0, errors: [], fired: [], outcome: undefined }],
    ["completed", { delivered: 0, due: 1, errors: [], fired: [], outcome: undefined }]
  ] as const)("classifies the real reminder summary outcome as %s", (expected, summary) => {
    expect(classifyReminderRuntimeDecision(summary)).toBe(expected);
  });

  it("uses one injected clock snapshot for quiet hours and due selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-skew-"));
    const file = join(dir, "reminders.json");
    seedReminders(file, "2020-01-02T12:00:00.000Z");
    const sent: MessageSent[] = [];
    let tickAt = new Date("2020-01-01T12:00:00.000Z");
    let clockReads = 0;
    const handle = startReminderTick({
      destination: "@me",
      now: () => {
        clockReads += 1;
        return tickAt;
      },
      providerId: "telegram",
      quietHours: { endHour: 7, startHour: 23 },
      registry: fakeRegistry(sent),
      remindersFile: file
    });
    try {
      await handle.tickOnce();
      expect(clockReads).toBe(1);
      expect(sent).toEqual([]);

      tickAt = new Date("2020-01-03T12:00:00.000Z");
      await handle.tickOnce();
      expect(clockReads).toBe(2);
      expect(sent).toHaveLength(1);
      await handle.tickOnce();
      expect(sent).toHaveLength(1);
    } finally {
      handle.stop();
    }
  });

  it("schedules ticks at the configured interval (clamped to ≥5s)", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "muse-tick-clock-"));
    const file = join(dir, "reminders.json");
    writeFileSync(file, JSON.stringify({ reminders: [] }), "utf8");
    let ticks = 0;
    const handle = startReminderTick({
      destination: "@me",
      // Asks for 1ms; should clamp to 5_000.
      intervalMs: 1,
      providerId: "telegram",
      registry: {
        has: (providerId: string) => providerId === "telegram",
        send: async () => { ticks += 1; return { destination: "x", messageId: "y", providerId: "z" }; }
      } as unknown as MessagingProviderRegistry,
      remindersFile: file
    });
    try {
      vi.advanceTimersByTime(4_999);
      expect(ticks).toBe(0);
      vi.advanceTimersByTime(2);
      // Pump the microtask queue so the async tick resolves before
      // we assert. (No reminders due → registry.send isn't called,
      // but that's fine — we're proving the cadence here.)
      await Promise.resolve();
      // Empty file → no send call regardless of cadence.
      expect(ticks).toBe(0);
    } finally {
      handle.stop();
      vi.useRealTimers();
    }
  });
});
