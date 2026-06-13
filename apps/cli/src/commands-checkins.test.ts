import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCheckins } from "@muse/mcp";
import { Command } from "commander";

import { checkinsFile, registerCheckinsCommands, scanSessionCheckins } from "./commands-checkins.js";

async function runCheckins(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = 0;
  try {
    const program = new Command();
    program.exitOverride();
    registerCheckinsCommands(program, io);
    await program.parseAsync(["node", "muse", "checkins", ...args]);
  } finally { /* leave exitCode for the caller to read */ }
  const exitCode = process.exitCode === 0 ? undefined : process.exitCode;
  process.exitCode = prevExit;
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("checkins list --status — strict validation (sibling parity with `tasks list`)", () => {
  const prevEnv = process.env.MUSE_CHECKINS_FILE;
  beforeEach(() => {
    process.env.MUSE_CHECKINS_FILE = join(mkdtempSync(join(tmpdir(), "muse-checkins-")), "checkins.json");
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MUSE_CHECKINS_FILE;
    else process.env.MUSE_CHECKINS_FILE = prevEnv;
  });

  it("rejects a typo'd --status with an actionable error + exit 1, not a silently-empty list", async () => {
    const r = await runCheckins(["list", "--status", "fierd"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--status must be one of: scheduled, fired, all");
    expect(r.stderr).toContain("did you mean 'fired'");
    expect(r.stdout).not.toContain("No fierd check-ins");
  });

  it("accepts a valid --status without erroring", async () => {
    const r = await runCheckins(["list", "--status", "fired"]);
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe("");
  });
});

describe("checkinsFile", () => {
  it("honours MUSE_CHECKINS_FILE, else defaults under ~/.muse/checkins.json", () => {
    expect(checkinsFile({ MUSE_CHECKINS_FILE: "/tmp/c.json" } as NodeJS.ProcessEnv)).toBe("/tmp/c.json");
    expect(checkinsFile({} as NodeJS.ProcessEnv).endsWith("/.muse/checkins.json")).toBe(true);
  });
});

describe("scanSessionCheckins — session-end auto-scan (detect → schedule → persist)", () => {
  it("schedules a check-in for a voiced commitment; a no-commitment session schedules none", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-autoscan-")), "checkins.json");
    const withCommitment = await scanSessionCheckins({
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:00:00Z"),
      readHistory: async () => [
        { role: "user", content: "I need to email Bob about the Q3 report" },
        { role: "assistant", content: "Got it." }
      ]
    });
    expect(withCommitment).toHaveLength(1);
    expect(withCommitment[0]!.question).toContain("email Bob");
    expect((await readCheckins(file)).map((c) => c.status)).toEqual(["scheduled"]);

    const noCommitment = await scanSessionCheckins({
      file,
      userId: "stark",
      now: () => new Date("2026-05-01T09:05:00Z"),
      readHistory: async () => [{ role: "user", content: "what time is it?" }]
    });
    expect(noCommitment).toEqual([]);
  });
});
