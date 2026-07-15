import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { type BackgroundProcessRecord } from "@muse/stores";

import { formatBackgroundProcessList, formatUptime, isProcessAlive, registerBackgroundCommand, tailLines } from "../src/commands-background.js";

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

  it("shows compact uptime for a running process", () => {
    const out = formatBackgroundProcessList(
      [rec({ id: "a", startedAt: "2026-06-24T00:00:00.000Z" })],
      new Date("2026-06-24T02:30:00.000Z")
    );
    expect(out).toContain("pid 4242, up 2h");
  });
});

describe("isProcessAlive", () => {
  it("is true for the current process and false for a non-existent PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe("tailLines", () => {
  it("returns the last n lines, ignoring a single trailing newline", () => {
    expect(tailLines("a\nb\nc\nd\n", 2)).toBe("c\nd");
    expect(tailLines("a\nb\nc", 2)).toBe("b\nc");
  });
  it("returns all when n>=line count or n<=0", () => {
    expect(tailLines("a\nb", 5)).toBe("a\nb");
    expect(tailLines("a\nb", 0)).toBe("a\nb");
    expect(tailLines("a\nb", Number.NaN)).toBe("a\nb");
  });
});

describe("formatUptime", () => {
  const now = new Date("2026-06-24T03:00:00.000Z");
  it("formats minutes/hours/days compactly", () => {
    expect(formatUptime("2026-06-24T02:59:30.000Z", now)).toBe("<1m");
    expect(formatUptime("2026-06-24T02:45:00.000Z", now)).toBe("15m");
    expect(formatUptime("2026-06-24T01:00:00.000Z", now)).toBe("2h");
    expect(formatUptime("2026-06-21T03:00:00.000Z", now)).toBe("3d");
  });
  it("returns empty for an unparseable or future start", () => {
    expect(formatUptime("not-a-date", now)).toBe("");
    expect(formatUptime("2026-06-24T04:00:00.000Z", now)).toBe("");
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
    // use a live PID so the list's crash-reconcile keeps it 'running'
    writeFileSync(file, JSON.stringify({ processes: [rec({ id: "x", pid: process.pid })] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "list"], { from: "user" });
    expect(h.out.join("")).toContain("x  [running]  npm run dev");
  });

  it("bg list reconciles a dead-PID running record to exited, keeps a live one", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [
      rec({ id: "dead", pid: 2_147_483_646, status: "running" }),
      rec({ id: "live", pid: process.pid, status: "running" })
    ] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "list", "--json"], { from: "user" });
    const byId = Object.fromEntries((JSON.parse(h.out.join("")) as { processes: { id: string; status: string }[] }).processes.map((p) => [p.id, p.status]));
    expect(byId.dead).toBe("exited"); // PID gone -> reconciled
    expect(byId.live).toBe("running"); // our own PID is alive
  });

  it("bg list --json emits the registry as parseable JSON", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [rec({ id: "x" })] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "list", "--json"], { from: "user" });
    const parsed = JSON.parse(h.out.join("")) as { processes: { id: string }[] };
    expect(parsed.processes.map((p) => p.id)).toEqual(["x"]);
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

  it("bg logs <id> --tail shows only the last N lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-bgcmd-"));
    const logFile = join(dir, "x.log");
    writeFileSync(logFile, "line1\nline2\nline3\nline4\n", "utf8");
    const store = join(dir, "p.json");
    writeFileSync(store, JSON.stringify({ processes: [rec({ id: "x", logFile })] }), "utf8");
    const h = harness(store);
    await h.program.parseAsync(["bg", "logs", "x", "--tail", "2"], { from: "user" });
    const out = h.out.join("");
    expect(out).toContain("line3");
    expect(out).toContain("line4");
    expect(out).not.toContain("line1");
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

  it("bg prune removes finished processes and deletes their logs, keeping running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-bgcmd-"));
    const logFile = join(dir, "done.log");
    writeFileSync(logFile, "old output", "utf8");
    const store = join(dir, "p.json");
    writeFileSync(store, JSON.stringify({ processes: [rec({ id: "run", status: "running" }), rec({ id: "done", status: "exited", exitCode: 0, logFile })] }), "utf8");
    const h = harness(store);
    await h.program.parseAsync(["bg", "prune"], { from: "user" });
    expect(h.out.join("")).toMatch(/Pruned 1 finished/);
    expect(JSON.parse(readFileSync(store, "utf8")).processes.map((p: { id: string }) => p.id)).toEqual(["run"]);
    expect(existsSync(logFile)).toBe(false);
  });

  it("bg restart errors for an unknown id (nothing spawned)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "restart", "nope"], { from: "user" });
    expect(h.err.join("")).toContain("No background process with id 'nope'");
  });

  it("bg restart re-runs a recorded command as a new process", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgcmd-")), "p.json");
    writeFileSync(file, JSON.stringify({ processes: [{ id: "old", pid: 1, command: `"${process.execPath}" -e "process.exit(0)"`, startedAt: "2026-06-24T00:00:00.000Z", status: "exited", exitCode: 0 }] }), "utf8");
    const h = harness(file);
    await h.program.parseAsync(["bg", "restart", "old"], { from: "user" });
    expect(h.out.join("")).toMatch(/Restarted 'old' as 'bg-/);
    expect(JSON.parse(readFileSync(file, "utf8")).processes.some((p: { id: string }) => p.id.startsWith("bg-"))).toBe(true);
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
