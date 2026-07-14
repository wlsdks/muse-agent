import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerSchedulerCommands, type SchedulerSetupHelpers } from "./commands-scheduler-setup.js";
import type { ProgramIO } from "./program.js";

function captureIo(): { io: ProgramIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { err, io: { stderr: (m: string) => err.push(m), stdout: (m: string) => out.push(m) } as ProgramIO, out };
}

const UNREACHABLE = (): never => {
  throw new Error("Muse API server is not running (tried http://127.0.0.1:3030) — start it with `pnpm --filter @muse/api dev`.");
};

function helpers(apiCalls: string[] = []): SchedulerSetupHelpers {
  return {
    apiRequest: async (_io, _command, path: string) => {
      apiCalls.push(path);
      return UNREACHABLE();
    },
    writeOutput: () => undefined
  };
}

async function run(io: ProgramIO, apiCalls: string[], args: readonly string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSchedulerCommands(program, io, helpers(apiCalls));
  await program.parseAsync(["node", "muse", ...args], { from: "node" });
}

let savedFile: string | undefined;
let file: string;

beforeEach(() => {
  savedFile = process.env.MUSE_SCHEDULED_JOBS_FILE;
  file = join(mkdtempSync(join(tmpdir(), "muse-scheduler-cli-")), "scheduled-jobs.json");
  process.env.MUSE_SCHEDULED_JOBS_FILE = file;
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.MUSE_SCHEDULED_JOBS_FILE;
  else process.env.MUSE_SCHEDULED_JOBS_FILE = savedFile;
});

describe("muse scheduler add — local-first, no API server required (AC4)", () => {
  it("creates a job directly against the local file store, never touching the API", async () => {
    const { io, out } = captureIo();
    const apiCalls: string[] = [];
    await run(io, apiCalls, ["scheduler", "add", "오늘 일정 요약해서 보내줘", "--every", "매일 아침 9시"]);

    expect(apiCalls).toEqual([]);
    expect(out.join("")).toContain("Scheduled");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: readonly Record<string, unknown>[] };
    expect(raw.jobs).toHaveLength(1);
    expect(raw.jobs[0]!.cronExpression).toBe("0 9 * * *");
    expect(raw.jobs[0]!.agentPrompt).toBe("오늘 일정 요약해서 보내줘");
  });

  it("accepts an EN cadence form too", async () => {
    const { io } = captureIo();
    const apiCalls: string[] = [];
    await run(io, apiCalls, ["scheduler", "add", "summarize my day", "--every", "every monday 9am"]);

    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: readonly Record<string, unknown>[] };
    expect(raw.jobs[0]!.cronExpression).toBe("0 9 * * 1");
  });

  it("rejects an unrecognized cadence — fail-close, lists accepted forms, writes NOTHING to the store", async () => {
    const { io, err } = captureIo();
    const apiCalls: string[] = [];
    await run(io, apiCalls, ["scheduler", "add", "do a thing", "--every", "whenever I feel like it"]);

    expect(err.join("")).toContain("Accepted forms");
    expect(apiCalls).toEqual([]);
    // A rejected cadence never even TOUCHES the store — the file is never created.
    expect(existsSync(file)).toBe(false);
  });

  it("--deliver sets notificationChannelId for a per-job routing override", async () => {
    const { io } = captureIo();
    const apiCalls: string[] = [];
    await run(io, apiCalls, ["scheduler", "add", "ping me", "--every", "hourly", "--deliver", "telegram:98765"]);

    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: readonly Record<string, unknown>[] };
    expect(raw.jobs[0]!.notificationChannelId).toBe("telegram:98765");
  });

  it("a blank prompt is rejected before any store write", async () => {
    const { io, err } = captureIo();
    const apiCalls: string[] = [];
    await run(io, apiCalls, ["scheduler", "add", "  ", "--every", "hourly"]);

    expect(err.join("")).toContain("usage:");
    expect(existsSync(file)).toBe(false);
  });
});

describe("muse scheduler list / remove — local-first (AC4)", () => {
  it("list shows a created job and its cron; empty store shows onboarding guidance", async () => {
    const { io: emptyIo, out: emptyOut } = captureIo();
    await run(emptyIo, [], ["scheduler", "list"]);
    expect(emptyOut.join("")).toContain("No scheduled jobs");

    const { io: addIo } = captureIo();
    await run(addIo, [], ["scheduler", "add", "daily brief", "--every", "매일 09:00"]);

    const { io: listIo, out: listOut } = captureIo();
    const apiCalls: string[] = [];
    await run(listIo, apiCalls, ["scheduler", "list"]);
    expect(apiCalls).toEqual([]);
    expect(listOut.join("")).toContain("daily brief");
    expect(listOut.join("")).toContain("0 9 * * *");
  });

  it("remove deletes a job by id; a missing id errors with exit code 1", async () => {
    const { io: addIo, out: addOut } = captureIo();
    await run(addIo, [], ["scheduler", "add", "one-off brief", "--every", "hourly"]);
    const id = /Scheduled '.*' \(([^)]+)\)/.exec(addOut.join(""))?.[1];
    expect(id).toBeTruthy();

    const { io: removeIo, out: removeOut } = captureIo();
    const apiCalls: string[] = [];
    await run(removeIo, apiCalls, ["scheduler", "remove", id!]);
    expect(apiCalls).toEqual([]);
    expect(removeOut.join("")).toContain("Deleted");

    const raw = JSON.parse(readFileSync(file, "utf8")) as { jobs: readonly Record<string, unknown>[] };
    expect(raw.jobs).toHaveLength(0);
  });

  it("the 'delete' alias resolves to the same local-first remove", async () => {
    const { io: addIo, out: addOut } = captureIo();
    await run(addIo, [], ["scheduler", "add", "alias-test", "--every", "hourly"]);
    const id = /Scheduled '.*' \(([^)]+)\)/.exec(addOut.join(""))?.[1];

    const { io: deleteIo, err: deleteErr } = captureIo();
    const before = process.exitCode;
    await run(deleteIo, [], ["scheduler", "delete", id!]);
    expect(deleteErr.join("")).toBe("");
    process.exitCode = before;
  });

  it("removing an unknown id fails with exit code 1 and does not throw", async () => {
    const { io, err } = captureIo();
    const before = process.exitCode;
    await run(io, [], ["scheduler", "remove", "not-a-real-id"]);
    expect(err.join("")).toContain("no job with id");
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });
});
