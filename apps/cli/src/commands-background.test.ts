import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerBackgroundCommand } from "./commands-background.js";
import type { ProgramIO } from "./program.js";

let storeFile: string;
let prevStore: string | undefined;

beforeEach(() => {
  storeFile = join(mkdtempSync(join(tmpdir(), "muse-bg-")), "background-processes.json");
  prevStore = process.env.MUSE_BACKGROUND_PROCESSES_FILE;
  process.env.MUSE_BACKGROUND_PROCESSES_FILE = storeFile;
});

afterEach(() => {
  if (prevStore === undefined) delete process.env.MUSE_BACKGROUND_PROCESSES_FILE;
  else process.env.MUSE_BACKGROUND_PROCESSES_FILE = prevStore;
});

async function runBg(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = { stderr: (m) => stderr.push(m), stdout: (m) => stdout.push(m) };
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerBackgroundCommand(program, io);
    await program.parseAsync(["node", "muse", "bg", ...args]);
    exitCode = process.exitCode;
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.exitCode = prevExit;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

describe("muse bg — unknown-id error envelope", () => {
  it("bg logs <unknown> → `muse bg logs:`-prefixed stderr; exit code unchanged (0), stdout empty", async () => {
    const r = await runBg(["logs", "bg-nope"]);
    expect(r.stderr).toBe("muse bg logs: No background process with id 'bg-nope'.\n");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBeUndefined();
  });

  it("bg restart <unknown> → `muse bg restart:`-prefixed stderr; exit code unchanged (0), stdout empty", async () => {
    const r = await runBg(["restart", "bg-nope"]);
    expect(r.stderr).toBe("muse bg restart: No background process with id 'bg-nope'.\n");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBeUndefined();
  });

  it("bg stop <unknown> → `muse bg stop:`-prefixed stderr; exit code unchanged (0), stdout empty", async () => {
    const r = await runBg(["stop", "bg-nope"]);
    expect(r.stderr).toBe("muse bg stop: No background process with id 'bg-nope'.\n");
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBeUndefined();
  });
});
