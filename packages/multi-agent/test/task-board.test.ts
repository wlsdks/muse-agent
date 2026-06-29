import { describe, expect, it } from "vitest";

import { addTask, expandTaskIntoSubtasks, lastFailureReason, nextReadyTask, recordTaskRun, retryTask, taskDepsMet, transitionTask, type AgentTask } from "../src/task-board.js";

const task = (over: Partial<AgentTask> & { id: string }): AgentTask => ({
  createdAt: "2026-06-28T00:00:00Z",
  dependsOn: [],
  runs: [],
  status: "todo",
  title: over.id,
  updatedAt: "2026-06-28T00:00:00Z",
  ...over
});

describe("agent task board — the durable Kanban coordination core", () => {
  describe("taskDepsMet / nextReadyTask — dependency-gated readiness", () => {
    it("a task with no deps is ready", () => {
      expect(taskDepsMet(task({ id: "a" }), [])).toBe(true);
    });
    it("a task is NOT ready until every dep is done", () => {
      const board = [task({ id: "a", status: "in_progress" }), task({ id: "b", dependsOn: ["a"] })];
      expect(taskDepsMet(board[1]!, board)).toBe(false);
      board[0] = { ...board[0]!, status: "done" };
      expect(taskDepsMet(board[1]!, board)).toBe(true);
    });
    it("a missing dependency is treated as unmet (never silently runnable)", () => {
      expect(taskDepsMet(task({ id: "b", dependsOn: ["ghost"] }), [task({ id: "b" })])).toBe(false);
    });
    it("nextReadyTask returns the OLDEST runnable todo, skipping dependency-blocked ones", () => {
      const board = [
        task({ createdAt: "2026-06-28T02:00:00Z", id: "second" }),
        task({ createdAt: "2026-06-28T01:00:00Z", dependsOn: ["x"], id: "blocked" }), // older but waiting on x (not done)
        task({ createdAt: "2026-06-28T03:00:00Z", id: "third" }),
        task({ id: "x", status: "in_progress" })
      ];
      expect(nextReadyTask(board)?.id).toBe("second"); // oldest READY (blocked's dep x isn't done)
    });
    it("nextReadyTask is undefined when nothing is runnable (all done / in flight / waiting)", () => {
      expect(nextReadyTask([task({ id: "a", status: "done" }), task({ id: "b", status: "in_progress" })])).toBeUndefined();
    });
  });

  describe("transitions + run history (retry-with-reason)", () => {
    it("transitionTask moves status + assignee, stamps updatedAt, leaves others untouched", () => {
      const board = [task({ id: "a" }), task({ id: "b" })];
      const next = transitionTask(board, "a", "in_progress", "2026-06-28T05:00:00Z", "worker-1");
      expect(next[0]).toMatchObject({ assignee: "worker-1", status: "in_progress", updatedAt: "2026-06-28T05:00:00Z" });
      expect(next[1]).toBe(board[1]); // untouched (same ref)
    });
    it("a FAILED run → blocked + records the reason (for human input + retry replay)", () => {
      const out = recordTaskRun([task({ id: "a", status: "in_progress" })], "a", { at: "2026-06-28T06:00:00Z", reason: "API 500", status: "failed" });
      expect(out[0]).toMatchObject({ blockedReason: "API 500", status: "blocked" });
      expect(out[0]!.runs).toHaveLength(1);
    });
    it("a COMPLETED run → done and clears any prior blockedReason", () => {
      const out = recordTaskRun([task({ blockedReason: "old", id: "a", status: "blocked" })], "a", { at: "2026-06-28T07:00:00Z", status: "completed" });
      expect(out[0]!.status).toBe("done");
      expect(out[0]!.blockedReason).toBeUndefined();
    });
    it("retryTask re-queues a blocked task (→ todo) KEEPING its run history; a non-blocked task is unchanged", () => {
      const blocked = recordTaskRun([task({ id: "a", status: "in_progress" })], "a", { at: "t1", reason: "rate limit", status: "failed" });
      const retried = retryTask(blocked, "a", "t2");
      expect(retried[0]).toMatchObject({ status: "todo" });
      expect(retried[0]!.runs).toHaveLength(1); // history preserved → retry can replay the reason
      expect(lastFailureReason(retried[0]!)).toBe("rate limit");
      const done = [task({ id: "a", status: "done" })];
      expect(retryTask(done, "a", "t3")).toEqual(done); // not blocked → no-op
    });
  });
});

describe("expandTaskIntoSubtasks — board-as-handoff (a complex task → sub-task DAG)", () => {
  const subs = [{ id: "s1", title: "step one" }, { id: "s2", title: "step two" }, { id: "s3", title: "step three" }];
  it("adds the sub-tasks as a sequential chain and rewires the parent to depend on them + marks it decomposed", () => {
    const board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "big goal" }, "t0"), "p", subs, "t1");
    expect(board.find((t) => t.id === "s1")!.dependsOn).toEqual([]);
    expect(board.find((t) => t.id === "s2")!.dependsOn).toEqual(["s1"]); // chained
    expect(board.find((t) => t.id === "s3")!.dependsOn).toEqual(["s2"]);
    const parent = board.find((t) => t.id === "p")!;
    expect(parent.decomposed).toBe(true);
    expect(parent.dependsOn).toEqual(["s1", "s2", "s3"]); // waits on every sub-task
  });
  it("the dispatcher runs the chain IN ORDER (s1 → s2 → s3), the parent never first", () => {
    let board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "big goal" }, "t0"), "p", subs, "t1");
    expect(nextReadyTask(board)!.id).toBe("s1");           // only s1 is ready (s2/s3 wait, parent waits)
    board = transitionTask(board, "s1", "done", "t2");
    expect(nextReadyTask(board)!.id).toBe("s2");
    board = transitionTask(board, "s2", "done", "t3");
    expect(nextReadyTask(board)!.id).toBe("s3");
    board = transitionTask(board, "s3", "done", "t4");
    expect(nextReadyTask(board)!.id).toBe("p");            // only NOW is the container ready
  });
  it("is a no-op on a missing parent, an already-decomposed parent, or a non-decomposition (<2 sub-tasks)", () => {
    const base = addTask([], { id: "p", title: "g" }, "t0");
    expect(expandTaskIntoSubtasks(base, "ghost", subs, "t1")).toEqual(base);
    expect(expandTaskIntoSubtasks(base, "p", [{ id: "only", title: "one" }], "t1")).toEqual(base);
    const once = expandTaskIntoSubtasks(base, "p", subs, "t1");
    expect(expandTaskIntoSubtasks(once, "p", [{ id: "x1", title: "a" }, { id: "x2", title: "b" }], "t2")).toEqual(once); // already decomposed
  });
});
