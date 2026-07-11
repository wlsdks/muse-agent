/**
 * `muse board` (S4) — the user-facing surface of the durable agent task board: add work,
 * see it move across columns, run the next ready task, and approve/reject what the agent
 * parked for review. The board is the persisted Kanban hermes/openclaw orchestrate on;
 * this is how a person drives it. Outbound work (send/email/post …) is drafted and parked
 * in REVIEW — never auto-executed — so the board obeys the same draft-first contract as the
 * rest of Muse (outbound-safety.md): a side-effecting task waits for explicit approval.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ToolApprovalGate } from "@muse/agent-core";
import { createMuseRuntimeAssembly, resolveObjectivesFile } from "@muse/autoconfigure";
import { addTask, decomposeRequest, dispatchNextTask, expandTaskIntoSubtasks, FileAgentTaskBoard, latestOutput, planParallelSubtasks, reclaimStaleTasks, removeTask, resolveBoardMaxDepth, resolveReview, retryTask, staleInProgressTasks, transitionTask, type AgentTask, type TaskExecutor, type TaskStatus } from "@muse/multi-agent";
import { readObjectives } from "@muse/stores";
import type { Command } from "commander";

import { budgetAndSpillOutputs, formatSpillNote } from "./board-synthesis-budget.js";
import { firstNonEmpty } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";

const OUTBOUND_RE = /\b(send|email|e-mail|reply|forward|post|dm|message|text|publish|submit|book|order|tweet|slack)\b/iu;

/** True when a task's effect leaves the machine toward a person → it must be reviewed, not auto-run. */
export function taskNeedsReview(title: string): boolean {
  return OUTBOUND_RE.test(title);
}

