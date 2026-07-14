/**
 * `/api/tasks/*` routes — the personal-domain trio's todo surface.
 *
 * Public registrar `registerTasksRoutes` is re-exported from
 * `server-routes.ts` so `server.ts` (the only consumer) keeps
 * working through the existing `./server-routes.js` path.
 *
 * Endpoints:
 *   - GET    /api/tasks — list dueAt-first (most-imminent on top, undated last), filterable by status
 *   - POST   /api/tasks — create a new task with title + optional notes/tags/dueAt
 *   - PATCH  /api/tasks/:id — update title/notes/tags/dueAt/urgent in place; null/empty clears
 *   - POST   /api/tasks/:id/complete — mark done with completedAt
 *   - DELETE /api/tasks/:id — remove
 *
 * Persistence and shape live in `@muse/mcp/personal-tasks-store`
 * (single source of truth shared with the MCP loopback tool and the
 * CLI's --local mode).
 */

import { randomUUID } from "node:crypto";

import { compareTasksByDueDate, parseTaskDueAt, readTasks, readTaskStatusFilter, writeTasks, type PersistedTask } from "@muse/stores";
import { type TasksProviderRegistry } from "@muse/domain-tools";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import { coerceStringArray, readBodyString, readQueryString, readRouteParam, toBody } from "./compat-parsers.js";
import type { ServerOptions } from "./server.js";

interface TasksRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly tasksFile: string;
  /**
   * Optional registry of all configured tasks backends (LocalFile +
   * AppleReminders + future Notion DB). When provided,
   * `/api/tasks/providers` exposes the list so the CLI / web UI can
   * surface what's wired without going through chat. Distinct from
   * `tasksFile`, which is the single JSON path used by the inline
   * filesystem routes (`/api/tasks` GET/POST/etc).
   */
  readonly tasksProviderRegistry?: TasksProviderRegistry;
}

export function registerTasksRoutes(server: FastifyInstance, gate: TasksRoutesGate): void {
  const { tasksFile } = gate;

  server.get("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readTaskStatusFilter(readQueryString(request, "status"));
    const tasks = await readTasks(tasksFile);
    const filtered = tasks
      .filter((task) => status === "all" || task.status === status)
      .sort(compareTasksByDueDate);
    return { status, tasks: filtered, total: filtered.length };
  });

  server.post("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = toBody(request.body);
    const title = readBodyString(body, "title") ?? "";
    if (title.length === 0) {
      return reply.status(400).send({ code: "INVALID_TASK", message: "title must be a non-empty string" });
    }
    let dueAt: string | undefined;
    const dueAtRaw = readBodyString(body, "dueAt") ?? "";
    if (dueAtRaw.length > 0) {
      const parsed = parseTaskDueAt(dueAtRaw, () => new Date());
      if (parsed instanceof Error) {
        return reply.status(400).send({ code: "INVALID_TASK_DUE_AT", message: parsed.message });
      }
      dueAt = parsed;
    }
    const requestTags = coerceStringArray(body.tags);
    const tasks = await readTasks(tasksFile);
    const created: PersistedTask = {
      createdAt: new Date().toISOString(),
      id: `task_${randomUUID()}`,
      status: "open",
      title,
      ...(typeof body.notes === "string" && body.notes.trim().length > 0 ? { notes: body.notes.trim() } : {}),
      ...(requestTags ? { tags: requestTags } : {}),
      ...(dueAt ? { dueAt } : {})
    };
    await writeTasks(tasksFile, [...tasks, created]);
    return reply.status(201).send(created);
  });

  server.patch("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (!id) {
      return reply.status(400).send({ code: "INVALID_TASK_ID", message: "task id is required" });
    }
    const body = toBody(request.body);
    const tasks = await readTasks(tasksFile);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    const existing = tasks[index]!;
    let dueAt: string | undefined | null;
    if (body.dueAt === null) {
      dueAt = null;
    } else if (typeof body.dueAt === "string" && body.dueAt.trim().length > 0) {
      const parsed = parseTaskDueAt(body.dueAt, () => new Date());
      if (parsed instanceof Error) {
        return reply.status(400).send({ code: "INVALID_TASK_DUE_AT", message: parsed.message });
      }
      dueAt = parsed;
    }
    const requestTags = coerceStringArray(body.tags);
    const patched: PersistedTask = {
      ...existing,
      ...(typeof body.title === "string" && body.title.trim().length > 0 ? { title: body.title.trim() } : {}),
      ...(typeof body.notes === "string"
        ? body.notes.length > 0 ? { notes: body.notes } : { notes: undefined }
        : {}),
      ...(requestTags
        ? requestTags.length > 0
          ? { tags: requestTags }
          : { tags: undefined }
        : {}),
      ...(dueAt === null
        ? { dueAt: undefined }
        : dueAt !== undefined ? { dueAt } : {}),
      ...(typeof body.urgent === "boolean" ? { urgent: body.urgent } : {})
    };
    const next = [...tasks];
    next[index] = patched;
    await writeTasks(tasksFile, next);
    return patched;
  });

  server.post("/api/tasks/:id/complete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (!id) {
      return reply.status(400).send({ code: "INVALID_TASK_ID", message: "task id is required" });
    }
    const tasks = await readTasks(tasksFile);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    const completed: PersistedTask = { ...tasks[index]!, completedAt: new Date().toISOString(), status: "done" };
    const next = [...tasks];
    next[index] = completed;
    await writeTasks(tasksFile, next);
    return completed;
  });

  server.delete("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const id = readRouteParam(request, "id");
    if (!id) {
      return reply.status(400).send({ code: "INVALID_TASK_ID", message: "task id is required" });
    }
    const tasks = await readTasks(tasksFile);
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    await writeTasks(tasksFile, next);
    return reply.status(204).send();
  });

  server.get("/api/tasks/providers", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    // When the assembly didn't wire a registry (e.g. server constructed
    // directly in tests with just `tasksFile`), report the inline
    // filesystem-only baseline so the CLI / web UI gets a stable
    // shape regardless of how the server was constructed.
    if (!gate.tasksProviderRegistry) {
      return {
        providers: [
          {
            description: `Inline filesystem-only tasks store rooted at ${tasksFile}.`,
            displayName: "Local file (inline)",
            id: "local",
            local: true
          }
        ]
      };
    }
    return {
      providers: gate.tasksProviderRegistry.describe().map((info) => ({
        description: info.description,
        displayName: info.displayName,
        id: info.id,
        local: info.local
      }))
    };
  });
}
