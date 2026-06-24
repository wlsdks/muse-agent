import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { type BackgroundProcessRecord } from "@muse/stores";

import { formatBackgroundProcessList, registerBackgroundCommand } from "../src/commands-background.js";

const rec = (over: Partial<BackgroundProcessRecord>): BackgroundProcessRecord => ({
  id: "p", pid: 4242, command: "npm run dev", startedAt: "2026-06-24T00:00:00.000Z", status: "running", ...over
});

describe("formatBackgroundProcessList", () => {
  it("reports the empty case", () => {
    expect(formatBackgroundProcessList([])).toBe("No background processes.");
  });

  it("summarizes counts and lists each process with status + command", () => {
    const out = formatBackgroundProcessList([rec({ id: "a" }), rec({ id: "b", status: "exited", exitCode: 0 })]);
    expect(out).toContain("2 background process(es), 1 running");
    expect(out).toContain("a  [running]  npm run dev  — pid 4242");
    expect(out).toContain("b  [exited]  npm run dev  — exited (exit 0)");
  });
});

const ORIG = process.env.MUSE_BACKGROUND_PROCESSES_FILE;
afterEach(() => {
  if (ORIG === undefined) delete process.env.MUSE_BACKGROUND_PROCESSES_FILE;
  else process.env.MUSE_BACKGROUND_PROCESSES_FILE = ORIG;
});

function harness(storeFile: string) {
  const out: string[] = [];
  const err: string[] = [];
  process.env.MUSE_BACKGROUND_PROCESSES_FILE = storeFile;
  const program = new Command();
  program.exitOverride();
  registerBackgroundCommand(program, { stdout: (m) => out.push(m), stderr: (m) => err.push(m) });
  return { program, out, err };
}

describe("muse bg (read-only command)", () => {
  it("bg list prints the registry", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [rec({ id: "x" })] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "list"], { from: "user" });
    expect(h.out.join("")).toContain("x  [running]  npm run dev");
  });

  it("bg logs <id> prints the captured log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-bgcmd-"));
    const logFile = join(dir, "x.log");
    writeFileSync(logFile, "server listening on :3000", "utf8");
    const store = join(dir, "p.json");
    writeFileSync(store, JSON.stringify({ processes: [rec({ id: "x", logFile })] }), "utf8");
    const h = harness(store);
    await h.program.parseAsync(["bg", "logs", "x"], { from: "user" });
    expect(h.out.join("")).toContain("server listening on :3000");
  });

  it("bg logs <id> errors for an unknown id", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "logs", "nope"], { from: "user" });
    expect(h.err.join("")).toContain("No background process with id 'nope'");
  });

  it("bg stop <id> errors for an unknown id (no process signalled)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "stop", "nope"], { from: "user" });
    expect(h.err.join("")).toContain("No background process with id 'nope'");
  });

  it("bg run REFUSES a catastrophic command and starts nothing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "run", "--", "rm", "-rf", "/"], { from: "user" });
    expect(h.err.join("")).toMatch(/refused/i);
    expect(JSON.parse(readFileSync(file, "utf8")).processes).toEqual([]);
  });

  it("bg run starts a real background command and records it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "run", "--", process.execPath, "-e", "process.exit(0)"], { from: "user" });
    expect(h.out.join("")).toMatch(/Started 'bg-/);
    expect(JSON.parse(readFileSync(file, "utf8")).processes).toHaveLength(1);
  });
});
