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
});
