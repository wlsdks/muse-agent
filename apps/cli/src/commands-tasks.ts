import { isErrorLike } from "@muse/shared";
/**
 * `muse tasks` command group.
 *
 * Wraps `/api/tasks/*` for remote mode and the shared
 * `@muse/stores` personal-tasks-store helpers for `--local` mode so the
 * CLI works without an API server. Both surfaces speak the same
 * on-disk format, so a `--local` write is visible to the API on the
 * next request and vice versa.
 *
 * Output: human-readable by default; `--json` opts back into the raw
 * API response for scripting.
 */

import { randomUUID } from "node:crypto";

import { openLoops, type OpenLoop } from "@muse/agent-core";
import { resolveTasksFile } from "@muse/autoconfigure";
import { compareTasksByDueDate, mutateTasks, parseTaskDueAt, readTasks, readTaskStatusFilter, resolveTaskRef, serializeTask, type PersistedTask } from "@muse/stores";
import type { Command } from "commander";

import { isApiUnreachable, withApiLocalFallback } from "./program-helpers.js";
import { analyzeTaskFlow, formatTaskFlow } from "./task-flow.js";
import { formatTaskQueue, rankTasksByUrgency } from "./task-priority.js";

import { closestCommandName } from "./closest-command.js";
import { resolveCliLanguage } from "./cli-i18n.js";
import { readConfigStore } from "./program-config.js";
import {
  formatLocalDateTime,
  formatProvidersList,
  formatTaskAdded,
  formatTaskCompleted,
  formatTaskList
} from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

/**
 * CLI-side strict validation for `muse tasks list
 * --status <value>`. The shared `readTaskStatusFilter` is
 * deliberately lenient (it silently falls back to `"open"` so
 * the MCP tool tolerates an LLM that omits / mistypes the
 * field). On the CLI a typo is a real user error — surface it
 * with the same closest-match hint used elsewhere instead of
 * pretending the filter worked.
 */
const TASK_STATUS_VALUES = ["open", "done", "all"] as const;

function assertTaskStatusInput(raw: string): void {
  const trimmed = raw.trim().toLowerCase();
  if (TASK_STATUS_VALUES.includes(trimmed as (typeof TASK_STATUS_VALUES)[number])) {
    return;
  }
  const suggestion = closestCommandName(trimmed, TASK_STATUS_VALUES);
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`--status must be one of: ${TASK_STATUS_VALUES.join(", ")} (got '${raw}')${hint}`);
}

export interface TasksCommandHelpers {
  readonly apiRequest: (
    io: ProgramIO,
    command: Command,
    path: string,
    body?: Record<string, unknown>,
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  ) => Promise<unknown>;
  readonly writeOutput: (io: ProgramIO, value: unknown, textField?: string) => void;
}

interface SharedOptions {
  readonly local?: boolean;
  readonly json?: boolean;
}

function localTasksFile(): string {
  return resolveTasksFile(process.env as Record<string, string | undefined>);
}

/** Render the open-loops nudge — surface the planless nagging tasks + how to close them. Pure. */
export function formatOpenLoops(loops: readonly OpenLoop[]): string {
  if (loops.length === 0) {
    return "🔓 No open loops — every unfinished task either has a plan or is fresh. Clear head.\n";
  }
  const lines = ["🔓 Open loops (unfinished + unscheduled — a plan closes the loop):"];
  for (const loop of loops) {
    lines.push(`  • ${loop.title} — open ${Math.round(loop.ageDays).toString()}d, no plan`);
  }
  lines.push(`  ↳ give one a plan: muse tasks edit "<title>" --due <when>  (or complete it)`);
  return `${lines.join("\n")}\n`;
}

const taskLocalFallback = <T>(
  io: ProgramIO,
  useLocal: boolean,
  local: () => Promise<T>,
  api: () => Promise<T>
): Promise<T> => withApiLocalFallback(io, useLocal, local, api, "tasks");

