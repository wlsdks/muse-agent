import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTasks, writeTasks, type PersistedTask } from "@muse/stores";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { filterTasksByDue, filterTasksBySearch, filterTasksByTag, formatOpenLoops, parseDueWindow, registerTasksCommands, resolveLocalTaskId, type TasksCommandHelpers } from "./commands-tasks.js";

describe("filterTasksByTag — keep only tasks carrying a tag (case-insensitive)", () => {
  const tasks = [
    { title: "Pay rent", tags: ["home", "Finance"] },
    { title: "Ship PR", tags: ["work"] },
    { title: "No tags" }
  ];
  it("matches the tag case-insensitively", () => {
    expect(filterTasksByTag(tasks, "finance").map((t) => t.title)).toEqual(["Pay rent"]);
    expect(filterTasksByTag(tasks, "WORK").map((t) => t.title)).toEqual(["Ship PR"]);
  });
  it("returns all on a blank tag, none on a no-match or tagless set", () => {
    expect(filterTasksByTag(tasks, "  ")).toHaveLength(3);
    expect(filterTasksByTag(tasks, "nope")).toHaveLength(0);
    const tagless: Array<{ title: string; tags?: string[] }> = [{ title: "x" }];
    expect(filterTasksByTag(tagless, "home")).toHaveLength(0);
  });
});

describe("filterTasksBySearch — find a task by title or notes (case-insensitive)", () => {
  const tasks = [
    { notes: "ring the office", title: "Call dentist" },
    { title: "Buy milk" },
    { notes: "Dr. Smith", title: "Schedule checkup" }
  ];
  it("matches the title", () => {
    expect(filterTasksBySearch(tasks, "dentist").map((t) => t.title)).toEqual(["Call dentist"]);
  });
  it("matches the notes (case-insensitive)", () => {
    expect(filterTasksBySearch(tasks, "OFFICE").map((t) => t.title)).toEqual(["Call dentist"]);
  });
  it("returns all on an empty query, none on a no-match", () => {
    expect(filterTasksBySearch(tasks, "  ")).toHaveLength(3);
    expect(filterTasksBySearch(tasks, "zzz")).toHaveLength(0);
  });
});

describe("parseDueWindow", () => {
  it("parses the keywords and a numeric day count", () => {
    expect(parseDueWindow("overdue")).toEqual({ kind: "overdue" });
    expect(parseDueWindow("TODAY")).toEqual({ kind: "today" });
    expect(parseDueWindow("week")).toEqual({ days: 7, kind: "within" });
    expect(parseDueWindow("3")).toEqual({ days: 3, kind: "within" });
  });
  it("rejects unknown values and a zero/negative count", () => {
    expect(parseDueWindow("soon")).toBeUndefined();
    expect(parseDueWindow("0")).toBeUndefined();
    expect(parseDueWindow("")).toBeUndefined();
  });
});

describe("filterTasksByDue — keep only tasks due within a window", () => {
  const NOW = Date.parse("2026-06-10T12:00:00Z");
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const tasks = [
    { dueAt: iso(NOW - 2 * day), title: "overdue" },
    { dueAt: iso(NOW + 3 * day), title: "in 3 days" },
    { dueAt: iso(NOW + 10 * day), title: "in 10 days" },
    { title: "no due date" }
  ];

  it("overdue = strictly past due; excludes future + undated", () => {
    expect(filterTasksByDue(tasks, { kind: "overdue" }, NOW).map((t) => t.title)).toEqual(["overdue"]);
  });

  it("within N includes overdue AND future-within, excludes beyond-window + undated", () => {
    expect(filterTasksByDue(tasks, { days: 7, kind: "within" }, NOW).map((t) => t.title)).toEqual(["overdue", "in 3 days"]);
    expect(filterTasksByDue(tasks, { days: 14, kind: "within" }, NOW).map((t) => t.title)).toEqual(["overdue", "in 3 days", "in 10 days"]);
  });

  it("today = due on the current local calendar day only", () => {
    const localNow = Date.now();
    const todayTask = { dueAt: new Date(localNow).toISOString(), title: "today" };
    const tomorrowTask = { dueAt: new Date(localNow + day).toISOString(), title: "tomorrow" };
    expect(filterTasksByDue([todayTask, tomorrowTask], { kind: "today" }, localNow).map((t) => t.title)).toEqual(["today"]);
  });

  it("excludes tasks with an unparseable dueAt", () => {
    expect(filterTasksByDue([{ dueAt: "not-a-date", title: "junk" }], { kind: "overdue" }, NOW)).toHaveLength(0);
  });
});

