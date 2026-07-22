import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { errorMessage } from "@muse/shared";
import { createPersonalThread } from "@muse/attunement";
import { addTask, writeBoard } from "@muse/multi-agent";
import { FileScheduledJobStore } from "@muse/scheduler";
import { getWork, readWorks, type PersistedWork } from "@muse/stores";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatWorkDetail, formatWorkList, registerWorksCommands, type WorksCommandHelpers } from "./commands-work.js";

const ENV_KEYS = ["MUSE_WORKS_FILE", "MUSE_ATTUNEMENT_FILE", "MUSE_BOARD_FILE", "MUSE_SCHEDULED_JOBS_FILE"] as const;
let previousEnv: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "muse-work-cli-"));
  process.env.MUSE_WORKS_FILE = join(root, "works.json");
  process.env.MUSE_ATTUNEMENT_FILE = join(root, "attunement.json");
  process.env.MUSE_BOARD_FILE = join(root, "board.json");
  process.env.MUSE_SCHEDULED_JOBS_FILE = join(root, "scheduled-jobs.json");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe("formatWorkList / formatWorkDetail — pure formatting", () => {
  const work: PersistedWork = {
    boardTaskIds: ["board_1"],
    createdAtIso: "2026-07-17T00:00:00.000Z",
    flowIds: ["job_1"],
    goal: "다음 주 토요일까지 준비 끝내기",
    id: "work_123e4567-e89b-4d3a-a456-426614174000",
    name: "생일 파티 준비",
    outcomes: [{ atIso: "2026-07-17T09:00:00.000Z", kind: "used", note: "helped" }],
    status: "active",
    threadId: "thread_1",
    updatedAtIso: "2026-07-17T00:00:00.000Z"
  };

  it("formats an empty list with a real, runnable CLI example", () => {
    expect(formatWorkList([])).toContain("muse work start");
  });

  it("formats a populated list with name/status/goal", () => {
    const rendered = formatWorkList([work]);
    expect(rendered).toContain("생일 파티 준비");
    expect(rendered).toContain("active");
    expect(rendered).toContain("다음 주 토요일까지 준비 끝내기");
    expect(rendered).toContain(`muse thread link <thread-id> work ${work.id} --role context`);
  });

  it("cannot inject list lines or advertise an ineligible continuity reference", () => {
    const rendered = formatWorkList([{ ...work, goal: "\u0000\t", name: "\u0000\nforged" }]);
    expect(rendered).not.toContain("\nforged");
    expect(rendered).not.toContain("muse thread link");
    expect(rendered).toContain("unsafe Work text hidden");
  });

  it("sanitizes eligible hostile text while retaining the exact continuity command", () => {
    const rendered = formatWorkList([{
      ...work,
      goal: "safe goal\nforged-goal",
      name: "safe name\u001b[31m\nforged-name"
    }]);
    expect(rendered).not.toContain("\nforged-goal");
    expect(rendered).not.toContain("\nforged-name");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain(`muse thread link <thread-id> work ${work.id} --role context`);
  });

  it("formats the full detail — links + outcomes", () => {
    const rendered = formatWorkDetail(work);
    expect(rendered).toContain("job_1");
    expect(rendered).toContain("board_1");
    expect(rendered).toContain("thread_1");
    expect(rendered).toContain("used");
    expect(rendered).toContain("helped");
  });
});

function noopHelpers(overrides: Partial<WorksCommandHelpers> = {}): WorksCommandHelpers {
  return {
    apiRequest: async () => { throw new Error("apiRequest must not be called in --local mode"); },
    writeOutput: () => {},
    ...overrides
  };
}

function buildProgram(io: { stdout: (m: string) => void; stderr: (m: string) => void }, helpers: WorksCommandHelpers): Command {
  const program = new Command();
  program.exitOverride();
  registerWorksCommands(program, io, helpers);
  return program;
}