export function registerTasksCommands(program: Command, io: ProgramIO, helpers: TasksCommandHelpers): void {
  const tasks = program.command("tasks").description("Personal todo list");

  tasks
    .command("providers")
    .description("List configured tasks backends")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly json?: boolean }, command) => {
      const result = await helpers.apiRequest(io, command, "/api/tasks/providers");
      if (options.json) {
        helpers.writeOutput(io, result);
        return;
      }
      await resolveCliLanguage(process.env, () => readConfigStore(io));
      const providers = (result as { providers?: Parameters<typeof formatProvidersList>[1] })?.providers ?? [];
      io.stdout(formatProvidersList("Tasks providers", providers));
    });

  tasks
    .command("flow")
    .description("Are you finishing tasks as fast as you add them? Little's Law (1961) flow over your todo list — created vs completed rate, backlog trend, average lead time. Read-only, deterministic, no model. e.g. `muse tasks flow --days 14`")
    .option("--days <n>", "Window in days to analyze (default 7)")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly days?: string; readonly json?: boolean }) => {
      let windowDays = 7;
      if (options.days !== undefined) {
        const parsed = Number(options.days.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          io.stderr(`muse tasks flow: --days must be a positive number (got '${options.days}')\n`);
          process.exitCode = 1;
          return;
        }
        windowDays = Math.trunc(parsed);
      }
      const all = await readTasks(localTasksFile());
      const stats = analyzeTaskFlow(
        all.map((t) => ({ completedAt: t.completedAt, createdAt: t.createdAt, status: t.status })),
        new Date(),
        windowDays
      );
      if (options.json) {
        io.stdout(`${JSON.stringify(stats, null, 2)}\n`);
        return;
      }
      io.stdout(formatTaskFlow(stats));
    });

  tasks
    .command("next")
    .description("What should I do NOW? Your open tasks ranked by urgency — earliest deadline first, overdue + urgent floated to the top, and untouched tasks aged up so nothing languishes (real-time scheduling: EDF + anti-starvation aging). Read-only, deterministic, no model, reads the local tasks file. Use to decide what to work on; not to see everything (that is `tasks list`). e.g. `muse tasks next --limit 5`")
    .option("--limit <n>", "How many to show (default 10)")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      let limit = 10;
      if (options.limit !== undefined) {
        const parsed = Number(options.limit.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          io.stderr(`muse tasks next: --limit must be a positive number (got '${options.limit}')\n`);
          process.exitCode = 1;
          return;
        }
        limit = Math.trunc(parsed);
      }
      const ranked = rankTasksByUrgency(await readTasks(localTasksFile()), Date.now());
      if (options.json) {
        io.stdout(`${JSON.stringify(ranked.slice(0, limit).map((r) => ({ id: r.task.id, title: r.task.title, reason: r.reason, effectiveDueMs: r.effectiveDueMs })), null, 2)}\n`);
        return;
      }
      io.stdout(`${formatTaskQueue(ranked, limit)}\n`);
    });

  tasks
    .command("list")
    .description("List tasks by due date (soonest first; undated last), filter by status (--local skips the API)")
    .option("--status <status>", "Status filter: open (default), done, or all", "open")
    .option("--search <text>", "Only tasks whose title or notes contains this text (case-insensitive)")
    .option("--tag <label>", "Only tasks carrying this tag (case-insensitive)")
    .option("--due <window>", "Only tasks due within a window: overdue, today, week, or a number of days")
    .option("--local", "Read directly from the local tasks file instead of the API")
    .option("--json", "Print the raw API response instead of the formatted list")
    .action(async (options: { readonly status: string; readonly search?: string; readonly tag?: string; readonly due?: string } & SharedOptions, command) => {
      // Throws before dispatch so a typo'd --status doesn't return
      // a silently-wrong "open" list.
      assertTaskStatusInput(options.status);
      await resolveCliLanguage(process.env, () => readConfigStore(io));
      type TaskListPayload = { status: string; tasks: readonly Record<string, unknown>[]; total: number };
      const readLocalTasks = async (): Promise<TaskListPayload> => {
        const file = localTasksFile();
        const status = readTaskStatusFilter(options.status);
        const all = await readTasks(file);
        const filtered = all
          .filter((task) => status === "all" || task.status === status)
          .sort(compareTasksByDueDate);
        return { status, tasks: filtered.map(serializeTask), total: filtered.length };
      };
      let payload: TaskListPayload;
      if (options.local) {
        payload = await readLocalTasks();
      } else {
        const path = `/api/tasks?status=${encodeURIComponent(options.status)}`;
        try {
          payload = (await helpers.apiRequest(io, command, path)) as TaskListPayload;
        } catch (cause) {
          if (!isApiUnreachable(cause)) {
            throw cause;
          }
          io.stderr("muse: API not reachable — reading tasks from the local store.\n");
          payload = await readLocalTasks();
        }
      }
      const query = options.search?.trim();
      if (query) {
        const matched = filterTasksBySearch(payload.tasks, query);
        payload = { ...payload, tasks: matched, total: matched.length };
      }
      const tag = options.tag?.trim();
      if (tag) {
        const matched = filterTasksByTag(payload.tasks, tag);
        payload = { ...payload, tasks: matched, total: matched.length };
      }
      const due = options.due?.trim();
      if (due) {
        const window = parseDueWindow(due);
        if (!window) {
          io.stderr(`muse: --due must be 'overdue', 'today', 'week', or a number of days (got '${due}')\n`);
          process.exitCode = 1;
          return;
        }
        const matched = filterTasksByDue(payload.tasks, window, Date.now());
        payload = { ...payload, tasks: matched, total: matched.length };
      }
      if (options.json) {
        helpers.writeOutput(io, payload);
        return;
      }
      io.stdout(formatTaskList({
        status: payload.status,
        tasks: payload.tasks as unknown as Parameters<typeof formatTaskList>[0]["tasks"],
        total: payload.total
      }));
    });

  tasks
    .command("open-loops")
    .description("Unfinished, UNSCHEDULED tasks that have been nagging a while — close the loop by giving each a plan (Zeigarnik/Ovsiankina; local)")
    .option("--json", "Print the raw loops")
    .action(async (options: { readonly json?: boolean }) => {
      const all = await readTasks(localTasksFile());
      const loops = openLoops(all, { nowMs: Date.now() });
      if (options.json) {
        io.stdout(`${JSON.stringify(loops, null, 2)}\n`);
        return;
      }
      io.stdout(formatOpenLoops(loops));
    });

  tasks
    .command("add")
    .description("Append a new task (--local skips the API)")
    .argument("<title...>", "Task title (one or more words)")
    .option("--notes <text>", "Free-form notes")
    .option("--tags <list>", "Comma-separated tag list (e.g. work,muse)")
    .option(
      "--due <when>",
      "Due date: ISO-8601 (2026-05-15T18:00Z) or relative phrase ('tomorrow at 6pm', 'in 3 hours', 'next Monday')"
    )
    .option("--local", "Write directly to the local tasks file instead of the API")
    .option(
      "--urgent",
      "Mark as urgent: proactive watcher fires this task even during routine_active_hours-derived quiet hours"
    )
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (
      titleParts: readonly string[],
      options: { readonly notes?: string; readonly tags?: string; readonly due?: string; readonly urgent?: boolean } & SharedOptions,
      command
    ) => {
      const title = titleParts.join(" ").trim();
      if (title.length === 0) {
        throw new Error("title is required");
      }
      const tags = options.tags
        ? options.tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
        : undefined;

      // Validate `--due` before dispatch in BOTH modes: the
      // `/api/tasks` route uses the same `parseTaskDueAt` grammar,
      // so a bad `--due` gets the identical actionable error
      // whether or not `--local` is set — no degraded API error,
      // no wasted round-trip on input the server would only reject.
      let resolvedDueAt: string | undefined;
      if (options.due && options.due.trim().length > 0) {
        const parsed = parseTaskDueAt(options.due, () => new Date());
        if (isErrorLike(parsed)) {
          throw parsed;
        }
        resolvedDueAt = parsed;
      }

      // A past --due is almost always a typo (wrong year, "yesterday"): the task
      // is born already overdue. Warn but don't block — same heads-up `remind
      // add` gives — so the user can fix it or knowingly keep it.
      if (!options.json && resolvedDueAt && new Date(resolvedDueAt).getTime() < Date.now()) {
        io.stderr(`muse: heads up — ${formatLocalDateTime(resolvedDueAt)} is in the PAST; this task is already overdue.\n`);
      }

      const addLocal = async (): Promise<Record<string, unknown>> => {
        const file = localTasksFile();
        const persisted: PersistedTask = {
          createdAt: new Date().toISOString(),
          id: `task_${randomUUID()}`,
          status: "open",
          title,
          ...(options.notes && options.notes.length > 0 ? { notes: options.notes } : {}),
          ...(tags && tags.length > 0 ? { tags } : {}),
          ...(resolvedDueAt ? { dueAt: resolvedDueAt } : {}),
          ...(options.urgent === true ? { urgent: true } : {})
        };
        await mutateTasks(file, (current) => [...current, persisted]);
        return serializeTask(persisted);
      };
      const addApi = async (): Promise<Record<string, unknown>> => {
        const body: Record<string, unknown> = { title };
        if (options.notes && options.notes.length > 0) {
          body.notes = options.notes;
        }
        if (tags && tags.length > 0) {
          body.tags = tags;
        }
        if (options.due && options.due.trim().length > 0) {
          body.dueAt = options.due.trim();
        }
        return (await helpers.apiRequest(io, command, "/api/tasks", body, "POST")) as Record<string, unknown>;
      };
      const created = await taskLocalFallback(io, Boolean(options.local), addLocal, addApi);
      if (options.json) {
        helpers.writeOutput(io, created);
        return;
      }
      io.stdout(formatTaskAdded(created as unknown as Parameters<typeof formatTaskAdded>[0]));
    });

  tasks
    .command("complete")
    .description("Mark a task done (--local skips the API)")
    .argument("<id>", "Task id, id prefix, or title — e.g. 'groceries'")
    .option("--local", "Update the local tasks file instead of calling the API")
    .option("--json", "Print the raw response instead of a short confirmation")
    .action(async (id: string, options: SharedOptions, command) => {
      let alreadyDone = false;
      const completeLocal = async (): Promise<Record<string, unknown>> => {
        const file = localTasksFile();
        let completed: PersistedTask | undefined;
        await mutateTasks(file, (current) => {
          const resolved = resolveLocalTaskId(id, current);
          const index = current.findIndex((task) => task.id === resolved);
          const existing = current[index]!;
          // Idempotent: a task already done keeps its ORIGINAL completedAt — re-
          // completing must not silently rewrite "when it was done" to now.
          if (existing.status === "done") {
            alreadyDone = true;
            completed = existing;
            return current;
          }
          completed = { ...existing, completedAt: new Date().toISOString(), status: "done" };
          return current.map((task, taskIndex) => taskIndex === index ? completed! : task);
        });
        return serializeTask(completed!);
      };
      const completeApi = async (): Promise<Record<string, unknown>> => (await helpers.apiRequest(
        io,
        command,
        `/api/tasks/${encodeURIComponent(id)}/complete`,
        {},
        "POST"
      )) as Record<string, unknown>;
      const completed = await taskLocalFallback(io, Boolean(options.local), completeLocal, completeApi);
      if (options.json) {
        helpers.writeOutput(io, completed);
        return;
      }
      if (alreadyDone) {
        const when = String(completed.completedAt ?? "");
        io.stdout(`Task [${String(completed.id).slice(0, 12)}] ${String(completed.title)} was already done${when ? ` (completed ${formatLocalDateTime(when)})` : ""} — no change.\n`);
        return;
      }
      io.stdout(formatTaskCompleted(completed as unknown as Parameters<typeof formatTaskCompleted>[0]));
    });

  tasks
    .command("edit")
    .description("Update an existing task in place (--local skips the API)")
    .argument("<id>", "Task id, id prefix, or title")
    .option("--title <text...>", "New title")
    .option("--notes <text>", "New free-form notes (pass an empty string to clear)")
    .option("--tags <list>", "New comma-separated tag list (pass an empty string to clear)")
    .option(
      "--due <when>",
      "New due date: ISO-8601 or relative phrase ('tomorrow at 6pm'). Pass 'none' to clear."
    )
    .option("--urgent", "Mark as urgent")
    .option("--no-urgent", "Clear the urgent flag")
    .option("--local", "Update the local tasks file instead of calling the API")
    .option("--json", "Print the raw task instead of a short confirmation")
    .action(async (
      id: string,
      options: {
        readonly title?: string | readonly string[];
        readonly notes?: string;
        readonly tags?: string;
        readonly due?: string;
        readonly urgent?: boolean;
      } & SharedOptions,
      command
    ) => {
      const nextTitle = Array.isArray(options.title)
        ? options.title.join(" ").trim()
        : typeof options.title === "string"
          ? options.title.trim()
          : undefined;
      const updates: Record<string, unknown> = {};
      if (nextTitle && nextTitle.length > 0) {
        updates.title = nextTitle;
      }
      if (options.notes !== undefined) {
        updates.notes = options.notes;
      }
      if (options.tags !== undefined) {
        const split = options.tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
        updates.tags = split;
      }
      if (options.due !== undefined) {
        if (options.due.trim().toLowerCase() === "none" || options.due.trim().length === 0) {
          updates.dueAt = null;
        } else {
          const parsed = parseTaskDueAt(options.due, () => new Date());
          if (isErrorLike(parsed)) {
            throw parsed;
          }
          updates.dueAt = parsed;
        }
      }
      if (typeof options.urgent === "boolean") {
        updates.urgent = options.urgent;
      }
      if (Object.keys(updates).length === 0) {
        io.stderr("muse tasks edit needs at least one of --title/--notes/--tags/--due/--urgent/--no-urgent\n");
        process.exitCode = 1;
        return;
      }

      const editLocal = async (): Promise<Record<string, unknown>> => {
        const file = localTasksFile();
        let updated: PersistedTask | undefined;
        await mutateTasks(file, (current) => {
          const resolved = resolveLocalTaskId(id, current);
          const index = current.findIndex((task) => task.id === resolved);
          if (index === -1) {
            throw new Error(`Task ${id} not found`);
          }
          const existing = current[index]!;
          const patched: PersistedTask = {
            ...existing,
            ...(typeof updates.title === "string" ? { title: updates.title } : {}),
            ...(typeof updates.notes === "string"
              ? updates.notes.length > 0 ? { notes: updates.notes } : { }
              : { }),
            ...(Array.isArray(updates.tags)
              ? (updates.tags as readonly string[]).length > 0 ? { tags: updates.tags as readonly string[] } : { }
              : { }),
            ...(typeof updates.dueAt === "string" ? { dueAt: updates.dueAt } : { }),
            ...(typeof updates.urgent === "boolean" ? { urgent: updates.urgent } : { })
          };
          // Clear-out semantics: --notes "" / --tags "" / --due none drop the field.
          updated = {
            ...patched,
            ...(typeof updates.notes === "string" && updates.notes.length === 0 ? { notes: undefined } : {}),
            ...(Array.isArray(updates.tags) && (updates.tags as readonly string[]).length === 0 ? { tags: undefined } : {}),
            ...(updates.dueAt === null ? { dueAt: undefined } : {})
          };
          return current.map((task, taskIndex) => taskIndex === index ? updated! : task);
        });
        return serializeTask(updated!);
      };
      const editApi = async (): Promise<Record<string, unknown>> => (await helpers.apiRequest(
        io,
        command,
        `/api/tasks/${encodeURIComponent(id)}`,
        updates,
        "PATCH"
      )) as Record<string, unknown>;
      const updated = await taskLocalFallback(io, Boolean(options.local), editLocal, editApi);
      if (options.json) {
        helpers.writeOutput(io, updated);
        return;
      }
      io.stdout(`Updated [${String(updated.id).slice(0, 12)}] ${String(updated.title)}\n`);
    });

  tasks
    .command("delete")
    .description("Remove a task (--local skips the API)")
    .argument("<id>", "Task id, id prefix, or title")
    .option("--local", "Delete from the local tasks file instead of calling the API")
    .action(async (id: string, options: { readonly local?: boolean }, command) => {
      const deleteLocal = async (): Promise<string> => {
        const file = localTasksFile();
        let resolved: string | undefined;
        await mutateTasks(file, (current) => {
          resolved = resolveLocalTaskId(id, current);
          return current.filter((task) => task.id !== resolved);
        });
        return resolved!;
      };
      const deleteApi = async (): Promise<string> => {
        await helpers.apiRequest(io, command, `/api/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
        return id;
      };
      const deleted = await taskLocalFallback(io, Boolean(options.local), deleteLocal, deleteApi);
      io.stdout(`Deleted task ${deleted}\n`);
    });
}

/** Keep only tasks carrying `tag` (case-insensitive exact label match). */
export function filterTasksByTag<T extends { readonly tags?: unknown }>(tasks: readonly T[], tag: string): T[] {
  const want = tag.trim().toLowerCase();
  if (want.length === 0) {
    return [...tasks];
  }
  return tasks.filter(
    (task) => Array.isArray(task.tags) && task.tags.some((t) => typeof t === "string" && t.toLowerCase() === want)
  );
}

/**
 * Filter listed tasks to those whose title or notes contains `query`
 * (case-insensitive) — `muse tasks list --search`. Operates on the
 * serialized task records (title / notes are the searchable text), so
 * it works the same for the local file and the API payload.
 */
export function filterTasksBySearch<T extends { readonly title?: unknown; readonly notes?: unknown }>(
  tasks: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...tasks];
  }
  return tasks.filter((task) => {
    const title = typeof task.title === "string" ? task.title.toLowerCase() : "";
    const notes = typeof task.notes === "string" ? task.notes.toLowerCase() : "";
    return title.includes(q) || notes.includes(q);
  });
}

export type DueWindow =
  | { readonly kind: "overdue" }
  | { readonly kind: "today" }
  | { readonly kind: "within"; readonly days: number };

/**
 * Parse a `--due` value: `overdue`, `today`, `week` (= 7 days), or a positive
 * integer N (= the next N days). Returns undefined for anything else so the
 * caller rejects it loudly rather than silently filtering on the wrong window.
 */
export function parseDueWindow(value: string): DueWindow | undefined {
  const v = value.trim().toLowerCase();
  if (v === "overdue") return { kind: "overdue" };
  if (v === "today") return { kind: "today" };
  if (v === "week") return { days: 7, kind: "within" };
  if (/^\d+$/u.test(v)) {
    const days = Number.parseInt(v, 10);
    if (days >= 1) return { days, kind: "within" };
  }
  return undefined;
}

/**
 * Keep only tasks whose `dueAt` falls in the window (a task with no / unparseable
 * dueAt has no due window, so it is excluded). `overdue` = due strictly before
 * now; `today` = due on the current LOCAL calendar day; `within N` = due on or
 * before now + N days, which deliberately INCLUDES anything overdue — the "what
 * must I handle in the next N days" view. Status is filtered separately.
 */
export function filterTasksByDue<T extends { readonly dueAt?: unknown }>(
  tasks: readonly T[],
  window: DueWindow,
  nowMs: number
): T[] {
  return tasks.filter((task) => {
    if (typeof task.dueAt !== "string") return false;
    const due = Date.parse(task.dueAt);
    if (Number.isNaN(due)) return false;
    if (window.kind === "overdue") return due < nowMs;
    if (window.kind === "today") {
      const start = new Date(nowMs);
      start.setHours(0, 0, 0, 0);
      const end = new Date(nowMs);
      end.setHours(23, 59, 59, 999);
      return due >= start.getTime() && due <= end.getTime();
    }
    return due <= nowMs + window.days * 86_400_000;
  });
}

/**
 * Resolve a CLI task reference to a single id. An exact id wins; then a unique
 * id PREFIX; then — the capability this adds — the task TITLE, so
 * `muse tasks complete groceries` works like the agent's "complete the groceries
 * task" instead of demanding the raw uuid (reuses the SAME `resolveTaskRef` the
 * agent tools use: case-insensitive title substring, OPEN tasks preferred).
 * Ambiguity NEVER guesses — it throws with the candidate titles.
 */
export function resolveLocalTaskId(input: string, all: readonly PersistedTask[]): string {
  const exact = all.find((task) => task.id === input);
  if (exact) return exact.id;
  const matches = all.filter((task) => task.id.startsWith(input));
  if (matches.length === 1) {
    return matches[0]!.id;
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous task prefix '${input}' matched ${matches.length.toString()} tasks; use a longer id (full uuid is in the on-disk file or --json output)`);
  }
  const byTitle = resolveTaskRef(all, input);
  if (byTitle.status === "resolved") {
    return byTitle.task.id;
  }
  if (byTitle.status === "ambiguous") {
    const titles = byTitle.candidates.map((task) => `'${task.title}'`).join(", ");
    throw new Error(`'${input}' matches ${byTitle.candidates.length.toString()} tasks: ${titles} — be more specific or use the id`);
  }
  const suggestion = closestCommandName(input.trim(), all.map((t) => t.id));
  const hint = suggestion ? ` — did you mean '${suggestion}'?` : "";
  throw new Error(`task not found: ${input}${hint}`);
}
