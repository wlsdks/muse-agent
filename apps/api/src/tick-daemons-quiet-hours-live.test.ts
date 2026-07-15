import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeQuietHoursSetting } from "@muse/stores";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { liveQuietHours } from "./tick-daemons.js";

/**
 * R3-4 AC1 — "Every loop that consults quiet hours re-resolves per tick" +
 * "an invalid persisted value is ignored fail-soft (logged once), never
 * crashes a tick." Direct coverage of `liveQuietHours`, the resolver every
 * `start*DaemonIfConfigured` in this file builds (except the reminder
 * daemon, deliberately exempt).
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-live-quiet-hours-"));
  file = join(dir, "daemon-settings.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function fakeServer(): { readonly log: { readonly warn: (message: string) => void }; readonly warnings: string[] } {
  const warnings: string[] = [];
  return { log: { warn: (message: string) => warnings.push(message) }, warnings };
}

describe("liveQuietHours", () => {
  it("re-reads the persisted file on EVERY call — no restart needed to see a PATCH", async () => {
    const server = fakeServer();
    const resolve = liveQuietHours({ MUSE_DAEMON_SETTINGS_FILE: file }, server as never, undefined, undefined);
    expect(resolve()).toBeUndefined();
    await writeQuietHoursSetting(file, { enabled: true, range: "23-8" });
    expect(resolve()).toEqual({ endHour: 8, startHour: 23 });
    await writeQuietHoursSetting(file, { enabled: false, range: "23-8" });
    expect(resolve()).toBeUndefined();
  });

  it("env (per-loop) wins over the persisted setting", async () => {
    const server = fakeServer();
    await writeQuietHoursSetting(file, { enabled: true, range: "23-8" });
    const resolve = liveQuietHours({ MUSE_DAEMON_SETTINGS_FILE: file }, server as never, "1-2", undefined);
    expect(resolve()).toEqual({ endHour: 2, startHour: 1 });
  });

  it("an invalid persisted range warns exactly ONCE across repeated calls, never throws", async () => {
    const server = fakeServer();
    await writeQuietHoursSetting(file, { enabled: true, range: "not-a-range" });
    const resolve = liveQuietHours({ MUSE_DAEMON_SETTINGS_FILE: file }, server as never, undefined, undefined);
    expect(resolve()).toBeUndefined();
    expect(resolve()).toBeUndefined();
    expect(resolve()).toBeUndefined();
    expect(server.warnings).toHaveLength(1);
    expect(server.warnings[0]).toContain("not-a-range");
  });
});
