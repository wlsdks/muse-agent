/**
 * `muse board` (S4) — the user-facing surface of the durable agent task board: add work,
 * see it move across columns, run the next ready task, and approve/reject what the agent
 * parked for review. The board is the persisted Kanban hermes/openclaw orchestrate on;
 * this is how a person drives it. Outbound work (send/email/post …) is drafted and parked
 * in REVIEW — never auto-executed — so the board obeys the same draft-first contract as the
 * rest of Muse (outbound-safety.md): a side-effecting task waits for explicit approval.
 */

import { randomUUID } from "node:crypto";

import type { ToolApprovalGate } from "@muse/agent-core";
import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import { addTask, decomposeRequest, dispatchNextTask, expandTaskIntoSubtasks, FileAgentTaskBoard, resolveReview, retryTask, transitionTask, type AgentTask, type TaskExecutor, type TaskStatus } from "@muse/multi-agent";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const OUTBOUND_RE = /\b(send|email|e-mail|reply|forward|post|dm|message|text|publish|submit|book|order|tweet|slack)\b/iu;

/** True when a task's effect leaves the machine toward a person → it must be reviewed, not auto-run. */
export function taskNeedsReview(title: string): boolean {
  return OUTBOUND_RE.test(title);
}

const MOVABLE: readonly TaskStatus[] = ["todo", "in_progress", "review", "blocked", "done", "failed"];

/** Human-readable board grouped by column. Pure. */
export function formatBoard(tasks: readonly AgentTask[]): string {
  if (tasks.length === 0) return 'Board is empty. Add work: muse board add "<title>"';
  const columns: readonly TaskStatus[] = ["todo", "in_progress", "review", "blocked", "done", "failed"];
  const lines: string[] = ["📋 Agent task board:", ""];
  for (const col of columns) {
    const inCol = tasks.filter((t) => t.status === col);
    if (inCol.length === 0) continue;
    lines.push(`  ${col.toUpperCase()} (${inCol.length.toString()}):`);
    for (const t of inCol) {
      const deps = t.dependsOn.length > 0 ? ` ⟵ ${t.dependsOn.join(",")}` : "";
      const why = t.blockedReason ? `  — ${t.blockedReason}` : "";
      lines.push(`    ${t.id.slice(0, 8)}  ${t.title}${deps}${why}`);
    }
  }
  return lines.join("\n");
}

/**
 * Fail-closed approval gate for board execution: a READ tool runs, but a WRITE/EXECUTE tool
 * is DENIED — an unattended `board run` must never autonomously send or modify. Outbound
 * work goes through the review column (a human approves), never a mid-run auto-approval.
 * This is the deterministic guard that keeps the board agentic-yet-safe (outbound-safety.md).
 */
export const boardToolApprovalGate: ToolApprovalGate = ({ risk }) =>
  risk === "read"
    ? { allowed: true }
    : { allowed: false, reason: "a board task does not auto-approve a write/execute tool — route outbound work through the review column" };

/**
 * The production executor: run a board task through the real AGENT RUNTIME — tools (read-only
 * here, per the gate above) + grounding + the agent loop — not a single model turn, so a task
 * can search your notes, do math, look things up, and ground its answer. A retry replays the
 * prior failure into the prompt so the agent corrects rather than repeats it. Outbound work is
 * DRAFTED then parked `needsReview` (never sent). The real seam wiring the board to the agent.
 */
function makeAgentExecutor(io: ProgramIO): TaskExecutor {
  return async (task, ctx) => {
    const assembly = createMuseRuntimeAssembly();
    if (!assembly.agentRuntime || !assembly.defaultModel) return { reason: "no local agent runtime configured (set MUSE_MODEL)", status: "failed" };
    const prompt = ctx.retryReason
      ? `${task.title}\n\n(A previous attempt failed: ${ctx.retryReason}. Take a different approach.)`
      : task.title;
    try {
      const result = await assembly.agentRuntime.run({
        messages: [{ content: prompt, role: "user" }],
        model: assembly.defaultModel,
        runId: `board-${randomUUID()}`,
        toolApprovalGate: boardToolApprovalGate
      });
      const out = (result.response.output ?? "").trim();
      if (out.length === 0) return { reason: "empty answer", status: "failed" };
      io.stdout(`\n${out}\n`);
      const tools = result.toolsUsed ?? [];
      if (tools.length > 0) io.stderr(`(tools used: ${tools.join(", ")})\n`);
      // Draft-first: an outbound task is drafted above but PARKED for approval, not sent.
      return taskNeedsReview(task.title) ? { needsReview: true, status: "completed" } : { status: "completed" };
    } catch (cause) {
      return { reason: cause instanceof Error ? cause.message : String(cause), status: "failed" };
    }
  };
}

