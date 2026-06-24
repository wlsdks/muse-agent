import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { readSchedulerPauseState } from "@muse/stores";

import { registerSchedulerCommands } from "../src/commands-scheduler-setup.js";

const ORIG = process.env.MUSE_SCHEDULER_PAUSE_FILE;
afterEach(() => {
  if (ORIG === undefined) delete process.env.MUSE_SCHEDULER_PAUSE_FILE;
  else process.env.MUSE_SCHEDULER_PAUSE_FILE = ORIG;
});

function harness(pauseFile: string) {
  process.env.MUSE_SCHEDULER_PAUSE_FILE = pauseFile;
  const out: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerSchedulerCommands(program, { stdout: (m) => out.push(m), stderr: () => undefined }, {
    apiRequest: async () => ({}),
    writeOutput: () => undefined
  });
  return { program, out };
}

describe("muse scheduler pause/resume/pause-status", () => {
  it("pause writes the paused flag and reports it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-schedpause-cli-")), "p.json");
    const h = harness(file);
    await h.program.parseAsync(["scheduler", "pause"], { from: "user" });
    expect(h.out.join("")).toMatch(/paused/i);
    expect((await readSchedulerPauseState(file)).paused).toBe(true);
  });

  it("resume clears the paused flag", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-schedpause-cli-")), "p.json");
    const h = harness(file);
    await h.program.parseAsync(["scheduler", "pause"], { from: "user" });
    await h.program.parseAsync(["scheduler", "resume"], { from: "user" });
    expect((await readSchedulerPauseState(file)).paused).toBe(false);
  });

  it("pause-status reflects the current state", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-schedpause-cli-")), "p.json");
    const h = harness(file);
    await h.program.parseAsync(["scheduler", "pause-status"], { from: "user" });
    expect(h.out.join("")).toMatch(/Running \(not paused\)/);
    h.out.length = 0;
    await h.program.parseAsync(["scheduler", "pause"], { from: "user" });
    h.out.length = 0;
    await h.program.parseAsync(["scheduler", "pause-status"], { from: "user" });
    expect(h.out.join("")).toMatch(/Paused/);
  });
});
