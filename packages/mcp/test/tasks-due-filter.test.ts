import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTasksMcpServer, selectTasksDueWithin, writeTasks, type PersistedTask } from "../src/index.js";

const NOW = new Date("2026-05-25T12:00:00");
function task(id: string, dueAt: string | undefined, status: "open" | "done" = "open"): PersistedTask {
  return { createdAt: "2026-05-01T00:00:00", id, status, title: id, ...(dueAt ? { dueAt } : {}) };
}
const TASKS: PersistedTask[] = [
  task("overdue", "2026-05-23T09:00:00"),     // dayDiff -2
  task("today", "2026-05-25T18:00:00"),       // dayDiff 0
  task("in3", "2026-05-28T09:00:00"),         // dayDiff +3
  task("in10", "2026-06-04T09:00:00"),        // dayDiff +10
  task("undated", undefined),
  task("done-today", "2026-05-25T08:00:00", "done"),
  task("bad", "not-a-date")
];

describe("selectTasksDueWithin — shared due-window selector", () => {
  it("withinDays:0 → overdue + today only, overdue first", () => {
    expect(selectTasksDueWithin(TASKS, { now: NOW, withinDays: 0 }).map((d) => d.task.id)).toEqual(["overdue", "today"]);
  });

  it("withinDays:7 → overdue, today, in3 — excludes in10/undated/done/invalid", () => {
    expect(selectTasksDueWithin(TASKS, { now: NOW, withinDays: 7 }).map((d) => d.task.id)).toEqual(["overdue", "today", "in3"]);
  });

  it("carries the day offset (negative = overdue)", () => {
    const byId = new Map(selectTasksDueWithin(TASKS, { now: NOW, withinDays: 7 }).map((d) => [d.task.id, d.dayDiff]));
    expect(byId.get("overdue")).toBe(-2);
    expect(byId.get("today")).toBe(0);
    expect(byId.get("in3")).toBe(3);
  });

  it("defaults to withinDays:1 (today + overdue + tomorrow)", () => {
    expect(selectTasksDueWithin(TASKS, { now: NOW }).map((d) => d.task.id)).toEqual(["overdue", "today"]);
  });
});

describe("muse.tasks list — dueWithinDays filter", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-tasks-due-"));
    file = join(dir, "tasks.json");
    await writeTasks(file, TASKS);
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const listTool = () => createTasksMcpServer({ file, now: () => NOW }).tools.find((t) => t.name === "list")!;

  it("'what's due this week?' returns only the due-within-7 open tasks, overdue first", async () => {
    const out = await listTool().execute({ dueWithinDays: 7 }) as { dueWithinDays: number; total: number; tasks: Array<{ id: string }> };
    expect(out.dueWithinDays).toBe(7);
    expect(out.tasks.map((t) => t.id)).toEqual(["overdue", "today", "in3"]);
  });

  it("'what's due today?' (dueWithinDays:0) returns overdue + today", async () => {
    const out = await listTool().execute({ dueWithinDays: 0 }) as { tasks: Array<{ id: string }> };
    expect(out.tasks.map((t) => t.id)).toEqual(["overdue", "today"]);
  });

  it("WITHOUT dueWithinDays it lists by status (the prior behaviour)", async () => {
    const out = await listTool().execute({ status: "all" }) as { status: string; total: number };
    expect(out.status).toBe("all");
    expect(out.total).toBe(TASKS.length); // every task, no due filtering
  });

  it("caps the returned tasks at maxListEntries but reports the TRUE total (so the model can say 'and N more')", async () => {
    // A small local model chokes on a huge tool result; the agent path caps the
    // list, but `total` must stay the real count or the model thinks there are
    // only `shown` tasks. Open tasks in TASKS: overdue, today, in3, in10, undated, bad = 6.
    const capped = createTasksMcpServer({ file, maxListEntries: 2, now: () => NOW }).tools.find((t) => t.name === "list")!;
    const out = await capped.execute({ status: "open" }) as { shown: number; total: number; tasks: Array<{ id: string }> };
    expect(out.tasks).toHaveLength(2);
    expect(out.shown).toBe(2);
    expect(out.total).toBe(6); // true count, not the capped 2
  });
});

describe("muse.tasks list — tag filter", () => {
  let dir: string;
  let file: string;
  const TAGGED: PersistedTask[] = [
    { createdAt: "2026-05-01T00:00:00", dueAt: "2026-05-26T09:00:00", id: "t-work1", status: "open", tags: ["work"], title: "ship report" }, // due +1
    { createdAt: "2026-05-01T00:00:00", dueAt: "2026-05-26T09:00:00", id: "t-home", status: "open", tags: ["home"], title: "water plants" },
    { createdAt: "2026-05-01T00:00:00", id: "t-work2", status: "open", tags: ["Work", "urgent"], title: "email client" }, // undated, mixed-case tag
    { createdAt: "2026-05-01T00:00:00", id: "t-untagged", status: "open", title: "nap" }
  ];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-tasks-tag-"));
    file = join(dir, "tasks.json");
    await writeTasks(file, TAGGED);
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });
  const listTool = () => createTasksMcpServer({ file, now: () => NOW }).tools.find((t) => t.name === "list")!;

  it("filters to only tasks carrying the tag (case-insensitive exact label), echoing the tag; value flows", async () => {
    const out = await listTool().execute({ tag: "work" }) as { tag: string; total: number; tasks: Array<{ id: string; tags?: string[] }> };
    expect(out.tag).toBe("work");
    expect(out.tasks.map((t) => t.id).sort()).toEqual(["t-work1", "t-work2"]); // "Work" matches case-insensitively
    expect(out.total).toBe(2);
    expect(out.tasks.find((t) => t.id === "t-work1")?.tags).toContain("work"); // the tag really rides on the returned task
  });

  it("requires an EXACT label — no substring/partial match", async () => {
    const out = await listTool().execute({ tag: "wor" }) as { total: number; tasks: unknown[] };
    expect(out.total).toBe(0);
    expect(out.tasks).toEqual([]);
  });

  it("an empty / whitespace tag is ignored (lists normally, not zero)", async () => {
    const out = await listTool().execute({ tag: "   ", status: "all" }) as { total: number };
    expect(out.total).toBe(TAGGED.length);
  });

  it("combines with the dueWithinDays window — 'work tasks due this week' excludes the undated work task and the due-but-home task", async () => {
    const out = await listTool().execute({ dueWithinDays: 7, tag: "work" }) as { total: number; tasks: Array<{ id: string }> };
    expect(out.tasks.map((t) => t.id)).toEqual(["t-work1"]); // t-work2 undated, t-home not work
    expect(out.total).toBe(1);
  });
});

describe("tasks `list` tool keywords — list-intent reaches the tool, not just due-intent", () => {
  it("carries list-intent words (so '할 일 목록' / 'show my task list' relevance-match) plus the due words", () => {
    const server = createTasksMcpServer({ file: "/tmp/unused-tasks.json" });
    const list = server.tools.find((t) => t.name === "list");
    const kw = list?.keywords ?? [];
    // the bug: only due/마감 words → a plain list intent was blocked irrelevant.
    for (const w of ["list", "tasks", "todo", "할 일", "목록"]) expect(kw).toContain(w);
    // and the due-window words are still there for the dueWithinDays path.
    for (const w of ["due", "overdue", "마감"]) expect(kw).toContain(w);
  });
});
