import { describe, expect, it } from "vitest";

import { addTask, DEFAULT_BOARD_MAX_DEPTH, expandTaskIntoSubtasks, lastFailureReason, latestOutput, nextReadyTask, reclaimStaleTasks, recordTaskRun, removeTask, resolveBoardMaxDepth, retryTask, staleInProgressTasks, taskDepsMet, transitionTask, type AgentTask } from "../src/task-board.js";

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

describe("expandTaskIntoSubtasks — depth ceiling (bounded recursive decomposition)", () => {
  const subs = [{ id: "s1", title: "step one" }, { id: "s2", title: "step two" }];
  it("a fresh depth-0 parent gets depth-1 sub-tasks, and is decomposed", () => {
    const board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "big goal" }, "t0"), "p", subs, "t1");
    expect(board.find((t) => t.id === "s1")!.depth).toBe(1);
    expect(board.find((t) => t.id === "s2")!.depth).toBe(1);
    expect(board.find((t) => t.id === "p")!.decomposed).toBe(true);
  });
  it("a task without a `depth` field is treated as depth 0 (back-compat)", () => {
    const parentNoDepth: AgentTask = task({ id: "p", title: "legacy task" });
    const board = expandTaskIntoSubtasks([parentNoDepth], "p", subs, "t1");
    expect(board.find((t) => t.id === "p")!.decomposed).toBe(true);
    expect(board.find((t) => t.id === "s1")!.depth).toBe(1);
  });
  it("a task AT maxDepth cannot expand — the board is unchanged, no sub-tasks added, parent not decomposed", () => {
    const atCeiling: AgentTask = { ...task({ id: "p", title: "already a sub-task" }), depth: 1 };
    const board = [atCeiling];
    const out = expandTaskIntoSubtasks(board, "p", subs, "t1", "sequential", 1);
    expect(out).toEqual(board);
    expect(out.find((t) => t.id === "s1")).toBeUndefined();
    expect(out.find((t) => t.id === "p")!.decomposed).toBeUndefined();
  });
  it("a depth-0 task expands fine with maxDepth 1 (the default ceiling only blocks depth ≥ 1)", () => {
    const parent: AgentTask = task({ id: "p", title: "top level" });
    const out = expandTaskIntoSubtasks([parent], "p", subs, "t1", "sequential", 1);
    expect(out.find((t) => t.id === "p")!.decomposed).toBe(true);
    expect(out.find((t) => t.id === "s1")!.depth).toBe(1);
  });
  it("a higher maxDepth (2) lets a depth-1 task expand into depth-2 sub-tasks", () => {
    const depthOneParent: AgentTask = { ...task({ id: "p", title: "a sub-task" }), depth: 1 };
    const out = expandTaskIntoSubtasks([depthOneParent], "p", subs, "t1", "sequential", 2);
    expect(out.find((t) => t.id === "p")!.decomposed).toBe(true);
    expect(out.find((t) => t.id === "s1")!.depth).toBe(2);
  });
  it("DEFAULT_BOARD_MAX_DEPTH is 1", () => {
    expect(DEFAULT_BOARD_MAX_DEPTH).toBe(1);
  });
});

describe("resolveBoardMaxDepth — MUSE_BOARD_MAX_DEPTH env parsing", () => {
  it("defaults to 1 when absent", () => {
    expect(resolveBoardMaxDepth({})).toBe(1);
  });
  it("MUSE_BOARD_MAX_DEPTH=2 → 2", () => {
    expect(resolveBoardMaxDepth({ MUSE_BOARD_MAX_DEPTH: "2" })).toBe(2);
  });
  it("MUSE_BOARD_MAX_DEPTH=0 floors to 1 (0 would forbid ALL decomposition)", () => {
    expect(resolveBoardMaxDepth({ MUSE_BOARD_MAX_DEPTH: "0" })).toBe(1);
  });
  it("a negative or non-integer value falls back to 1", () => {
    expect(resolveBoardMaxDepth({ MUSE_BOARD_MAX_DEPTH: "-1" })).toBe(1);
    expect(resolveBoardMaxDepth({ MUSE_BOARD_MAX_DEPTH: "abc" })).toBe(1);
  });
});

