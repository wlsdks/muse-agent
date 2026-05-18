import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendActionLog, type ActionLogEntry } from "@muse/mcp";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerActionsCommands } from "./commands-actions.js";

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_ACTION_LOG_FILE;
  process.env.MUSE_ACTION_LOG_FILE = file;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerActionsCommands(program, io);
    await program.parseAsync(["node", "muse", "actions", ...args]);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (prev === undefined) delete process.env.MUSE_ACTION_LOG_FILE;
    else process.env.MUSE_ACTION_LOG_FILE = prev;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-actions-")), "action-log.json");
}

function entry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    id: "a1",
    objectiveId: "obj_ship",
    result: "performed",
    userId: "local",
    what: "objective met — user notified",
    when: "2026-05-19T12:00:00.000Z",
    why: "ship the release",
    ...overrides
  };
}

describe("muse actions — the P6 accountability read surface", () => {
  it("lists recorded autonomous actions newest-first with rationale", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "old", when: "2026-05-19T10:00:00.000Z" }));
    await appendActionLog(file, entry({ id: "new", when: "2026-05-19T14:00:00.000Z", why: "newer" }));
    const r = await run(file, []);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout.indexOf("newer")).toBeLessThan(r.stdout.indexOf("ship the release"));
    expect(r.stdout).toContain("[performed]  objective met — user notified (obj_ship) — newer");
  });

  it("empty log → friendly message, not an error", async () => {
    expect((await run(logFile(), [])).stdout).toBe("No recorded actions.\n");
  });

  it("--result filters and --user scopes (default 'local'); 'all' shows every bucket", async () => {
    const file = logFile();
    await appendActionLog(file, entry({ id: "p", result: "performed", userId: "local" }));
    await appendActionLog(file, entry({ id: "r", result: "refused", userId: "local", what: "blocked X" }));
    await appendActionLog(file, entry({ id: "o", result: "performed", userId: "stark", what: "stark thing" }));
    expect((await run(file, ["--result", "refused"])).stdout).toContain("blocked X");
    expect((await run(file, ["--result", "refused"])).stdout).not.toContain("objective met");
    expect((await run(file, [])).stdout).not.toContain("stark thing");
    expect((await run(file, ["--user", "all"])).stdout).toContain("stark thing");
  });

  it("--limit caps the newest-first slice", async () => {
    const file = logFile();
    for (let i = 0; i < 5; i += 1) {
      await appendActionLog(file, entry({ id: `e${i}`, when: `2026-05-19T1${i}:00:00.000Z`, why: `w${i}` }));
    }
    const r = await run(file, ["--limit", "2"]);
    expect(r.stdout.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect(r.stdout).toContain("w4");
    expect(r.stdout).not.toContain("w0");
  });

  it("rejects an unknown --result with a hint, and a non-positive --limit", async () => {
    const f = logFile();
    const r1 = await run(f, ["--result", "perfomed"]);
    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain("--result must be one of");
    expect(r1.stderr).toContain("did you mean 'performed'");
    const r2 = await run(f, ["--limit", "0"]);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain("--limit must be a positive integer");
  });
});
