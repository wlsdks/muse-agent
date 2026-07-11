import { describe, expect, it } from "vitest";

import { buildTaskContextBlock } from "./context-blocks.js";

// Minimal PersistedTask-shaped stub (only the fields the block builder reads).
function task(id: string, title: string, extra: { dueAt?: string; urgent?: boolean } = {}) {
  return { id, title, status: "open", createdAt: "2026-01-01T00:00:00.000Z", ...extra } as never;
}

describe("buildTaskContextBlock — <<task N>> grounding block", () => {
  it("empty list → the no-tasks placeholder (no crash)", () => {
    expect(buildTaskContextBlock([])).toBe("(no open tasks)");
  });

  it("wraps each task with its 1-based number, id, title, and the canonical [task: <title>] citation form", () => {
    const block = buildTaskContextBlock([task("t1", "buy milk"), task("t2", "call Bob")]);
    expect(block).toContain("<<task 1 — t1>>");
    expect(block).toContain("\nbuy milk\n[task: buy milk]\n<<end>>");
    expect(block).toContain("<<task 2 — t2>>");
    expect(block).toContain("[task: call Bob]");
    // citation embeds the TITLE (what the title-matching gate expects), not the id
    expect(block).not.toContain("[task: t1]");
  });

  it("marks an urgent task with [URGENT] in the wrapper header", () => {
    const block = buildTaskContextBlock([task("t1", "ship release", { urgent: true })]);
    expect(block).toContain("<<task 1 — t1 [URGENT]>>");
  });

  it("appends a human-readable local due when dueAt is set; omits it otherwise", () => {
    const withDue = buildTaskContextBlock([task("t1", "file taxes", { dueAt: "2026-04-15T17:00:00.000Z" })]);
    expect(withDue).toMatch(/file taxes \(due .+\)/u);
    const noDue = buildTaskContextBlock([task("t1", "file taxes")]);
    expect(noDue).toContain("file taxes\n[task: file taxes]");
    expect(noDue).not.toContain("(due ");
  });

  it("separates multiple tasks with a blank line", () => {
    const block = buildTaskContextBlock([task("t1", "a"), task("t2", "b")]);
    expect(block).toContain("<<end>>\n\n<<task 2");
  });
});
