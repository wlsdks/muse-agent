import { describe, expect, it } from "vitest";

import { dispatchNextTask, resolveReview, type TaskExecutor } from "../src/dispatch-board.js";
import { addTask, expandTaskIntoSubtasks, recordTaskRun, retryTask, tasksFromSubtasks, type AgentTask } from "../src/task-board.js";

const ok: TaskExecutor = async () => ({ status: "completed" });
const fail: TaskExecutor = async () => ({ reason: "boom", status: "failed" });

describe("dispatchNextTask — the board dispatcher (S3) + retry-with-reason", () => {
  it("runs the next ready task and records completion (todo → done)", async () => {
    const board = addTask([], { id: "a", title: "do it" }, "t0");
    const out = await dispatchNextTask(board, ok, "t1");
    expect(out.ran?.id).toBe("a");
    expect(out.outcome).toBe("completed");
    expect(out.tasks[0]!.status).toBe("done");
  });
  it("nothing ready (a dependency unmet) → no task run, board unchanged in shape", async () => {
    const board = tasksFromSubtasks([{ id: "a", title: "first" }, { dependsOn: ["a"], id: "b", title: "second" }], "t0");
    const inProgress = [{ ...board[0]!, status: "in_progress" as const }, board[1]!];
    const out = await dispatchNextTask(inProgress, ok, "t1");
    expect(out.ran).toBeUndefined(); // a is in_progress, b waits on a — nothing runnable
  });
  it("a failed run blocks the task with its reason; a thrown executor is caught as a failure (no torn in-progress)", async () => {
    const board = addTask([], { id: "a", title: "flaky" }, "t0");
    const out = await dispatchNextTask(board, fail, "t1");
    expect(out.outcome).toBe("failed");
    expect(out.tasks[0]).toMatchObject({ blockedReason: "boom", status: "blocked" });
    const thrown = await dispatchNextTask(board, async () => { throw new Error("crash"); }, "t2");
    expect(thrown.tasks[0]).toMatchObject({ status: "blocked", blockedReason: "crash" });
  });
  it("retry feeds the PRIOR failure reason into the executor's context (smarter than a re-run)", async () => {
    let seen: string | undefined = "NOT-CALLED";
    const board = addTask([], { id: "a", title: "x" }, "t0");
    const failed = (await dispatchNextTask(board, fail, "t1")).tasks; // a → blocked (reason "boom")
    const requeued = retryTask(failed, "a", "t2");                    // blocked → todo, history kept
    await dispatchNextTask(requeued, async (_t, ctx) => { seen = ctx.retryReason; return { status: "completed" }; }, "t3");
    expect(seen).toBe("boom");
  });
});

describe("resolveReview — the human-review gate (S6, draft-first)", () => {
  const parked = (): AgentTask[] => [{ createdAt: "t0", dependsOn: [], id: "a", runs: [], status: "review", title: "send email", updatedAt: "t0" }];
  it("needsReview parks a completed task in the review column (not done)", async () => {
    const board = addTask([], { id: "a", title: "draft a reply" }, "t0");
    const out = await dispatchNextTask(board, async () => ({ needsReview: true, status: "completed" }), "t1");
    expect(out.outcome).toBe("review");
    expect(out.tasks[0]!.status).toBe("review"); // waits for human approval, side-effect NOT yet applied
  });
  it("APPROVAL completes a reviewed task; REJECTION blocks it with the reason", () => {
    expect(resolveReview(parked(), "a", true, "t1")[0]!.status).toBe("done");
    const rejected = resolveReview(parked(), "a", false, "t1", "tone too harsh");
    expect(rejected[0]).toMatchObject({ blockedReason: "tone too harsh", status: "blocked" });
  });
  it("is a no-op on a task that isn't in review (only a parked task can be approved — no self-approve, no double-approve)", () => {
    const done = recordTaskRun(addTask([], { id: "a", title: "x" }, "t0").map((t) => ({ ...t, status: "in_progress" as const })), "a", { at: "t1", status: "completed" });
    expect(resolveReview(done, "a", true, "t2")).toEqual(done); // already done → unchanged
  });
});

describe("dispatchNextTask — a decomposed CONTAINER auto-completes (board-as-handoff)", () => {
  it("a decomposed parent whose sub-tasks are done auto-completes WITHOUT calling the executor", async () => {
    let board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "goal" }, "t0"), "p", [{ id: "s1", title: "a" }, { id: "s2", title: "b" }], "t1");
    board = board.map((t) => (t.id === "s1" || t.id === "s2") ? { ...t, status: "done" as const } : t); // sub-tasks done
    let executorCalls = 0;
    const out = await dispatchNextTask(board, async () => { executorCalls += 1; return { status: "completed" }; }, "t2");
    expect(out.ran?.id).toBe("p");
    expect(out.outcome).toBe("completed");
    expect(out.tasks.find((t) => t.id === "p")!.status).toBe("done");
    expect(executorCalls).toBe(0); // the container did NOT run the agent — its work was the sub-tasks
  });
});

describe("dispatchNextTask — a SYNTHESIS (parallel) container combines its sub-task outputs (#3)", () => {
  it("runs the executor over the finished sub-task outputs instead of auto-completing", async () => {
    // parallel expansion → container has synthesize:true; sub-tasks completed WITH outputs
    let board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "compare A B" }, "t0"), "p", [{ id: "s1", title: "A" }, { id: "s2", title: "B" }], "t1", "parallel");
    board = recordTaskRun(board, "s1", { at: "t2", output: "A is fast", status: "completed" });
    board = recordTaskRun(board, "s2", { at: "t3", output: "B is safe", status: "completed" });
    let seenOutputs: readonly string[] | undefined;
    const out = await dispatchNextTask(board, async (_t, ctx) => {
      seenOutputs = ctx.dependencyOutputs;
      return { output: "A is fast; B is safe — pick by need", status: "completed" };
    }, "t4");
    expect(out.ran?.id).toBe("p");
    expect(seenOutputs).toEqual(["A is fast", "B is safe"]); // the parallel outputs were handed to the synthesizer
    expect(out.tasks.find((t) => t.id === "p")!.result).toBe("A is fast; B is safe — pick by need"); // synthesis stored
  });
  it("a SEQUENTIAL container still auto-completes (no synthesize flag → no executor run)", async () => {
    let board = expandTaskIntoSubtasks(addTask([], { id: "p", title: "g" }, "t0"), "p", [{ id: "s1", title: "a" }, { id: "s2", title: "b" }], "t1"); // sequential
    board = board.map((t) => (t.id === "s1" || t.id === "s2") ? { ...t, status: "done" as const } : t);
    let called = 0;
    const out = await dispatchNextTask(board, async () => { called += 1; return { status: "completed" }; }, "t2");
    expect(out.tasks.find((t) => t.id === "p")!.status).toBe("done");
    expect(called).toBe(0);
  });
});
