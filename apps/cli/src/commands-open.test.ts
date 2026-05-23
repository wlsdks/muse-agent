import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { registerOpenCommand } from "./commands-open.js";
import type { ProgramIO } from "./program.js";

describe("muse open — scans the objectives store (it claims 'every store')", () => {
  const prev = process.env.MUSE_OBJECTIVES_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_OBJECTIVES_FILE;
    else process.env.MUSE_OBJECTIVES_FILE = prev;
  });

  it("resolves an obj_<id> prefix to the standing objective record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-open-obj-"));
    const file = join(dir, "objectives.json");
    writeFileSync(file, `${JSON.stringify({ objectives: [
      { id: "obj_abcdef123456", userId: "local", createdAt: "2026-05-12T00:00:00Z", spec: "watch the build until green", kind: "until", status: "active" }
    ] })}\n`, "utf8");
    process.env.MUSE_OBJECTIVES_FILE = file;
    // Point the other stores at the same dir's (absent) files so they read empty.
    process.env.MUSE_REMINDERS_FILE = join(dir, "reminders.json");
    process.env.MUSE_FOLLOWUPS_FILE = join(dir, "followups.json");
    process.env.MUSE_TASKS_FILE = join(dir, "tasks.json");

    const stdout: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) } as unknown as ProgramIO;
    const program = new Command();
    program.exitOverride();
    registerOpenCommand(program, io);
    await program.parseAsync(["node", "muse", "open", "obj_abcdef", "--json"], { from: "node" });

    const parsed = JSON.parse(stdout.join("")) as { kind?: string; record?: { id?: string; spec?: string } };
    expect(parsed.kind).toBe("objective");
    expect(parsed.record?.id).toBe("obj_abcdef123456");
    expect(parsed.record?.spec).toBe("watch the build until green");
  });
});