/** Staleness threshold for a zombie in-progress task — 30 min default, `MUSE_BOARD_STALE_MS` override. */
export function boardStaleMs(env: Record<string, string | undefined>): number {
  const raw = Number(env.MUSE_BOARD_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Full detail of one task — status, deps, run history, and its result (a container's synthesis). Pure. */
export function formatTaskDetail(task: AgentTask): string {
  const lines = [task.id, `  ${task.title}`, `  status: ${task.status}${task.decomposed === true ? ` (container${task.synthesize === true ? ", synthesis" : ""})` : ""}`];
  if (task.dependsOn.length > 0) lines.push(`  depends on: ${task.dependsOn.join(", ")}`);
  if (task.blockedReason !== undefined && task.blockedReason.length > 0) lines.push(`  blocked: ${task.blockedReason}`);
  if (task.runs.length > 0) {
    lines.push(`  runs (${task.runs.length.toString()}):`);
    for (const r of task.runs) lines.push(`    [${r.at}] ${r.status}${r.reason !== undefined ? ` — ${r.reason}` : ""}`);
  }
  const out = latestOutput(task);
  if (out !== undefined) {
    lines.push("  result:");
    for (const line of out.split("\n")) lines.push(`    ${line}`);
  }
  return lines.join("\n");
}

/**
 * Which standing-objective specs to turn into board tasks: the ACTIVE ones not already on the
 * board (deduped by title, so re-seeding is idempotent). Pure — the CLI supplies the objectives
 * + existing titles. A completed/cancelled objective is never seeded.
 */
export function selectObjectiveSpecsToSeed(
  objectives: readonly { readonly spec: string; readonly status: string }[],
  existingTitles: ReadonlySet<string>
): string[] {
  return objectives
    .filter((o) => o.status === "active" && o.spec.trim().length > 0 && !existingTitles.has(o.spec.trim()))
    .map((o) => o.spec.trim());
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
/** Build the prompt for a task run: a synthesis fan-in, a retry, or the plain goal. */
export function boardTaskPrompt(title: string, ctx: { readonly retryReason?: string; readonly dependencyOutputs?: readonly string[] }): string {
  if (ctx.dependencyOutputs && ctx.dependencyOutputs.length > 0) {
    return `Combine these sub-task results into one clear, self-contained answer for the goal "${title}":\n\n${ctx.dependencyOutputs.map((o, i) => `[${(i + 1).toString()}] ${o}`).join("\n\n")}`;
  }
  if (ctx.retryReason) return `${title}\n\n(A previous attempt failed: ${ctx.retryReason}. Take a different approach.)`;
  return title;
}

/** Default character headroom for the synthesis prompt — `MUSE_BOARD_SYNTHESIS_HEADROOM` override. */
export function resolveBoardSynthesisHeadroom(env: Record<string, string | undefined>): number {
  const raw = Number(env.MUSE_BOARD_SYNTHESIS_HEADROOM);
  return Number.isFinite(raw) && raw > 0 ? raw : 24000;
}

/** Where over-budget child outputs are spilled in full — `MUSE_BOARD_SPILL_DIR` override. */
export function boardSpillDir(env: Record<string, string | undefined>): string {
  return firstNonEmpty(env.MUSE_BOARD_SPILL_DIR) ?? join(homedir(), ".muse", "board-spill");
}

function makeAgentExecutor(io: ProgramIO): TaskExecutor {
  return async (task, ctx) => {
    const assembly = createMuseRuntimeAssembly();
    if (!assembly.agentRuntime || !assembly.defaultModel) return { reason: "no local agent runtime configured (set MUSE_MODEL)", status: "failed" };
    // Progress feedback BEFORE the (potentially slow, local-model) agent call, so a `board run`
    // never looks hung during the wait — the user sees which task is in flight.
    io.stderr(`▸ running: ${task.title}…\n`);
    try {
      // A synthesis container's dependencyOutputs can be arbitrarily large (N full sub-task
      // answers) — bound each child to its share of the headroom and spill the rest to disk
      // so the prompt stays sized for the model but nothing the sub-tasks produced is lost.
      let spillNote = "";
      let dependencyOutputs = ctx.dependencyOutputs;
      if (dependencyOutputs && dependencyOutputs.length > 0) {
        const spillDir = boardSpillDir(process.env);
        const { segments, spills } = budgetAndSpillOutputs(dependencyOutputs, {
          headroom: resolveBoardSynthesisHeadroom(process.env),
          makeName: (i) => `${task.id}-${i.toString()}.txt`,
          spillDir,
          writeSpill: (path, content) => { mkdirSync(spillDir, { recursive: true }); writeFileSync(path, content, "utf8"); }
        });
        dependencyOutputs = segments;
        spillNote = formatSpillNote(spills.length, spillDir);
      }
      const result = await assembly.agentRuntime.run({
        messages: [{ content: boardTaskPrompt(task.title, { ...ctx, dependencyOutputs }), role: "user" }],
        model: assembly.defaultModel,
        runId: `board-${randomUUID()}`,
        toolApprovalGate: boardToolApprovalGate
      });
      const out = (result.response.output ?? "").trim();
      if (out.length === 0) return { reason: "empty answer", status: "failed" };
      const finalOut = `${out}${spillNote}`;
      io.stdout(`\n${finalOut}\n`);
      const tools = result.toolsUsed ?? [];
      if (tools.length > 0) io.stderr(`(tools used: ${tools.join(", ")})\n`);
      // Draft-first: an outbound task is drafted above but PARKED for approval, not sent. The
      // output is returned so a synthesis container can later combine the sub-task answers.
      return taskNeedsReview(task.title) ? { needsReview: true, output: finalOut, status: "completed" } : { output: finalOut, status: "completed" };
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
    .command("seed")
    .description("Seed the board from your ACTIVE standing objectives (skips objectives already on the board)")
    .action(async () => {
      const objectives = await readObjectives(resolveObjectivesFile(process.env as Record<string, string | undefined>)).catch(() => [] as const);
      const store = new FileAgentTaskBoard();
      const existing = new Set((await store.list()).map((t) => t.title.trim()));
      const specs = selectObjectiveSpecsToSeed(objectives, existing);
      if (specs.length === 0) { io.stdout("No new active objectives to seed (none active, or all already on the board).\n"); return; }
      await store.mutate((tasks) => specs.reduce<AgentTask[]>((board2, spec) => addTask(board2, { id: randomUUID(), title: spec }, new Date().toISOString()), [...tasks]));
      io.stdout(`Seeded ${specs.length.toString()} task(s) from your standing objectives:\n${specs.map((s) => `  • ${s}`).join("\n")}\n`);
    });

  board
    .command("expand <id>")
    .description("Decompose a complex task into sub-tasks. By default the model splits it into INDEPENDENT parallel sub-tasks when it can (combined by a synthesis step), else a sequential chain.")
    .option("--parallel", "Force INDEPENDENT (parallel) sub-tasks from the deterministic split — no model call")
    .option("--sequential", "Force a sequential chain from the deterministic split — no model call")
    .action(async (id: string, opts: { readonly parallel?: boolean; readonly sequential?: boolean }) => {
      const store = new FileAgentTaskBoard();
      const parent = (await store.list()).find((t) => t.id.startsWith(id));
      if (!parent) { io.stderr(`muse board expand: no task ${id}\n`); process.exitCode = 1; return; }
      if (parent.decomposed) { io.stdout(`${parent.id.slice(0, 8)} is already decomposed.\n`); return; }

      let subs: { readonly id: string; readonly title: string }[];
      let mode: "sequential" | "parallel";
      if (opts.parallel || opts.sequential) {
        subs = decomposeRequest(parent.title).map((s) => ({ id: randomUUID(), title: s.text }));
        mode = opts.parallel ? "parallel" : "sequential";
      } else {
        // Auto: ask the model for a true parallel fan-out; fall back to the deterministic
        // sequential split when it declines (a single/sequential goal).
        const assembly = createMuseRuntimeAssembly();
        const generate = async (p: string): Promise<string> => {
          if (!assembly.modelProvider || !assembly.defaultModel) return "NONE";
          const r = await assembly.modelProvider.generate({ maxOutputTokens: 256, messages: [{ content: p, role: "user" }], model: assembly.defaultModel, temperature: 0 });
          return r.output ?? "";
        };
        const parallel = await planParallelSubtasks(parent.title, { generate }).catch(() => [] as string[]);
        if (parallel.length >= 2) {
          subs = parallel.map((title) => ({ id: randomUUID(), title }));
          mode = "parallel";
        } else {
          subs = decomposeRequest(parent.title).map((s) => ({ id: randomUUID(), title: s.text }));
          mode = "sequential";
        }
      }

      if (subs.length < 2) { io.stdout(`"${parent.title}" isn't decomposable into multiple steps — leaving it as a single task.\n`); return; }
      await store.mutate((tasks) => expandTaskIntoSubtasks(tasks, parent.id, subs, new Date().toISOString(), mode, resolveBoardMaxDepth(process.env as Record<string, string | undefined>)));
      io.stdout(`Expanded ${parent.id.slice(0, 8)} into ${subs.length.toString()} ${mode} sub-tasks${mode === "parallel" ? " (combined by a synthesis step when done)" : ""}:\n${subs.map((s, i) => `  ${(i + 1).toString()}. ${s.title}`).join("\n")}\n`);
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
    .command("show <id>")
    .description("Show a task's full detail — status, dependencies, run history, and its result/answer (e.g. a container's synthesis)")
    .action(async (id: string) => {
      const task = (await new FileAgentTaskBoard().list()).find((t) => t.id.startsWith(id));
      if (!task) { io.stderr(`muse board show: no task ${id}\n`); process.exitCode = 1; return; }
      io.stdout(`${formatTaskDetail(task)}\n`);
    });

  board
    .command("rm <id>")
    .description("Remove a task from the board (its id is also pruned from any task that depended on it)")
    .action(async (id: string) => {
      const store = new FileAgentTaskBoard();
      const task = (await store.list()).find((t) => t.id.startsWith(id));
      if (!task) { io.stderr(`muse board rm: no task ${id}\n`); process.exitCode = 1; return; }
      await store.mutate((tasks) => removeTask(tasks, task.id));
      io.stdout(`Removed ${task.id.slice(0, 8)} — ${task.title}\n`);
    });

  board
    .command("reclaim")
    .description("Recover zombie tasks — a task stuck in-progress past the staleness window (a crashed run) → blocked, so it can be retried")
    .action(async () => {
      const store = new FileAgentTaskBoard();
      const stale = staleInProgressTasks(await store.list(), Date.now(), boardStaleMs(process.env));
      if (stale.length === 0) { io.stdout("No stale in-progress tasks — nothing to reclaim.\n"); return; }
      await store.mutate((tasks) => reclaimStaleTasks(tasks, Date.now(), boardStaleMs(process.env)));
      io.stdout(`Reclaimed ${stale.length.toString()} stale task(s) → blocked (retry to re-run):\n${stale.map((t) => `  ${t.id.slice(0, 8)}  ${t.title}`).join("\n")}\n`);
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
      // Recover zombies first: a task stuck in-progress from a prior CRASHED run would otherwise
      // block its dependents forever. Reclaim → blocked (not auto-re-run — outbound-safety).
      const stale = staleInProgressTasks(await store.list(), Date.now(), boardStaleMs(process.env));
      if (stale.length > 0) {
        await store.mutate((tasks) => reclaimStaleTasks(tasks, Date.now(), boardStaleMs(process.env)));
        io.stderr(`Reclaimed ${stale.length.toString()} stale in-progress task(s) from a crashed run → blocked.\n`);
      }
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
