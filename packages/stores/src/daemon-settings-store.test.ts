import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readDaemonSettingsSync,
  readQuietHoursSettingSync,
  resolveDaemonSettingsFile,
  UnsupportedDaemonSettingsFormatError,
  writeDaemonSetting,
  writeQuietHoursSetting
} from "./daemon-settings-store.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-daemon-settings-"));
  file = join(dir, "daemon-settings.json");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("resolveDaemonSettingsFile", () => {
  it("honors MUSE_DAEMON_SETTINGS_FILE override", () => {
    expect(resolveDaemonSettingsFile({ MUSE_DAEMON_SETTINGS_FILE: "/tmp/x/settings.json" })).toBe("/tmp/x/settings.json");
  });

  it("falls back to ~/.muse/daemon-settings.json", () => {
    expect(resolveDaemonSettingsFile({})).toMatch(/\.muse\/daemon-settings\.json$/u);
  });

  it("uses an injected home instead of the ambient owner home", () => {
    expect(resolveDaemonSettingsFile({ HOME: "/tmp/muse-injected-home" }))
      .toBe("/tmp/muse-injected-home/.muse/daemon-settings.json");
    expect(resolveDaemonSettingsFile({ USERPROFILE: "C:\\muse-injected-home" }))
      .toBe(join("C:\\muse-injected-home", ".muse", "daemon-settings.json"));
  });
});

describe("readDaemonSettingsSync / writeDaemonSetting", () => {
  it("missing file → empty flags, no throw", () => {
    expect(readDaemonSettingsSync(file)).toEqual({});
  });

  it("writes a flag then reads it back", async () => {
    await writeDaemonSetting(file, "MUSE_FOO_ENABLED", true);
    expect(readDaemonSettingsSync(file)).toEqual({ MUSE_FOO_ENABLED: true });
  });

  it("a second flag write preserves the first (read-modify-write, not overwrite)", async () => {
    await writeDaemonSetting(file, "MUSE_FOO_ENABLED", true);
    await writeDaemonSetting(file, "MUSE_BAR_ENABLED", false);
    expect(readDaemonSettingsSync(file)).toEqual({ MUSE_BAR_ENABLED: false, MUSE_FOO_ENABLED: true });
  });

  it("upgrades a legacy unversioned settings file without losing its flags", async () => {
    writeFileSync(file, JSON.stringify({ flags: { MUSE_FOO_ENABLED: true } }), "utf8");

    await writeDaemonSetting(file, "MUSE_BAR_ENABLED", false);

    expect(readDaemonSettingsSync(file)).toEqual({ MUSE_BAR_ENABLED: false, MUSE_FOO_ENABLED: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
  });

  it("refuses to mutate a newer settings format through either writer", async () => {
    const original = JSON.stringify({
      extension: { preserve: true },
      flags: { MUSE_FOO_ENABLED: true },
      quietHours: { enabled: true, range: "23:00-08:00" },
      version: 2
    });
    writeFileSync(file, original, "utf8");

    await expect(writeDaemonSetting(file, "MUSE_BAR_ENABLED", false)).rejects.toBeInstanceOf(UnsupportedDaemonSettingsFormatError);
    await expect(writeQuietHoursSetting(file, { enabled: false, range: "22:00-07:00" })).rejects.toBeInstanceOf(UnsupportedDaemonSettingsFormatError);

    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("refuses to overwrite an unsupported JSON root through either writer", async () => {
    const original = "[]";
    writeFileSync(file, original, "utf8");

    await expect(writeDaemonSetting(file, "MUSE_BAR_ENABLED", false)).rejects.toBeInstanceOf(UnsupportedDaemonSettingsFormatError);
    await expect(writeQuietHoursSetting(file, { enabled: false, range: "22:00-07:00" })).rejects.toBeInstanceOf(UnsupportedDaemonSettingsFormatError);

    expect(readDaemonSettingsSync(file)).toEqual({});
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(original);
  });
});

describe("readQuietHoursSettingSync / writeQuietHoursSetting", () => {
  it("missing file → undefined, no throw", () => {
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
  });

  it("writes a quiet-hours setting then reads it back", async () => {
    await writeQuietHoursSetting(file, { enabled: true, range: "23:00-08:00" });
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "23:00-08:00" });
  });

  it("null clears the setting back to undefined", async () => {
    await writeQuietHoursSetting(file, { enabled: true, range: "23:00-08:00" });
    await writeQuietHoursSetting(file, null);
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
  });

  it("a malformed quietHours block (wrong shape) reads as undefined, not a throw", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify({ flags: {}, quietHours: { enabled: "not-a-boolean", range: 5 }, version: 1 }), "utf8");
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
  });

  it("corrupt JSON reads as empty/undefined for both flags and quietHours, not a throw", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ not json", "utf8");
    expect(readDaemonSettingsSync(file)).toEqual({});
    expect(readQuietHoursSettingSync(file)).toBeUndefined();
  });
});

describe("cross-field durability — a flag PATCH must not clobber a quiet-hours PATCH and vice versa (the SAME file backs both)", () => {
  it("writeDaemonSetting after writeQuietHoursSetting preserves the quiet-hours block", async () => {
    await writeQuietHoursSetting(file, { enabled: true, range: "23:00-08:00" });
    await writeDaemonSetting(file, "MUSE_FOO_ENABLED", true);
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "23:00-08:00" });
    expect(readDaemonSettingsSync(file)).toEqual({ MUSE_FOO_ENABLED: true });
  });

  it("writeQuietHoursSetting after writeDaemonSetting preserves the flags", async () => {
    await writeDaemonSetting(file, "MUSE_FOO_ENABLED", true);
    await writeQuietHoursSetting(file, { enabled: true, range: "23:00-08:00" });
    expect(readDaemonSettingsSync(file)).toEqual({ MUSE_FOO_ENABLED: true });
    expect(readQuietHoursSettingSync(file)).toEqual({ enabled: true, range: "23:00-08:00" });
  });
});