describe("expandTaskIntoSubtasks — parallel mode (#3, independent sub-tasks)", () => {
  const subs = [{ id: "s1", title: "research A" }, { id: "s2", title: "research B" }, { id: "s3", title: "research C" }];
  it("parallel mode gives each sub-task NO inter-dependency (all immediately runnable)", () => {
    const board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "compare A B C" }, "t0"), "p", subs, "t1", "parallel");
    expect(board.find((t) => t.id === "s1")!.dependsOn).toEqual([]);
    expect(board.find((t) => t.id === "s2")!.dependsOn).toEqual([]); // NOT chained (vs sequential)
    expect(board.find((t) => t.id === "s3")!.dependsOn).toEqual([]);
    expect(board.find((t) => t.id === "p")!.dependsOn).toEqual(["s1", "s2", "s3"]); // container still waits for all
  });
  it("all parallel sub-tasks are ready at once (a true fan-out, unlike the sequential chain)", () => {
    const board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "g" }, "t0"), "p", subs, "t1", "parallel");
    const ready = board.filter((t) => t.status === "todo" && taskDepsMet(t, board) && !t.decomposed);
    expect(ready.map((t) => t.id).sort()).toEqual(["s1", "s2", "s3"]); // all three runnable now
  });
  it("default mode stays sequential (backward-compatible)", () => {
    const board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "g" }, "t0"), "p", subs, "t1");
    expect(board.find((t) => t.id === "s2")!.dependsOn).toEqual(["s1"]); // chained
  });
});

describe("zombie recovery — staleInProgressTasks / reclaimStaleTasks (liveness)", () => {
  const NOW = Date.parse("2026-06-29T12:00:00Z");
  const STALE = 30 * 60 * 1000;
  const at = (iso: string, over: Partial<AgentTask> = {}): AgentTask => task({ id: "t", status: "in_progress", updatedAt: iso, ...over });
  it("flags an in-progress task older than the window; spares a recent one and non-in_progress", () => {
    const old = at("2026-06-29T11:00:00Z");               // 60 min old → stale
    const recent = at("2026-06-29T11:50:00Z", { id: "r" }); // 10 min → fresh
    const doneOld = at("2026-06-29T09:00:00Z", { id: "d", status: "done" });
    expect(staleInProgressTasks([old, recent, doneOld], NOW, STALE).map((t) => t.id)).toEqual(["t"]);
  });
  it("a non-parseable updatedAt is treated as not-stale (never reclaim on a bad timestamp)", () => {
    expect(staleInProgressTasks([at("not-a-date")], NOW, STALE)).toEqual([]);
  });
  it("reclaim moves a stale in-progress task → blocked with a reason; a crashed run is NOT auto-re-queued (no double-execute)", () => {
    const out = reclaimStaleTasks([at("2026-06-29T11:00:00Z")], NOW, STALE);
    expect(out[0]).toMatchObject({ status: "blocked" });
    expect(out[0]!.blockedReason).toMatch(/crashed/u);
    expect(out[0]!.status).not.toBe("todo"); // must wait for an explicit retry, not auto-run
  });
  it("no stale tasks → board returned unchanged", () => {
    const board = [at("2026-06-29T11:55:00Z")];
    expect(reclaimStaleTasks(board, NOW, STALE)).toEqual(board);
  });
});

describe("latestOutput — the answer a synthesis container reads", () => {
  it("prefers task.result", () => {
    expect(latestOutput(task({ id: "a" })) === undefined).toBe(true);
    expect(latestOutput({ ...task({ id: "a" }), result: "final" })).toBe("final");
  });
  it("else returns the LAST completed run's output, skipping failed runs", () => {
    const t = { ...task({ id: "a" }), runs: [
      { at: "t1", output: "first", status: "completed" as const },
      { at: "t2", reason: "boom", status: "failed" as const },
      { at: "t3", output: "latest", status: "completed" as const }
    ] };
    expect(latestOutput(t)).toBe("latest");
  });
  it("undefined when no completed run has output", () => {
    expect(latestOutput({ ...task({ id: "a" }), runs: [{ at: "t1", reason: "x", status: "failed" }] })).toBeUndefined();
  });
});

describe("removeTask — delete a task + prune dangling deps", () => {
  it("removes the task AND strips its id from any dependent's dependsOn (no ghost-blocked dependents)", () => {
    const board = [task({ id: "a", status: "done" }), task({ dependsOn: ["a", "x"], id: "b" })];
    const out = removeTask(board, "a");
    expect(out.map((t) => t.id)).toEqual(["b"]);
    expect(out[0]!.dependsOn).toEqual(["x"]); // "a" pruned, "x" kept
  });
  it("is a no-op for an unknown id", () => {
    const board = [task({ id: "a" })];
    expect(removeTask(board, "ghost")).toEqual(board);
  });
});
