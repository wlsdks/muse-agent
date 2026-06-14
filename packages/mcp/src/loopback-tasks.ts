import { randomUUID } from "node:crypto";

import type { JsonObject, JsonValue } from "@muse/shared";

import type { LoopbackMcpServer } from "./loopback.js";
import { readString, readStringArray, errorMessage } from "./loopback-helpers.js";
import { hasTimeComponent, isTimeOnlyPhrase, isUtcMidnight, startOfLocalDay, withTimeOfDay } from "./loopback-relative-time.js";
import {
  compareTasksByDueDate,
  parseTaskDueAt,
  mutateTasks,
  readTasks,
  readTaskStatusFilter,
  resolveTaskRef,
  selectTasksDueWithin,
  serializeTaskForModel,
  type PersistedTask
} from "./personal-tasks-store.js";

/**
 * `muse.tasks` loopback MCP server — personal todo list backed by a
 * single JSON file (default `~/.muse/tasks.json` via autoconfigure).
 *
 * Lifted out of `loopback.ts` (which had grown past 1,800 LOC)
 * to keep the on-disk task storage helpers
 * (`readTasks` / `writeTasks` / atomic-rename / shape guards) in
 * one cohesive module. Same public surface as before:
 * `TasksMcpServerOptions` + `createTasksMcpServer`. Both symbols
 * are re-exported from `loopback.ts` so the `@muse/mcp` barrel,
 * autoconfigure, and the existing tests stay byte-identical.
 */

export interface TasksMcpServerOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  readonly maxListEntries?: number;
  readonly maxQueryLength?: number;
  readonly now?: () => Date;
}

/**
 * Personal todo list. Persists tasks as a single JSON file. Reads
 * are idempotent — a missing or unparseable file is treated as
 * empty so a fresh install never throws. Writes are atomic
 * (`tmp` → rename).
 *
 * Tools:
 *   - `muse.tasks.add({ title, notes?, tags? })` — append a new task
 *     with status="open" and a generated id.
 *   - `muse.tasks.list({ status?: "open"|"done"|"all" })` —
 *     due-soonest first (undated last), default status="open".
 *   - `muse.tasks.complete({ id })` — mark a task done with
 *     completedAt timestamp (KEEPS it as a done record).
 *   - `muse.tasks.update({ id, ... })` — reschedule / rename /
 *     toggle urgent / change notes (by id or title word).
 *   - `muse.tasks.delete({ id })` — REMOVE a task entirely (by id
 *     or title word) — for one added by mistake; not a "done".
 *   - `muse.tasks.search({ query, status? })` — substring match on
 *     title, notes, and tags (case-insensitive).
 */