describe("muse work start/list/show --local — a real store round-trip", () => {
  it("creates, lists, and shows a Work via the local file (no API call)", async () => {
    const out: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => out.push(m) };
    const program = buildProgram(io, noopHelpers());

    await program.parseAsync(["node", "muse", "work", "start", "생일", "파티", "준비", "--goal", "다음 주 토요일까지", "--local"]);
    expect(out.join("")).toContain("생일 파티 준비");

    const stored = await readWorks(process.env.MUSE_WORKS_FILE!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ goal: "다음 주 토요일까지", name: "생일 파티 준비", status: "active" });

    out.length = 0;
    await program.parseAsync(["node", "muse", "work", "list", "--local"]);
    expect(out.join("")).toContain("생일 파티 준비");

    out.length = 0;
    await program.parseAsync(["node", "muse", "work", "show", stored[0]!.id, "--local"]);
    expect(out.join("")).toContain("다음 주 토요일까지");
  });

  it("the SHORT display id `work start` prints round-trips through `work show` (the reported truncated-id defect)", async () => {
    const out: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => out.push(m) };
    const program = buildProgram(io, noopHelpers());

    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const started = out.join("");
    const shortId = /Started \[([^\]]+)\]/.exec(started)?.[1];
    expect(shortId).toBeTruthy();

    const full = (await readWorks(process.env.MUSE_WORKS_FILE!))[0]!.id;
    // The printed id really is a truncated prefix, not the full uuid — otherwise this
    // test would pass trivially without exercising prefix resolution at all.
    expect(shortId!.length).toBeLessThan(full.length);
    expect(full.startsWith(shortId!)).toBe(true);

    out.length = 0;
    await program.parseAsync(["node", "muse", "work", "show", shortId!, "--local"]);
    expect(out.join("")).toContain("plan it");
  });

  it("rejects a whitespace-only name/goal without touching the store", async () => {
    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "   ", "--goal", "goal", "--local"]);
    expect(await readWorks(process.env.MUSE_WORKS_FILE!)).toHaveLength(0);
    await program.parseAsync(["node", "muse", "work", "start", "Name", "--goal", "  ", "--local"]);
    expect(await readWorks(process.env.MUSE_WORKS_FILE!)).toHaveLength(0);
  });
});

describe("muse work link --local — referential integrity against the REAL scheduler/board/attunement stores", () => {
  it("links a REAL scheduler job and REFUSES a nonexistent one, leaving the store unchanged", async () => {
    const jobStore = new FileScheduledJobStore();
    const job = await jobStore.save({ cronExpression: "0 9 * * *", enabled: true, jobType: "agent", name: "Morning brief" });

    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);

    await program.parseAsync(["node", "muse", "work", "link", work!.id, "flow", job.id, "--local"]);
    expect((await getWork(process.env.MUSE_WORKS_FILE!, work!.id))?.flowIds).toEqual([job.id]);

    const before = await readWorks(process.env.MUSE_WORKS_FILE!);
    // The link command reports a refusal via stderr + process.exitCode, not a
    // throw (exitOverride only fires on a commander-level parse error).
    await program.parseAsync(["node", "muse", "work", "link", work!.id, "flow", "job_missing", "--local"]);
    expect(await readWorks(process.env.MUSE_WORKS_FILE!)).toEqual(before);
  });

  it("links a REAL board task", async () => {
    const tasks = addTask([], { id: "board_task_1", title: "Book the venue" }, "2026-07-17T00:00:00.000Z");
    await writeBoard(process.env.MUSE_BOARD_FILE!, tasks);

    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);

    await program.parseAsync(["node", "muse", "work", "link", work!.id, "task", "board_task_1", "--local"]);
    expect((await getWork(process.env.MUSE_WORKS_FILE!, work!.id))?.boardTaskIds).toEqual(["board_task_1"]);
  });

  it("links a REAL continuity thread", async () => {
    const thread = await createPersonalThread(process.env.MUSE_ATTUNEMENT_FILE!, { kind: "life", title: "Prepare birthday" }, { idFactory: () => "thread_cli_1" });

    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);

    await program.parseAsync(["node", "muse", "work", "link", work!.id, "thread", thread.id, "--local"]);
    expect((await getWork(process.env.MUSE_WORKS_FILE!, work!.id))?.threadId).toBe(thread.id);
  });

  it("rejects an unknown link kind without calling the store at all", async () => {
    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);
    await program.parseAsync(["node", "muse", "work", "link", work!.id, "nonsense-kind", "x", "--local"]);
    expect((await getWork(process.env.MUSE_WORKS_FILE!, work!.id))?.flowIds).toEqual([]);
  });
});