export function registerBoardCommand(program: Command, io: ProgramIO): void {
  const board = program
    .command("board")
    .description("Your durable agent task board — add work, run the next ready task, approve what's parked for review")
    .option("--json", "Emit the board as JSON")
    .action(async (options: { readonly json?: boolean }) => {
      const tasks = await new FileAgentTaskBoard().list();
      io.stdout(options.json ? `${JSON.stringify(tasks, null, 2)}\n` : `${formatBoard(tasks)}\n`);
    });

  board
    .command("add <title...>")
    .description("Add a task to the board")
    .option("--depends-on <ids>", "Comma-separated task ids that must be done first")
    .option("--desc <text>", "A longer description")
    .action(async (titleParts: string[], opts: { readonly dependsOn?: string; readonly desc?: string }) => {
      const title = titleParts.join(" ").trim();
      if (!title) { io.stderr("muse board add: a title is required\n"); process.exitCode = 1; return; }
      const id = randomUUID();
      const dependsOn = opts.dependsOn ? opts.dependsOn.split(",").map((s) => s.trim()).filter(Boolean) : [];
      await new FileAgentTaskBoard().mutate((tasks) => addTask(tasks, { dependsOn, id, title, ...(opts.desc ? { description: opts.desc } : {}) }, new Date().toISOString()));
      io.stdout(`Added ${id.slice(0, 8)} — ${title}\n`);
    });

  board
    .command("expand <id>")
    .description("Decompose a complex task into sub-tasks on the board (it becomes a container that auto-completes when its sub-tasks are done; `board run --all` works the chain in order)")
    .action(async (id: string) => {
      const store = new FileAgentTaskBoard();
      const parent = (await store.list()).find((t) => t.id.startsWith(id));
      if (!parent) { io.stderr(`muse board expand: no task ${id}\n`); process.exitCode = 1; return; }
      if (parent.decomposed) { io.stdout(`${parent.id.slice(0, 8)} is already decomposed.\n`); return; }
      const subs = decomposeRequest(parent.title).map((s) => ({ id: randomUUID(), title: s.text }));
      if (subs.length < 2) { io.stdout(`"${parent.title}" isn't decomposable into multiple steps — leaving it as a single task.\n`); return; }
      await store.mutate((tasks) => expandTaskIntoSubtasks(tasks, parent.id, subs, new Date().toISOString()));
      io.stdout(`Expanded ${parent.id.slice(0, 8)} into ${subs.length.toString()} sub-tasks:\n${subs.map((s, i) => `  ${(i + 1).toString()}. ${s.title}`).join("\n")}\n`);
    });

  board
    .command("move <id> <status>")
    .description(`Move a task to a column (${MOVABLE.join(" | ")})`)
    .action(async (id: string, status: string) => {
      if (!MOVABLE.includes(status as TaskStatus)) { io.stderr(`muse board move: status must be one of ${MOVABLE.join(", ")}\n`); process.exitCode = 1; return; }
      const tasks = await new FileAgentTaskBoard().mutate((ts) => transitionTask(ts, id, status as TaskStatus, new Date().toISOString()));
      io.stdout(tasks.some((t) => t.id.startsWith(id)) ? `Moved ${id.slice(0, 8)} → ${status}\n` : `No task ${id}\n`);
    });

  board
    .command("retry <id>")
    .description("Re-queue a blocked/failed task (it retries WITH the previous failure's reason in context)")
    .action(async (id: string) => {
      await new FileAgentTaskBoard().mutate((tasks) => retryTask(tasks, id, new Date().toISOString()));
      io.stdout(`Re-queued ${id.slice(0, 8)} (if it was blocked)\n`);
    });

  board
    .command("review <id>")
    .description("Approve or reject a task parked in the review column (draft-first: an outbound task is sent ONLY on approval)")
    .option("--approve", "Approve — complete the task")
    .option("--reject", "Reject — block the task")
    .option("--reason <text>", "Why (recorded on the task)")
    .action(async (id: string, opts: { readonly approve?: boolean; readonly reject?: boolean; readonly reason?: string }) => {
      if (Boolean(opts.approve) === Boolean(opts.reject)) { io.stderr("muse board review: pass exactly one of --approve / --reject\n"); process.exitCode = 1; return; }
      await new FileAgentTaskBoard().mutate((tasks) => resolveReview(tasks, id, Boolean(opts.approve), new Date().toISOString(), opts.reason));
      io.stdout(`${opts.approve ? "Approved" : "Rejected"} ${id.slice(0, 8)}\n`);
    });

  board
    .command("run")
    .description("Dispatch the next dependency-ready task to the local agent (outbound work is drafted + parked for review)")
    .option("--all", "Keep dispatching until nothing is runnable (instead of a single task)")
    .action(async (opts: { readonly all?: boolean }) => {
      const store = new FileAgentTaskBoard();
      const executor = makeAgentExecutor(io);
      let ran = 0;
      for (;;) {
        const before = await store.list();
        const result = await dispatchNextTask(before, executor, new Date().toISOString());
        if (!result.ran) break;
        await store.mutate(() => result.tasks);
        ran += 1;
        io.stdout(`▸ ${result.ran.title} → ${result.outcome ?? "?"}\n`);
        if (!opts.all || result.outcome === "review") break; // stop at a review gate even in --all
      }
      io.stdout(ran === 0 ? "Nothing ready to run (every task is done, in flight, blocked, or waiting on a dependency).\n" : `Ran ${ran.toString()} task(s).\n`);
    });
}