describe("muse tasks list --local --search — filters the real store", () => {
  const prev = process.env.MUSE_TASKS_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_TASKS_FILE;
    else process.env.MUSE_TASKS_FILE = prev;
  });

  it("returns only the matching task via --json", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-search-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    const now = new Date().toISOString();
    const seed: PersistedTask[] = [
      { createdAt: now, id: "t1", status: "open", title: "Call dentist" },
      { createdAt: now, id: "t2", status: "open", title: "Buy milk" }
    ];
    await writeTasks(file, seed);

    const out: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => out.push(m) };
    const helpers: TasksCommandHelpers = {
      apiRequest: async () => { throw new Error("apiRequest must not be called in --local mode"); },
      writeOutput: (_io, value) => out.push(JSON.stringify(value))
    };
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", "list", "--local", "--search", "dentist", "--json"]);
    const payload = JSON.parse(out.join("")) as { tasks: { title: string }[]; total: number };
    expect(payload.total).toBe(1);
    expect(payload.tasks.map((t) => t.title)).toEqual(["Call dentist"]);
  });
});

describe("muse tasks — API-unreachable falls back to the local store (local-first reliability)", () => {
  const prev = process.env.MUSE_TASKS_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_TASKS_FILE;
    else process.env.MUSE_TASKS_FILE = prev;
  });

  const runWith = async (apiRequest: TasksCommandHelpers["apiRequest"], args: string[]): Promise<string | undefined> => {
    const io = { stderr: () => {}, stdout: () => {} };
    const helpers: TasksCommandHelpers = { apiRequest, writeOutput: () => {} };
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    try {
      await program.parseAsync(["node", "muse", "tasks", ...args]);
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  };
  const unreachable: TasksCommandHelpers["apiRequest"] = async () => {
    throw new Error("muse: Muse API not reachable at http://127.0.0.1:3030");
  };

  it("add: an unreachable API writes the task LOCALLY instead of hard-erroring", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-fb-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    const error = await runWith(unreachable, ["add", "review", "the", "deck"]);
    expect(error).toBeUndefined();
    const stored = await readTasks(file);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "open", title: "review the deck" });
  });

  it("add: a REAL api error (NOT unreachable) still throws — the fallback never masks a 500", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-fb-err-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    const serverError: TasksCommandHelpers["apiRequest"] = async () => { throw new Error("HTTP 500 internal server error"); };
    const error = await runWith(serverError, ["add", "review", "the", "deck"]);
    expect(error).toContain("500");
    expect(await readTasks(file)).toHaveLength(0); // not silently written locally on a real error
  });

  it("complete: an unreachable API marks the task done in the LOCAL store", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-fb-cmp-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    await writeTasks(file, [{ createdAt: new Date().toISOString(), id: "task_abc1234", status: "open", title: "ship it" }]);
    const error = await runWith(unreachable, ["complete", "task_abc1234"]);
    expect(error).toBeUndefined();
    expect((await readTasks(file))[0]).toMatchObject({ status: "done" });
  });

  it("complete: re-completing an ALREADY-done task PRESERVES the original completedAt (idempotent, no silent rewrite)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-redo-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    const originalCompletedAt = "2026-01-15T10:00:00.000Z";
    await writeTasks(file, [{ completedAt: originalCompletedAt, createdAt: "2026-01-01T00:00:00.000Z", id: "task_done9", status: "done", title: "shipped" }]);
    const error = await runWith(async () => ({}), ["complete", "task_done9", "--local"]);
    expect(error).toBeUndefined();
    // the original "when it was done" is intact, NOT rewritten to now
    expect((await readTasks(file))[0]?.completedAt).toBe(originalCompletedAt);
  });
});

interface ApiCall {
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly method?: string;
}

