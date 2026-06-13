import { describe, expect, it } from "vitest";

import { type PersistedTask, readTaskStatusFilter, resolveTaskRef, serializeTask, serializeTaskForModel } from "../src/personal-tasks-store.js";

const base: PersistedTask = { id: "t1", title: "buy milk", status: "open", createdAt: "2026-01-01T00:00:00Z" };

describe("resolveTaskRef — complete/update a task by id OR a word from its title (one shot, not a 2-step search)", () => {
  const tasks: PersistedTask[] = [
    { id: "task_1", title: "Buy milk", status: "open", createdAt: "2026-01-01T00:00:00Z" },
    { id: "task_2", title: "Email the Q3 deck", status: "open", createdAt: "2026-01-01T00:00:00Z" },
    { id: "task_3", title: "Buy milk for the office", status: "done", completedAt: "2026-01-02T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }
  ];

  it("resolves an exact id", () => {
    const r = resolveTaskRef(tasks, "task_2");
    expect(r.status === "resolved" && r.task.id).toBe("task_2");
  });

  it("resolves a unique TITLE word (what the model actually passes) to the task", () => {
    expect((resolveTaskRef(tasks, "Q3") as { task: PersistedTask }).task.id).toBe("task_2");
  });

  it("prefers the OPEN task when a word hits both an open and a done task", () => {
    // "milk" matches task_1 (open) and task_3 (done) → the open one wins (unique among open).
    expect((resolveTaskRef(tasks, "milk") as { task: PersistedTask }).task.id).toBe("task_1");
  });

  it("returns AMBIGUOUS candidates (never a guess) when multiple OPEN tasks match", () => {
    const two: PersistedTask[] = [
      { id: "a", title: "Call mom", status: "open", createdAt: "2026-01-01T00:00:00Z" },
      { id: "b", title: "Call the dentist", status: "open", createdAt: "2026-01-01T00:00:00Z" }
    ];
    const r = resolveTaskRef(two, "call");
    expect(r.status).toBe("ambiguous");
    expect(r.status === "ambiguous" && r.candidates.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns not-found for an empty ref or no match", () => {
    expect(resolveTaskRef(tasks, "").status).toBe("not-found");
    expect(resolveTaskRef(tasks, "groceries").status).toBe("not-found");
  });

  // resolveTaskRef gates the DESTRUCTIVE tasks.delete. The match is a LITERAL
  // substring (`.includes`), not a regex — so a regex-metachar ref can't match-all
  // and delete a random task. Mutating `.includes` → a regex `.test` turns these RED.
  it("matches a ref LITERALLY, not as a regex — '.*' / '.' are not substrings → not-found, never match-all", () => {
    expect(resolveTaskRef(tasks, ".*").status).toBe("not-found");
    expect(resolveTaskRef(tasks, ".").status).toBe("not-found");
  });
});

describe("serializeTask", () => {
  it("emits only the required fields for a minimal task", () => {
    expect(serializeTask(base)).toEqual({
      createdAt: "2026-01-01T00:00:00Z",
      id: "t1",
      status: "open",
      title: "buy milk",
    });
  });

  it("includes every optional field when present", () => {
    expect(
      serializeTask({
        ...base,
        status: "done",
        completedAt: "2026-01-02T00:00:00Z",
        dueAt: "2026-01-03T00:00:00Z",
        notes: "remember the brand",
        tags: ["home", "errand"],
        proactive: false,
        urgent: true,
      }),
    ).toEqual({
      createdAt: "2026-01-01T00:00:00Z",
      id: "t1",
      status: "done",
      title: "buy milk",
      completedAt: "2026-01-02T00:00:00Z",
      dueAt: "2026-01-03T00:00:00Z",
      notes: "remember the brand",
      tags: ["home", "errand"],
      proactive: false,
      urgent: true,
    });
  });

  it("omits an empty tag list", () => {
    expect(serializeTask({ ...base, tags: [] })).not.toHaveProperty("tags");
  });

  it("emits proactive only when explicitly false and urgent only when explicitly true", () => {
    const out = serializeTask({ ...base, proactive: true, urgent: false });
    expect(out).not.toHaveProperty("proactive");
    expect(out).not.toHaveProperty("urgent");
  });
});

describe("serializeTaskForModel — the model-facing serialization adds dueAtLocal for dated tasks", () => {
  it("appends a LOCAL-time dueAtLocal when the task has a dueAt (so the model doesn't echo the UTC hour)", () => {
    const now = (): Date => new Date("2026-06-04T01:00:00.000Z");
    const out = serializeTaskForModel({ ...base, dueAt: "2026-06-05T06:00:00.000Z" }, now);
    expect(out).toMatchObject(serializeTask({ ...base, dueAt: "2026-06-05T06:00:00.000Z" }));
    // The LOCAL clock hour, not the bare ISO "06". (In KST this is 3 PM; in UTC, 6 AM.)
    const localHour = new Date("2026-06-05T06:00:00.000Z").getHours();
    const hour12 = (localHour % 12) || 12;
    const ampm = localHour < 12 ? "AM" : "PM";
    expect(out["dueAtLocal"]).toContain(`${String(hour12)}:00`);
    expect(out["dueAtLocal"]).toContain(ampm);
    expect(out["dueAtLocal"]).not.toContain("T06:00");
  });

  it("leaves an UNDATED task untouched (no dueAtLocal field)", () => {
    const out = serializeTaskForModel(base, () => new Date("2026-06-04T01:00:00.000Z"));
    expect(out).toEqual(serializeTask(base));
    expect(out).not.toHaveProperty("dueAtLocal");
  });
});

describe("readTaskStatusFilter", () => {
  it("passes through the recognised 'done' and 'all' filters", () => {
    expect(readTaskStatusFilter("done")).toBe("done");
    expect(readTaskStatusFilter("all")).toBe("all");
  });

  it("defaults to 'open' for unset, empty, or unrecognised values", () => {
    expect(readTaskStatusFilter("open")).toBe("open");
    expect(readTaskStatusFilter(undefined)).toBe("open");
    expect(readTaskStatusFilter("")).toBe("open");
    expect(readTaskStatusFilter("fired")).toBe("open");
  });
});