describe("muse work outcome / done / delete --local", () => {
  it("records an outcome, marks done, then deletes — never touching a linked flow/task/thread store", async () => {
    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);

    await program.parseAsync(["node", "muse", "work", "outcome", work!.id, "used", "it", "helped", "--local"]);
    const withOutcome = await getWork(process.env.MUSE_WORKS_FILE!, work!.id);
    expect(withOutcome?.outcomes).toMatchObject([{ kind: "used", note: "it helped" }]);

    await program.parseAsync(["node", "muse", "work", "done", work!.id, "--local"]);
    expect((await getWork(process.env.MUSE_WORKS_FILE!, work!.id))?.status).toBe("done");

    await program.parseAsync(["node", "muse", "work", "delete", work!.id, "--local"]);
    expect(await getWork(process.env.MUSE_WORKS_FILE!, work!.id)).toBeUndefined();
  });

  it("rejects an invalid outcome kind without mutating the store", async () => {
    const io = { stderr: () => {}, stdout: () => {} };
    const program = buildProgram(io, noopHelpers());
    await program.parseAsync(["node", "muse", "work", "start", "Trip", "--goal", "plan it", "--local"]);
    const [work] = await readWorks(process.env.MUSE_WORKS_FILE!);
    const before = await readWorks(process.env.MUSE_WORKS_FILE!);
    await program.parseAsync(["node", "muse", "work", "outcome", work!.id, "nonsense", "--local"]);
    expect(await readWorks(process.env.MUSE_WORKS_FILE!)).toEqual(before);
  });
});

interface ApiCall {
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly method?: string;
}

async function runWork(args: string[]): Promise<{ readonly error?: string; readonly apiCalls: readonly ApiCall[] }> {
  const apiCalls: ApiCall[] = [];
  const io = { stderr: () => {}, stdout: () => {} };
  const helpers: WorksCommandHelpers = {
    apiRequest: async (_io, _command, path, body, method) => {
      apiCalls.push({ body, method, path });
      return { goal: String(body?.goal ?? ""), id: "work_remote", name: String(body?.name ?? ""), status: "active" };
    },
    writeOutput: () => {}
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerWorksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "work", ...args]);
  } catch (cause) {
    error = errorMessage(cause);
  }
  return { apiCalls, ...(error ? { error } : {}) };
}

describe("muse work — API mode calls the exact endpoint/body/method", () => {
  it("start → POST /api/works {name, goal}", async () => {
    const { apiCalls, error } = await runWork(["start", "생일", "파티", "준비", "--goal", "다음 주까지"]);
    expect(error).toBeUndefined();
    expect(apiCalls).toEqual([{ body: { goal: "다음 주까지", name: "생일 파티 준비" }, method: "POST", path: "/api/works" }]);
  });

  it("link flow → POST /api/works/:id/link {kind, id}", async () => {
    const { apiCalls } = await runWork(["link", "work_1", "flow", "job_1"]);
    expect(apiCalls).toEqual([{ body: { id: "job_1", kind: "flow" }, method: "POST", path: "/api/works/work_1/link" }]);
  });

  it("link --unlink → DELETE /api/works/:id/link {kind, id}", async () => {
    const { apiCalls } = await runWork(["link", "work_1", "task", "task_1", "--unlink"]);
    expect(apiCalls).toEqual([{ body: { id: "task_1", kind: "task" }, method: "DELETE", path: "/api/works/work_1/link" }]);
  });

  it("outcome → POST /api/works/:id/outcome {kind, note}", async () => {
    const { apiCalls } = await runWork(["outcome", "work_1", "adjusted", "changed", "the", "plan"]);
    expect(apiCalls).toEqual([{ body: { kind: "adjusted", note: "changed the plan" }, method: "POST", path: "/api/works/work_1/outcome" }]);
  });

  it("done → PATCH /api/works/:id {status: done}", async () => {
    const { apiCalls } = await runWork(["done", "work_1"]);
    expect(apiCalls).toEqual([{ body: { status: "done" }, method: "PATCH", path: "/api/works/work_1" }]);
  });

  it("delete → DELETE /api/works/:id", async () => {
    const { apiCalls } = await runWork(["delete", "work_1"]);
    expect(apiCalls).toEqual([{ body: undefined, method: "DELETE", path: "/api/works/work_1" }]);
  });
});
