import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTasks, type PersistedTask } from "@muse/stores";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerAttunementCommands } from "./commands-attunement.js";

interface Fixture {
  readonly attunementFile: string;
  readonly notesDir: string;
  readonly taskFile: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "muse-attunement-cli-"));
  const notesDir = join(root, "notes");
  mkdirSync(notesDir);
  return { attunementFile: join(root, "attunement.json"), notesDir, taskFile: join(root, "tasks.json") };
}

async function run(fixture: Fixture, args: string[]): Promise<{ readonly exitCode: number | undefined; readonly stderr: string; readonly stdout: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = {
    MUSE_ATTUNEMENT_FILE: process.env.MUSE_ATTUNEMENT_FILE,
    MUSE_NOTES_DIR: process.env.MUSE_NOTES_DIR,
    MUSE_TASKS_FILE: process.env.MUSE_TASKS_FILE
  };
  process.env.MUSE_ATTUNEMENT_FILE = fixture.attunementFile;
  process.env.MUSE_NOTES_DIR = fixture.notesDir;
  process.env.MUSE_TASKS_FILE = fixture.taskFile;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerAttunementCommands(program, { stderr: (line: string) => stderr.push(line), stdout: (line: string) => stdout.push(line) });
    await program.parseAsync(["node", "muse", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function threadId(output: string): string {
  const id = output.match(/thread_[\w-]+/u)?.[0];
  expect(id).toBeTruthy();
  return id!;
}

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  id: "task_8f046e20-cb0b-4c75-82ac-9fc357cfe9b1",
  notes: "Ask Jamie which flowers they prefer.",
  status: "open",
  title: "Send the flower options"
};

describe("muse thread / continue — Personal Continuity", () => {
  it("requires an explicit equal life/work kind — there is no hidden default", async () => {
    const f = fixture();
    const missing = await run(f, ["thread", "start", "Plan", "the", "week"]);
    expect(missing.exitCode).toBe(1);

    const life = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const work = await run(f, ["thread", "start", "Prepare", "the", "launch", "--kind", "work"]);
    expect(life.stdout).toContain("Started life thread");
    expect(work.stdout).toContain("Started work thread");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[life]");
    expect((await run(f, ["thread", "list"])).stdout).toContain("[work]");
  });

  it("links canonical local sources, opens a grounded pack, and applies outcome without a model", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    writeFileSync(join(f.notesDir, "birthday.md"), "# Birthday ideas\nJamie likes a small garden dinner.\n", "utf8");
    const started = await run(f, ["thread", "start", "Plan", "a", "birthday", "--kind", "life"]);
    const id = threadId(started.stdout);

    // Task prefix is accepted at the CLI boundary, but status/pack output uses
    // the canonical full ID persisted by the store.
    expect((await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "next-step"])).stdout)
      .toContain(TASK.id);
    expect((await run(f, ["thread", "link", id, "note", "birthday.md", "--role", "context"])).stdout)
      .toContain("note:birthday.md");

    const continued = await run(f, ["continue", id]);
    expect(continued.exitCode).toBeUndefined();
    expect(continued.stdout).toContain("Plan a birthday [life]");
    expect(continued.stdout).toContain(`[task:${TASK.id}] Send the flower options`);
    expect(continued.stdout).toContain("Birthday ideas");
    const deliveryId = continued.stdout.match(/Delivery: (delivery_[\w-]+)/u)?.[1];
    expect(deliveryId).toBeTruthy();

    const outcome = await run(f, ["thread", "outcome", deliveryId!, "ignored"]);
    expect(outcome.stdout).toContain("Recorded ignored");
    const next = await run(f, ["thread", "continue", id]);
    expect(next.stdout).toContain("Previous pack: ignored");
  });

  it("an OPEN task linked as context (not next-step) names the gap + the exact fix, not a misleading 'no task linked' (dogfood)", async () => {
    const f = fixture();
    await writeTasks(f.taskFile, [TASK]);
    const started = await run(f, ["thread", "start", "Ship", "the", "migration", "--kind", "work"]);
    const id = threadId(started.stdout);
    await run(f, ["thread", "link", id, "task", TASK.id.slice(0, 13), "--role", "context"]);

    const continued = await run(f, ["continue", id]);
    // The old copy claimed "no open local task is linked" even though one is —
    // the accurate message names the LINKED task and the role change that sets it.
    // Assert the full next-step line (the task id also appears in the evidence
    // list, so a substring-only check wouldn't guard the contextTask branch).
    expect(continued.stdout).not.toContain("no open local task is linked");
    expect(continued.stdout).toContain(`Next step: none set — task ${TASK.id} is linked as context; re-link it with \`--role next-step\``);
  });

  it("fails closed rather than choosing a thread or escaping the notes vault", async () => {
    const f = fixture();
    const started = await run(f, ["thread", "start", "Keep", "a", "secret", "--kind", "life"]);
    const id = threadId(started.stdout);
    expect((await run(f, ["continue"])).stderr).toContain("thread id is required outside an interactive terminal");
    expect((await run(f, ["thread", "link", id, "note", "../secret.md", "--role", "context"])).stderr).toContain("must not contain '..'");

    const outside = join(tmpdir(), `muse-attunement-outside-${Date.now().toString()}.md`);
    writeFileSync(outside, "not in this vault", "utf8");
    symlinkSync(outside, join(f.notesDir, "escaped.md"));
    const escaped = await run(f, ["thread", "link", id, "note", "escaped.md", "--role", "context"]);
    expect(escaped.stderr).toContain("escapes the local notes vault");
  });
});
