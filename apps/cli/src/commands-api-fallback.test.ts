import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTasks, writeReminders, type PersistedTask, type PersistedReminder } from "@muse/stores";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerRemindCommands, type RemindCommandHelpers } from "./commands-remind.js";
import { registerTasksCommands, type TasksCommandHelpers } from "./commands-tasks.js";

const UNREACHABLE = (): never => {
  throw new Error("Muse API not reachable at http://127.0.0.1:3030 — start it with `pnpm --filter @muse/api dev`.");
};

function captureIo(): { io: { stdout: (m: string) => void; stderr: (m: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { err, io: { stderr: (m) => err.push(m), stdout: (m) => out.push(m) }, out };
}

const ENV_KEYS = ["MUSE_TASKS_FILE", "MUSE_REMINDERS_FILE"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("CLI read commands auto-fall back to local stores when the API daemon is down", () => {
  it("`tasks list` (no --local) falls back to the local tasks file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fb-tasks-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    const now = new Date().toISOString();
    await writeTasks(file, [{ createdAt: now, id: "t1", status: "open", title: "Call dentist" }] as PersistedTask[]);

    const { io, out, err } = captureIo();
    const helpers: TasksCommandHelpers = {
      apiRequest: async () => UNREACHABLE(),
      writeOutput: (_io, value) => out.push(JSON.stringify(value))
    };
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", "list"]);

    expect(out.join("\n")).toContain("Call dentist");
    expect(err.join("")).toMatch(/not reachable|local/i);
  });

  it("`remind list` (no --local) falls back to the local reminders file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "fb-rem-")), "reminders.json");
    process.env.MUSE_REMINDERS_FILE = file;
    const now = new Date().toISOString();
    await writeReminders(file, [{ createdAt: now, dueAt: now, id: "r1", status: "pending", text: "Stretch break" }] as PersistedReminder[]);

    const { io, out, err } = captureIo();
    const helpers: RemindCommandHelpers = {
      apiRequest: async () => UNREACHABLE(),
      writeOutput: (_io, value) => out.push(JSON.stringify(value))
    };
    const program = new Command();
    program.exitOverride();
    registerRemindCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "remind", "list"]);

    expect(out.join("\n")).toContain("Stretch break");
    expect(err.join("")).toMatch(/not reachable|local/i);
  });
});
