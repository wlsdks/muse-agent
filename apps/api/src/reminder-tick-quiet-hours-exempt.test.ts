import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReminders } from "@muse/stores";
import type { MessagingProviderRegistry } from "@muse/messaging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";

import { startReminderTick } from "./reminder-tick.js";

/**
 * R3-4 AC3 — "Reminders + daily-brief ticks remain EXEMPT (tests assert they
 * fire inside quiet hours with the persisted setting on)." Reminders are
 * user-asked, not ambient chatter, so the new persisted setting must never
 * reach them. `startReminderDaemonIfConfigured` (apps/api/src/tick-daemons.ts)
 * deliberately never calls the live persisted-setting resolver — this proves
 * the observable consequence: a reminder due NOW fires even at an hour a
 * quiet-hours window (persisted, enabled) would suppress if it were wired.
 */

let dir: string;
let remindersFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-reminder-exempt-"));
  remindersFile = join(dir, "reminders.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function fakeRegistry(sent: string[]): MessagingProviderRegistry {
  return {
    send: async (_providerId: string, message: { readonly destination: string; readonly text: string }) => {
      sent.push(message.text);
      return { ok: true };
    }
  } as unknown as MessagingProviderRegistry;
}

describe("reminders stay exempt from the persisted quiet-hours setting", () => {
  it("a due reminder fires at 23:00 local (a would-be-quiet hour) when startReminderTick receives no quietHours — the exact wiring startReminderDaemonIfConfigured uses", async () => {
    await writeReminders(remindersFile, [
      {
        createdAt: new Date().toISOString(),
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        id: "r1",
        status: "pending",
        text: "pay rent today"
      }
    ]);
    const sent: string[] = [];
    // NOTE: no `quietHours` option — `startReminderDaemonIfConfigured` in
    // tick-daemons.ts never derives one from the persisted store for
    // reminders. now() reports 23:00 local, inside a 23-8 window IF one were
    // wired (it is not), so a firing reminder here is the proof.
    const handle = startReminderTick({
      destination: "@me",
      now: () => new Date(2026, 0, 1, 23, 0, 0),
      providerId: "log",
      registry: fakeRegistry(sent),
      remindersFile
    });
    await handle.tickOnce();
    handle.stop();
    expect(sent).toEqual(["pay rent today"]);
  });

  it("a persisted quiet-hours setting enabled at that same hour has ZERO effect on the fixture above (reminders never read the store)", async () => {
    // A persisted setting file existing on disk (as it would after a web
    // Settings PATCH) makes no difference — startReminderTick never reads it.
    const settingsDir = mkdtempSync(join(tmpdir(), "muse-daemon-settings-"));
    const settingsFile = join(settingsDir, "daemon-settings.json");
    const { writeQuietHoursSetting, readQuietHoursSettingSync } = await import("@muse/stores");
    await writeQuietHoursSetting(settingsFile, { enabled: true, range: "23:00-08:00" });
    expect(readQuietHoursSettingSync(settingsFile)).toEqual({ enabled: true, range: "23:00-08:00" });

    await writeReminders(remindersFile, [
      {
        createdAt: new Date().toISOString(),
        dueAt: new Date(Date.now() - 60_000).toISOString(),
        id: "r1",
        status: "pending",
        text: "pay rent today"
      }
    ]);
    const sent: string[] = [];
    const handle = startReminderTick({
      destination: "@me",
      now: () => new Date(2026, 0, 1, 23, 0, 0),
      providerId: "log",
      registry: fakeRegistry(sent),
      remindersFile
    });
    await handle.tickOnce();
    handle.stop();
    expect(sent).toEqual(["pay rent today"]);
    rmSync(settingsDir, { force: true, recursive: true });
  });

  it("structural pin: startReminderDaemonIfConfigured's source never references the live persisted-quiet-hours resolver", async () => {
    const source = await readFile(new URL("./tick-daemons.ts", import.meta.url), "utf8");
    const start = source.indexOf("export function startReminderDaemonIfConfigured");
    const end = source.indexOf("export function startProactiveDaemonIfConfigured");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).not.toContain("liveQuietHours");
    expect(body).not.toContain("readQuietHoursSettingSync");
  });
});
