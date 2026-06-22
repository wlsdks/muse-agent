import { describe, expect, it } from "vitest";
import type { PersistedTask } from "@muse/stores";

import { formatTaskQueue, rankTasksByUrgency, TASK_AGING_DAYS, taskEffectiveDueMs } from "./task-priority.js";

const NOW = Date.parse("2026-06-05T12:00:00Z");
const DAY = 86_400_000;

function task(over: Partial<PersistedTask> & { id: string }): PersistedTask {
  return { createdAt: new Date(NOW).toISOString(), status: "open", title: over.id, ...over };
}

describe("taskEffectiveDueMs", () => {
  it("uses the real dueAt for a dated task (pure EDF)", () => {
    const due = NOW + 3 * DAY;
    expect(taskEffectiveDueMs(task({ id: "a", dueAt: new Date(due).toISOString() }), NOW)).toBe(due);
  });

  it("floats an urgent undated task to now", () => {
    expect(taskEffectiveDueMs(task({ id: "u", urgent: true }), NOW)).toBe(NOW);
  });

  it("urgent never makes a task LESS urgent than its own overdue deadline", () => {
    const overdue = NOW - 2 * DAY;
    expect(taskEffectiveDueMs(task({ id: "u", urgent: true, dueAt: new Date(overdue).toISOString() }), NOW)).toBe(overdue);
  });

  it("ages an undated task to createdAt + TASK_AGING_DAYS", () => {
    const created = NOW - 5 * DAY;
    expect(taskEffectiveDueMs(task({ id: "old", createdAt: new Date(created).toISOString() }), NOW))
      .toBe(created + TASK_AGING_DAYS * DAY);
  });
});

describe("rankTasksByUrgency", () => {
  it("orders overdue > urgent-undated > due-soon > aging-undated, and drops done tasks", () => {
    const ranked = rankTasksByUrgency([
      task({ id: "soon", dueAt: new Date(NOW + 2 * DAY).toISOString() }),
      task({ id: "overdue", dueAt: new Date(NOW - 1 * DAY).toISOString() }),
      task({ id: "urgent" , urgent: true }),
      task({ id: "fresh-undated", createdAt: new Date(NOW).toISOString() }),
      task({ id: "done", status: "done", dueAt: new Date(NOW - 5 * DAY).toISOString() })
    ], NOW);
    expect(ranked.map((r) => r.task.id)).toEqual(["overdue", "urgent", "soon", "fresh-undated"]);
    expect(ranked.some((r) => r.task.id === "done")).toBe(false);
  });

  it("an aged undated task surfaces above a far-future dated task", () => {
    const ranked = rankTasksByUrgency([
      task({ id: "far", dueAt: new Date(NOW + 60 * DAY).toISOString() }),
      task({ id: "stale", createdAt: new Date(NOW - 13 * DAY).toISOString() })
    ], NOW);
    expect(ranked[0]?.task.id).toBe("stale"); // createdAt+14d = NOW+1d  <  NOW+60d
  });

  it("annotates the why-now reason", () => {
    const ranked = rankTasksByUrgency([
      task({ id: "od", dueAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({ id: "due", dueAt: new Date(NOW + 3 * DAY).toISOString() }),
      task({ id: "u", urgent: true }),
      task({ id: "age", createdAt: new Date(NOW - 4 * DAY).toISOString() })
    ], NOW);
    const reason = (id: string): string => ranked.find((r) => r.task.id === id)?.reason ?? "";
    expect(reason("od")).toContain("overdue 2d");
    expect(reason("due")).toContain("due in 3d");
    expect(reason("u")).toBe("urgent");
    expect(reason("age")).toContain("aging");
  });
});

describe("formatTaskQueue", () => {
  it("marks the top task and honours the limit with a +more hint", () => {
    const ranked = rankTasksByUrgency([
      task({ id: "a", dueAt: new Date(NOW - 3 * DAY).toISOString() }),
      task({ id: "b", dueAt: new Date(NOW - 2 * DAY).toISOString() }),
      task({ id: "c", dueAt: new Date(NOW - 1 * DAY).toISOString() })
    ], NOW);
    const out = formatTaskQueue(ranked, 2);
    expect(out).toContain("→ 1. a");
    expect(out).toContain("…and 1 more");
    expect(out).not.toContain("3. c");
  });

  it("celebrates an empty queue", () => {
    expect(formatTaskQueue([])).toContain("you're clear");
  });
});