async function runTasks(args: string[]): Promise<{
  readonly error?: string;
  readonly apiCalls: readonly ApiCall[];
}> {
  const apiCalls: ApiCall[] = [];
  const io = { stderr: () => {}, stdout: () => {} };
  const helpers: TasksCommandHelpers = {
    apiRequest: async (_io, _command, path, body, method) => {
      apiCalls.push({ body, method, path });
      return { id: "task_remote", status: "open", title: String(body?.title ?? "") };
    },
    writeOutput: () => {}
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", "add", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiCalls, error };
}

describe("muse tasks add — pre-dispatch --due validation", () => {
  it("remote mode rejects an invalid --due with the actionable error BEFORE any API call", async () => {
    const r = await runTasks(["ship", "the", "release", "--due", "blah-not-a-time"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("ISO-8601");
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });

  it("remote mode still sends a VALID --due raw to the API (server stays the resolution authority)", async () => {
    const r = await runTasks(["stand", "up", "--due", "in 3 hours"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.path).toBe("/api/tasks");
    expect(r.apiCalls[0]!.body).toMatchObject({ dueAt: "in 3 hours", title: "stand up" });
  });

  it("a task with no --due still posts (no spurious dueAt, no validation error)", async () => {
    const r = await runTasks(["just", "a", "title"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.body).toMatchObject({ title: "just a title" });
    expect(r.apiCalls[0]!.body?.dueAt).toBeUndefined();
  });

  it("local mode keeps rejecting an invalid --due with the same actionable error", async () => {
    const r = await runTasks(["--local", "do", "thing", "--due", "still-not-a-time"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });
});

describe("resolveLocalTaskId — typo-tolerant id resolution", () => {
  const tasks = [
    { createdAt: "2026-05-19T10:00:00.000Z", id: "task_abc123def", status: "open" as const, title: "alpha" },
    { createdAt: "2026-05-19T11:00:00.000Z", id: "task_xyz789ghi", status: "open" as const, title: "beta" }
  ];

  it("returns the exact id when found", () => {
    expect(resolveLocalTaskId("task_abc123def", tasks)).toBe("task_abc123def");
  });

  it("resolves an unambiguous prefix to the full id", () => {
    expect(resolveLocalTaskId("task_abc", tasks)).toBe("task_abc123def");
  });

  it("rejects an ambiguous prefix with the count + guidance", () => {
    expect(() => resolveLocalTaskId("task_", tasks)).toThrow(/ambiguous task prefix 'task_' matched 2 tasks/u);
  });

  it("suggests the closest existing id on a near-miss typo (one-char swap on the trailing char)", () => {
    expect(() => resolveLocalTaskId("task_abc123dex", tasks))
      .toThrow(/task not found: task_abc123dex — did you mean 'task_abc123def'/u);
  });

  it("rejects an unrelated input WITHOUT a guess (no random suggestion noise)", () => {
    expect(() => resolveLocalTaskId("totallyunrelated", tasks))
      .toThrow(/task not found: totallyunrelated$/u);
  });
});

describe("resolveLocalTaskId — by TITLE (CLI parity with the agent's by-name complete)", () => {
  const tasks = [
    { createdAt: "2026-05-19T10:00:00.000Z", id: "task_abc123def", status: "open" as const, title: "Buy groceries" },
    { createdAt: "2026-05-19T11:00:00.000Z", id: "task_xyz789ghi", status: "open" as const, title: "Call the dentist" }
  ];

  it("resolves a task by a case-insensitive title substring (no uuid needed)", () => {
    expect(resolveLocalTaskId("groceries", tasks)).toBe("task_abc123def");
    expect(resolveLocalTaskId("DENTIST", tasks)).toBe("task_xyz789ghi");
  });

  it("rejects an ambiguous title with the candidate titles, never guessing", () => {
    const two = [
      { createdAt: "2026-05-19T10:00:00.000Z", id: "task_a", status: "open" as const, title: "review the budget" },
      { createdAt: "2026-05-19T11:00:00.000Z", id: "task_b", status: "open" as const, title: "review the roadmap" }
    ];
    expect(() => resolveLocalTaskId("review", two))
      .toThrow(/'review' matches 2 tasks: 'review the budget', 'review the roadmap'/u);
  });

  it("prefers an OPEN task over a done one when both titles match", () => {
    const mixed = [
      { completedAt: "2026-05-18T09:00:00.000Z", createdAt: "2026-05-17T10:00:00.000Z", id: "task_done", status: "done" as const, title: "pay rent" },
      { createdAt: "2026-05-19T11:00:00.000Z", id: "task_open", status: "open" as const, title: "pay rent" }
    ];
    expect(resolveLocalTaskId("pay rent", mixed)).toBe("task_open");
  });

  it("still throws not-found when neither id nor title matches", () => {
    expect(() => resolveLocalTaskId("nonexistent", tasks)).toThrow(/task not found: nonexistent/u);
  });
});

describe("formatOpenLoops — Zeigarnik open-loops readout (C4)", () => {
  it("all-clear when there are no loops", () => {
    expect(formatOpenLoops([])).toContain("No open loops");
  });
  it("lists each planless loop with its age + how to close it", () => {
    const out = formatOpenLoops([{ title: "file taxes", ageDays: 40 }, { title: "call dentist", ageDays: 15 }]);
    expect(out).toContain("file taxes — open 40d, no plan");
    expect(out).toContain("call dentist");
    expect(out).toContain("--due");
  });
});

describe("muse tasks list — help text describes the actual order", () => {
  const prev = process.env.MUSE_TASKS_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_TASKS_FILE;
    else process.env.MUSE_TASKS_FILE = prev;
  });

  function listCommand(): Command {
    const io = { stderr: () => {}, stdout: () => {} };
    const helpers: TasksCommandHelpers = {
      apiRequest: async () => { throw new Error("unused"); },
      writeOutput: () => {}
    };
    const program = new Command();
    registerTasksCommands(program, io, helpers);
    const tasks = program.commands.find((c) => c.name() === "tasks");
    const list = tasks?.commands.find((c) => c.name() === "list");
    if (!list) throw new Error("tasks list command not registered");
    return list;
  }

  // RED→GREEN lock for the fix itself: the --help text must state the real
  // sort (by due date) and not the false "newest-first" it used to claim.
  it("description states the real sort (by due date), not the false 'newest-first'", () => {
    const description = listCommand().description();
    expect(description).toMatch(/due date/i);
    expect(description).not.toMatch(/newest-first/i);
  });

  it("and the --local --json order matches that claim (soonest-due first)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-tasks-order-")), "tasks.json");
    process.env.MUSE_TASKS_FILE = file;
    // A is created earlier but due SOONER; B is newest but due LATER.
    const seed: PersistedTask[] = [
      { createdAt: "2026-06-10T00:00:00.000Z", dueAt: "2026-06-15T00:00:00.000Z", id: "A", status: "open", title: "a" },
      { createdAt: "2026-06-13T00:00:00.000Z", dueAt: "2026-06-20T00:00:00.000Z", id: "B", status: "open", title: "b" }
    ];
    await writeTasks(file, seed);
    const out: string[] = [];
    const io = { stderr: () => {}, stdout: (m: string) => out.push(m) };
    const helpers: TasksCommandHelpers = {
      apiRequest: async () => { throw new Error("apiRequest must not be called in --local mode"); },
      writeOutput: (_io, value) => out.push(JSON.stringify(value))
    };
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", "list", "--local", "--json"]);
    const payload = JSON.parse(out.join("")) as { tasks: { id: string }[] };
    expect(payload.tasks.map((t) => t.id)).toEqual(["A", "B"]);
  });
});

describe("muse tasks add --due — past-due heads-up (sibling parity with `remind add`)", () => {
  const prev = process.env.MUSE_TASKS_FILE;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_TASKS_FILE;
    else process.env.MUSE_TASKS_FILE = prev;
  });

  async function runAdd(args: string[]): Promise<{ stderr: string }> {
    const stderr: string[] = [];
    const io = { stderr: (m: string) => stderr.push(m), stdout: () => {} };
    const helpers: TasksCommandHelpers = { apiRequest: async () => ({}), writeOutput: () => {} };
    const program = new Command();
    program.exitOverride();
    registerTasksCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "tasks", ...args]);
    return { stderr: stderr.join("") };
  }

  it("warns when --due is in the PAST (a typo'd / overdue date), like remind add", async () => {
    process.env.MUSE_TASKS_FILE = join(mkdtempSync(join(tmpdir(), "muse-tasks-past-")), "tasks.json");
    const { stderr } = await runAdd(["add", "Pay rent", "--local", "--due", "2020-01-01T00:00:00.000Z"]);
    expect(stderr).toContain("PAST");
  });

  it("does NOT warn for a future --due (no false positive)", async () => {
    process.env.MUSE_TASKS_FILE = join(mkdtempSync(join(tmpdir(), "muse-tasks-future-")), "tasks.json");
    const { stderr } = await runAdd(["add", "Renew passport", "--local", "--due", "2999-01-01T00:00:00.000Z"]);
    expect(stderr).not.toContain("PAST");
  });

  it("suppresses the heads-up under --json (parity with remind)", async () => {
    process.env.MUSE_TASKS_FILE = join(mkdtempSync(join(tmpdir(), "muse-tasks-json-")), "tasks.json");
    const { stderr } = await runAdd(["add", "Pay rent", "--local", "--json", "--due", "2020-01-01T00:00:00.000Z"]);
    expect(stderr).not.toContain("PAST");
  });
});
