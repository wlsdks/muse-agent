import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readQuietHoursSettingSync } from "@muse/stores";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerQuietCommand } from "./commands-quiet.js";

let dir: string;
let settingsFile: string;
let baseEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "muse-quiet-cmd-"));
  settingsFile = join(dir, "daemon-settings.json");
  baseEnv = { MUSE_DAEMON_SETTINGS_FILE: settingsFile };
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

async function runQuiet(args: readonly string[], env: NodeJS.ProcessEnv = baseEnv): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { configDir: dir, stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerQuietCommand(program, io, { env: () => env });
  await program.parseAsync(["node", "muse", "quiet", ...args]);
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("muse quiet — show", () => {
  it("nothing set → not set, with how to set it (E4b audit)", async () => {
    const { stdout } = await runQuiet([]);
    expect(stdout).toContain("not set");
    expect(stdout).toContain("muse quiet 22:00-07:00");
  });

  it("MUSE_REMINDER_QUIET_HOURS set → reports the env source", async () => {
    const { stdout } = await runQuiet([], { ...baseEnv, MUSE_REMINDER_QUIET_HOURS: "22-7" });
    expect(stdout).toContain("22-7");
    expect(stdout).toContain("env MUSE_REMINDER_QUIET_HOURS");
  });

  it("always mentions reminders + daily brief stay unaffected", async () => {
    const { stdout } = await runQuiet([]);
    expect(stdout.toLowerCase()).toContain("reminders");
  });
});

describe("muse quiet <range> — set + enable", () => {
  it("a valid range persists enabled:true and prints confirmation", async () => {
    const { stdout, exitCode } = await runQuiet(["23:00-08:00"]);
    expect(exitCode).toBeUndefined();
    expect(stdout).toContain("set to 23:00-08:00 and enabled");
    expect(readQuietHoursSettingSync(settingsFile)).toEqual({ enabled: true, range: "23:00-08:00" });
  });

  it("a subsequent `muse quiet` (no args) reports the persisted setting as the source", async () => {
    await runQuiet(["23:00-08:00"]);
    const { stdout } = await runQuiet([]);
    expect(stdout).toContain("23:00-08:00");
    expect(stdout).toContain("persisted, enabled");
  });

  it("an invalid range → stderr + exit 1, store UNCHANGED", async () => {
    const { stderr, exitCode } = await runQuiet(["garbage"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid quiet-hours range");
    expect(readQuietHoursSettingSync(settingsFile)).toBeUndefined();
  });

  it("an invalid range does not clobber a PRE-EXISTING valid persisted setting", async () => {
    await runQuiet(["23:00-08:00"]);
    await runQuiet(["not-a-range"]);
    expect(readQuietHoursSettingSync(settingsFile)).toEqual({ enabled: true, range: "23:00-08:00" });
  });
});

describe("muse quiet off — disable", () => {
  it("disables and PRESERVES the last-known range (so re-enabling remembers it)", async () => {
    await runQuiet(["23:00-08:00"]);
    const { stdout } = await runQuiet(["off"]);
    expect(stdout).toContain("disabled");
    expect(readQuietHoursSettingSync(settingsFile)).toEqual({ enabled: false, range: "23:00-08:00" });
  });

  it("off with nothing previously set is a harmless no-op (no throw)", async () => {
    const { exitCode } = await runQuiet(["off"]);
    expect(exitCode).toBeUndefined();
    expect(readQuietHoursSettingSync(settingsFile)).toBeUndefined();
  });

  it("is case-insensitive", async () => {
    await runQuiet(["23:00-08:00"]);
    await runQuiet(["OFF"]);
    expect(readQuietHoursSettingSync(settingsFile)?.enabled).toBe(false);
  });
});