export function createTasksMcpServer(options: TasksMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const idFactory = options.idFactory ?? (() => `task_${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));
  const maxQueryLength = Math.max(1, Math.trunc(options.maxQueryLength ?? 200));

  return {
    description: "Personal todo list (single JSON file, loopback MCP).",
    name: "muse.tasks",
    tools: [
      {
        description:
          "Append a new task. Required: `title`. Optional: `notes` (free-form text), `tags` (string array), `dueAt`, `urgent`. " +
          "Set `urgent: true` for a high-priority task the proactive watcher fires even during the user's quiet hours (e.g. 'pay rent today'). " +
          "`dueAt` accepts either an ISO-8601 timestamp OR a relative phrase. " +
          "English: 'tomorrow', 'tomorrow 6pm', 'today at 14:30', 'in 3 hours', 'in 2 days', 'next Monday', 'next Monday at 9am'. " +
          "Korean: '내일', '내일 오후 3시', '오늘 오전 9시 30분', '30분 후', '3일 뒤', '다음 주 월요일', '다음 주 월요일 오후 3시 반'. " +
          "Pass the user's natural-language phrase directly (in their own language) — the server resolves it against the current local time. " +
          "Returns the created task with its generated id. " +
          "When you confirm the task back to the user, state any due time using the result's `dueAtLocal` field (the due time in the user's local timezone, e.g. 'Thu, Jun 5, 2026, 3:00 PM (tomorrow)') — NEVER the raw ISO `dueAt`, which is in UTC and will read back the wrong hour. " +
          "USE WHEN the user wants to record a new to-do ('우유 사기 할 일에 추가해줘', 'add buy milk to my tasks'); " +
          "you MUST call this tool to actually create it — never just reply that it was added. NOT for VIEWING tasks (use `list`), " +
          "and NOT for a timed REMINDER / alert ('내일 9시 리마인더 맞춰줘' → use the reminders `add` tool).",
        keywords: ["add", "create", "new", "task", "todo", "할일", "할 일", "추가", "등록", "기억해"],
        execute: async (args): Promise<JsonObject> => {
          const title = readString(args, "title")?.trim();
          if (!title) {
            return { error: "title is required" };
          }
          const notes = readString(args, "notes") ?? undefined;
          const tags = readStringArray(args, "tags") ?? undefined;
          const urgent = args["urgent"] === true;
          const dueAtRaw = readString(args, "dueAt")?.trim();
          let dueAt: string | undefined;
          if (dueAtRaw && dueAtRaw.length > 0) {
            const parsed = parseTaskDueAt(dueAtRaw, now);
            if (parsed instanceof Error) {
              return { error: parsed.message };
            }
            dueAt = parsed;
          }
          const created: PersistedTask = {
            createdAt: now().toISOString(),
            id: idFactory(),
            status: "open",
            title,
            ...(notes ? { notes } : {}),
            ...(dueAt ? { dueAt } : {}),
            ...(tags && tags.length > 0 ? { tags } : {}),
            ...(urgent ? { urgent: true } : {})
          };
          try {
            await mutateTasks(file, (current) => [...current, created]);
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { task: serializeTaskForModel(created, now) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: { description: "Optional due time — ISO-8601 (e.g. 2026-05-15T18:00:00Z) or the user's own relative phrase (e.g. 'Friday 9am', '내일 오후 3시'); the server resolves the phrase, so pass it verbatim rather than pre-computing a timezone.", type: "string" },
            notes: { description: "Optional free-text details for the task.", type: "string" },
            tags: { description: "Optional labels for the task.", items: { type: "string" }, type: "array" },
            title: { description: "What the task is, e.g. 'Buy milk' or 'Email the Q3 deck'.", type: "string" },
            urgent: { description: "Set true for a high-priority task fired even during the user's quiet hours, e.g. 'pay rent today'. Omit for a normal task.", type: "boolean" }
          },
          required: ["title"],
          type: "object"
        },
        domain: "tasks",
        // `notes`/`tags` are free-text the 8B fabricates beyond the user's words;
        // drop them when ungrounded (title is required and is the user's content).
        groundedArgs: ["notes", "tags"],
        name: "add",
        risk: "write"
      },
      {
        description:
          "List tasks due-soonest first (undated last). `status`: \"open\" (default), \"done\", or \"all\". " +
          "Pass `dueWithinDays` to answer 'what's due today / this week?' — it returns ONLY open tasks due within that many days, OVERDUE included, soonest first (0 = today + overdue, 7 = this week). " +
          "Pass `tag` to answer 'show my tasks tagged work' — keeps only tasks carrying that label (case-insensitive). " +
          `Returns up to ${maxListEntries} entries.`,
        execute: async (args): Promise<JsonObject> => {
          const tasks = await readTasks(file);
          const tagRaw = (args as Record<string, unknown>)["tag"];
          const tagLabel = typeof tagRaw === "string" ? tagRaw.trim() : "";
          const wantTag = tagLabel.toLowerCase();
          const matchesTag = (taskTags: readonly string[] | undefined): boolean =>
            wantTag.length === 0 || (taskTags?.some((t) => t.toLowerCase() === wantTag) ?? false);
          const dueRaw = (args as Record<string, unknown>)["dueWithinDays"];
          if (typeof dueRaw === "number" && Number.isFinite(dueRaw)) {
            const allDue = selectTasksDueWithin(tasks, { now: now(), withinDays: dueRaw })
              .map((entry) => entry.task)
              .filter((task) => matchesTag(task.tags));
            const due = allDue.slice(0, maxListEntries);
            return {
              dueWithinDays: Math.max(0, Math.trunc(dueRaw)),
              shown: due.length,
              tasks: due.map((task) => serializeTaskForModel(task, now)) as JsonValue,
              total: allDue.length,
              ...(tagLabel ? { tag: tagLabel } : {})
            };
          }
          const status = readTaskStatusFilter(readString(args, "status"));
          const matching = tasks
            .filter((task) => status === "all" || task.status === status)
            .filter((task) => matchesTag(task.tags))
            .sort(compareTasksByDueDate);
          const filtered = matching.slice(0, maxListEntries);
          return {
            shown: filtered.length,
            status,
            tasks: filtered.map((task) => serializeTaskForModel(task, now)) as JsonValue,
            total: matching.length,
            ...(tagLabel ? { tag: tagLabel } : {})
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueWithinDays: { description: "Only OPEN tasks due within this many days (overdue included), e.g. 0 = today + overdue, 7 = this week. Omit to list by status.", type: "number" },
            status: { description: "Which tasks to list: 'open' (default), 'done', or 'all'. Ignored when dueWithinDays is set.", enum: ["open", "done", "all"], type: "string" },
            tag: { description: "Only tasks carrying this label, e.g. 'work'. Case-insensitive exact match. Combines with status / dueWithinDays.", type: "string" }
          },
          type: "object"
        },
        domain: "tasks",
        // List-intent words first (the dominant use — "show my tasks/list"),
        // then the dueWithinDays-filter words. Without the list words a plain
        // "할 일 목록 보여줘" missed this tool and only the keyword-less
        // `search` surfaced, which the model didn't map to a list intent.
        keywords: ["list", "tasks", "task", "todo", "to-do", "할일", "할 일", "목록", "투두", "due", "overdue", "deadline", "마감", "tag", "tagged", "label", "태그"],
        name: "list",
        risk: "read"
      },
      {
        description: "Mark a task DONE (finished). `id` is its id OR a distinct word from its title ('milk'). Sets status=\"done\" and completedAt to now — the task is KEPT as a done record. Use when the user FINISHED a task ('mark milk done', 'I paid the rent'); do NOT use to REMOVE a task added by mistake — use `delete` for that.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const tasks = await readTasks(file);
          const resolution = resolveTaskRef(tasks, ref);
          if (resolution.status === "ambiguous") {
            return { error: `"${ref}" matches multiple tasks — say which one`, candidates: resolution.candidates.map((t) => ({ id: t.id, title: t.title })) as JsonValue };
          }
          if (resolution.status !== "resolved") {
            return { error: `task not found: ${ref}` };
          }
          const index = tasks.findIndex((task) => task.id === resolution.task.id);
          const completed: PersistedTask = {
            ...tasks[index]!,
            completedAt: now().toISOString(),
            status: "done"
          };
          try {
            await mutateTasks(file, (current) => {
              const i = current.findIndex((task) => task.id === resolution.task.id);
              if (i < 0) return current;
              const updatedList = [...current];
              updatedList[i] = { ...current[i]!, completedAt: completed.completedAt, status: "done" };
              return updatedList;
            });
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { task: serializeTaskForModel(completed, now) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The task's id (from `list` / `search`) OR a distinct word from its title — copy it EXACTLY as the task is titled, in its own language; do NOT translate (e.g. 'milk', '운동', '보고서'). An ambiguous word returns candidates.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        keywords: ["task", "todo", "할일", "할 일", "complete", "done", "finish", "finished", "완료", "끝냈", "끝냄", "했어", "마쳤", "마침", "체크", "처리"],
        name: "complete",
        risk: "write"
      },
      {
        description:
          "Update an existing task: reschedule (`dueAt`), rename (`title`), mark/clear `urgent`, or change `notes`. " +
          "`id` is the task's id OR a distinct word from its title ('dentist'). " +
          "`dueAt` accepts an ISO-8601 timestamp or a relative phrase (same as add); pass 'none' to clear the due date. " +
          "`urgent: false` clears the flag; an empty `notes` clears the notes. Provide `id` plus at least one field. " +
          "Use when the user changes a task they already have (e.g. 'move the dentist task to Friday', 'rename it', 'make it urgent'); " +
          "do NOT use to create a new task (use add) or to mark one done (use complete).",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const tasks = await readTasks(file);
          const resolution = resolveTaskRef(tasks, ref);
          if (resolution.status === "ambiguous") {
            return { error: `"${ref}" matches multiple tasks — say which one`, candidates: resolution.candidates.map((t) => ({ id: t.id, title: t.title })) as JsonValue };
          }
          if (resolution.status !== "resolved") {
            return { error: `task not found: ${ref}` };
          }
          const index = tasks.findIndex((task) => task.id === resolution.task.id);
          const title = readString(args, "title")?.trim();
          const notesArg = readString(args, "notes");
          const dueArg = readString(args, "dueAt")?.trim();
          const hasUrgent = typeof args["urgent"] === "boolean";
          if ((title === undefined || title.length === 0) && notesArg === undefined && dueArg === undefined && !hasUrgent) {
            return { error: "provide at least one of: dueAt, title, urgent, notes" };
          }
          // Build the field-level DELTA (which fields to set / clear), not a whole
          // stale snapshot — then re-apply it to the FRESH task inside the write queue
          // (mirror `complete`), so a concurrent change to OTHER fields survives instead
          // of being clobbered by a last-writer-wins overwrite.
          const sets: Record<string, unknown> = {};
          const clears: string[] = [];
          if (title && title.length > 0) {
            sets.title = title;
          }
          if (hasUrgent) {
            if (args["urgent"] === true) sets.urgent = true;
            else clears.push("urgent");
          }
          if (notesArg !== undefined) {
            if (notesArg.length > 0) sets.notes = notesArg;
            else clears.push("notes");
          }
          if (dueArg !== undefined) {
            if (dueArg.length === 0 || dueArg.toLowerCase() === "none") {
              clears.push("dueAt");
            } else {
              // A partial reschedule keeps the unspecified half of the deadline:
              // a bare TIME ("오후 6시로") keeps the task's DATE (anchor to its
              // current due day); a bare DATE ("다음 주 월요일로") keeps its TIME
              // (graft the original time-of-day). A full phrase / ISO uses both.
              const existingDue = typeof tasks[index]!.dueAt === "string" ? new Date(tasks[index]!.dueAt!) : undefined;
              const haveExisting = existingDue !== undefined && !Number.isNaN(existingDue.getTime());
              const anchor = isTimeOnlyPhrase(dueArg) && haveExisting ? () => startOfLocalDay(existingDue!) : now;
              const parsed = parseTaskDueAt(dueArg, anchor);
              if (parsed instanceof Error) {
                return { error: parsed.message };
              }
              // isUtcMidnight excludes a relative OFFSET ("in 2 hours"), which
              // resolves to now-plus-delta rather than a bare date's midnight.
              const isDateOnly = !/^\d{4}-\d{2}-\d{2}T/u.test(dueArg) && !isTimeOnlyPhrase(dueArg)
                && !hasTimeComponent(dueArg) && isUtcMidnight(new Date(parsed));
              sets.dueAt = isDateOnly && haveExisting
                ? withTimeOfDay(new Date(parsed), existingDue!).toISOString()
                : parsed;
            }
          }
          const applyDelta = (base: PersistedTask): PersistedTask => {
            const merged: Record<string, unknown> = { ...base, ...sets };
            for (const key of clears) delete merged[key];
            return merged as unknown as PersistedTask;
          };
          // Fallback for the return value if the task vanished concurrently (i < 0,
          // no write): reflect the requested change against the snapshot we resolved.
          let updated = applyDelta(tasks[index]!);
          try {
            await mutateTasks(file, (current) => {
              const i = current.findIndex((task) => task.id === resolution.task.id);
              if (i < 0) return current;
              updated = applyDelta(current[i]!); // delta onto the FRESH task, not the stale snapshot
              const updatedList = [...current];
              updatedList[i] = updated;
              return updatedList;
            });
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { task: serializeTaskForModel(updated, now) as JsonValue };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            dueAt: { description: "New due date — ISO-8601 (e.g. 2026-05-15T18:00:00Z) or a relative phrase (e.g. 'Friday 9am', '내일 오후 3시'). Pass 'none' to clear.", type: "string" },
            id: { description: "The task's id (from `list` / `search`) OR a distinct word from its title — copy it EXACTLY as the task is titled, in its own language; do NOT translate (e.g. 'milk', '운동', '보고서'). An ambiguous word returns candidates.", type: "string" },
            notes: { description: "New free-text notes; pass an empty string to clear.", type: "string" },
            title: { description: "New title for the task, e.g. 'Email the Q3 deck'.", type: "string" },
            urgent: { description: "true to mark high-priority (fired even in quiet hours), false to clear it.", type: "boolean" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        groundedArgs: ["notes"],
        keywords: ["task", "todo", "할일", "할 일", "update", "change", "edit", "reschedule", "수정", "변경", "바꿔", "고쳐", "연기", "미뤄", "옮겨"],
        name: "update",
        risk: "write"
      },
      {
        description:
          "REMOVE a task entirely — it is deleted, not kept. `id` is the task's id OR a distinct word from its " +
          "title ('milk'); an ambiguous word returns the matching candidates instead of guessing. " +
          "Use when the user added a task by MISTAKE or no longer wants it tracked at all ('delete the milk task', " +
          "'remove that task, I added it by accident', 'scrap the dentist task', '그 항목 삭제해줘'). " +
          "Do NOT use to mark a task FINISHED — `complete` does that and KEEPS it as a done record; " +
          "do NOT use to change a task (use `update`). Returns `{ removed: true, id }`.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id is required" };
          }
          const tasks = await readTasks(file);
          const resolution = resolveTaskRef(tasks, ref);
          if (resolution.status === "ambiguous") {
            return { error: `"${ref}" matches multiple tasks — say which one`, candidates: resolution.candidates.map((t) => ({ id: t.id, title: t.title })) as JsonValue };
          }
          if (resolution.status !== "resolved") {
            return { error: `task not found: ${ref}` };
          }
          try {
            await mutateTasks(file, (current) => current.filter((task) => task.id !== resolution.task.id));
          } catch (error) {
            return { error: errorMessage(error) };
          }
          return { id: resolution.task.id, removed: true };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The task's id (from `list` / `search`) OR a distinct word from its title — copy it EXACTLY as the task is titled, in its own language; do NOT translate (e.g. 'milk', '운동', '보고서'). An ambiguous word returns candidates.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        domain: "tasks",
        keywords: ["task", "todo", "할일", "할 일", "delete", "remove", "삭제", "지워", "지우", "제거", "취소", "빼줘", "없애"],
        name: "delete",
        risk: "write"
      },
      {
        description:
          "Substring search across title, notes, and tags (case-insensitive) — so a task tagged 'work' is found by searching 'work' even when the word isn't in its title. `status` filter optional. " +
          "Returns up to 50 matches newest-first.",
        execute: async (args): Promise<JsonObject> => {
          const query = readString(args, "query")?.trim() ?? "";
          if (query.length === 0) {
            return { error: "query is required" };
          }
          if (query.length > maxQueryLength) {
            return { error: `query too long (max ${maxQueryLength} chars)` };
          }
          const status = readTaskStatusFilter(readString(args, "status"));
          const tasks = await readTasks(file);
          const needle = query.toLowerCase();
          const matches = tasks
            .filter((task) => status === "all" || task.status === status)
            .filter((task) =>
              task.title.toLowerCase().includes(needle)
              || (task.notes?.toLowerCase().includes(needle) ?? false)
              || (task.tags?.some((tag) => tag.toLowerCase().includes(needle)) ?? false)
            )
            .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
            .slice(0, 50);
          return {
            query,
            status,
            tasks: matches.map((task) => serializeTaskForModel(task, now)) as JsonValue,
            total: matches.length
          };
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            query: { description: "Text to find in task titles, notes, or tags, e.g. 'milk', 'Q3', or 'work'.", type: "string" },
            status: { description: "Which tasks to search: 'open' (default), 'done', or 'all'.", enum: ["open", "done", "all"], type: "string" }
          },
          required: ["query"],
          type: "object"
        },
        domain: "tasks",
        name: "search",
        keywords: ["task", "todo", "할일", "할 일", "search", "찾아", "검색", "tag", "태그"],
        risk: "read"
      }
    ]
  };
}

