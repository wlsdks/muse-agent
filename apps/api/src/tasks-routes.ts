import { isErrorLike } from "@muse/shared";
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

import {
  retryContinuityTaskCompletionInteractions
} from "@muse/attunement";
import { prepareProductionAuthorizedContinuityTaskCompletionInteraction } from "@muse/attunement/host";
import { compareTasksByDueDate, mutateTasks, parseTaskDueAt, readTasks, readTaskStatusFilter, type PersistedTask } from "@muse/stores";
import { type TasksProviderRegistry } from "@muse/domain-tools";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server.js";

interface TasksRoutesGate {
  readonly attunementFile: string;
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
  const retryContinuityInteractions = async (): Promise<void> => {
    try {
      const summary = await retryContinuityTaskCompletionInteractions(gate.attunementFile, tasksFile);
      for (const error of summary.errors) {
        server.log.warn({ error, eventId: error.eventId }, "continuity interaction evidence recording failed");
      }
    } catch (error) {
      server.log.warn({ error }, "continuity interaction outbox retry failed");
    }
  };

  server.addHook("onReady", retryContinuityInteractions);

  server.get("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readTaskStatusFilter((request.query as { readonly status?: string } | undefined)?.status);
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
    const body = request.body as {
      readonly title?: unknown;
      readonly notes?: unknown;
      readonly tags?: unknown;
      readonly dueAt?: unknown;
    } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return reply.status(400).send({ code: "INVALID_TASK", message: "title must be a non-empty string" });
    }
    let dueAt: string | undefined;
    const dueAtRaw = typeof body?.dueAt === "string" ? body.dueAt.trim() : "";
    if (dueAtRaw.length > 0) {
      const parsed = parseTaskDueAt(dueAtRaw, () => new Date());
      if (isErrorLike(parsed)) {
        return reply.status(400).send({ code: "INVALID_TASK_DUE_AT", message: parsed.message });
      }
      dueAt = parsed;
    }
    const created: PersistedTask = {
      createdAt: new Date().toISOString(),
      id: `task_${randomUUID()}`,
      status: "open",
      title,
      ...(typeof body?.notes === "string" && body.notes.trim().length > 0 ? { notes: body.notes.trim() } : {}),
      ...(Array.isArray(body?.tags)
        ? { tags: (body.tags as unknown[]).filter((entry): entry is string => typeof entry === "string") }
        : {}),
      ...(dueAt ? { dueAt } : {})
    };
    await mutateTasks(tasksFile, (current) => [...current, created]);
    return reply.status(201).send(created);
  });

  server.patch("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const body = request.body as {
      readonly title?: unknown;
      readonly notes?: unknown;
      readonly tags?: unknown;
      readonly dueAt?: unknown;
      readonly urgent?: unknown;
    };
    let dueAt: string | undefined | null;
    if (body.dueAt === null) {
      dueAt = null;
    } else if (typeof body.dueAt === "string" && body.dueAt.trim().length > 0) {
      const parsed = parseTaskDueAt(body.dueAt, () => new Date());
      if (isErrorLike(parsed)) {
        return reply.status(400).send({ code: "INVALID_TASK_DUE_AT", message: parsed.message });
      }
      dueAt = parsed;
    }
    let patched: PersistedTask | undefined;
    await mutateTasks(tasksFile, (current) => {
      const index = current.findIndex((task) => task.id === id);
      if (index < 0) return current;
      const existing = current[index]!;
      patched = { ...existing, ...(typeof body.title === "string" && body.title.trim().length > 0 ? { title: body.title.trim() } : {}), ...(typeof body.notes === "string" ? body.notes.length > 0 ? { notes: body.notes } : { notes: undefined } : {}), ...(Array.isArray(body.tags) ? body.tags.length > 0 ? { tags: (body.tags as unknown[]).filter((entry): entry is string => typeof entry === "string") } : { tags: undefined } : {}), ...(dueAt === null ? { dueAt: undefined } : dueAt !== undefined ? { dueAt } : {}), ...(typeof body.urgent === "boolean" ? { urgent: body.urgent } : {}) };
      const next = [...current]; next[index] = patched; return next;
    });
    if (!patched) return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    return patched;
  });

  server.post("/api/tasks/:id/complete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    let completed: PersistedTask | undefined;
    await mutateTasks(tasksFile, async (current) => {
      const index = current.findIndex((task) => task.id === id);
      if (index < 0) return current;
      const existing = current[index]!;
      if (existing.status === "done") {
        completed = existing;
        return current;
      }
      const completedAt = new Date().toISOString();
      await prepareProductionAuthorizedContinuityTaskCompletionInteraction(
        gate.attunementFile,
        { completedAt, taskId: existing.id }
      );
      completed = { ...existing, completedAt, status: "done" };
      const next = [...current];
      next[index] = completed;
      return next;
    });
    if (!completed) return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    await retryContinuityInteractions();
    return completed;
  });

  server.delete("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    let removed = false;
    await mutateTasks(tasksFile, (current) => { const next = current.filter((task) => task.id !== id); removed = next.length !== current.length; return next; });
    if (!removed) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
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
