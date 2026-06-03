import { describe, expect, it } from "vitest";

import { type PersistedTask, readTaskStatusFilter, serializeTask, serializeTaskForModel } from "../src/personal-tasks-store.js";

const base: PersistedTask = { id: "t1", title: "buy milk", status: "open", createdAt: "2026-01-01T00:00:00Z" };

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
