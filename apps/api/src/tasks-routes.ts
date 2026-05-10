/**
 * `/api/tasks/*` routes — extracted from `server-routes.ts` so the
 * tasks surface (one of the personal-domain trio: notes / tasks /
 * calendar) lives in its own module alongside its on-disk
 * persistence helpers.
 *
 * Public registrar `registerTasksRoutes` is re-exported from
 * `server-routes.ts` so `server.ts` (the only consumer) keeps
 * working through the existing `./server-routes.js` path.
 *
 * Endpoints:
 *   - GET    /api/tasks — list newest-first, filterable by status
 *   - POST   /api/tasks — create a new task with title + optional notes/tags
 *   - POST   /api/tasks/:id/complete — mark done with completedAt
 *   - DELETE /api/tasks/:id — remove
 *
 * Backed by a single JSON file (default `~/.muse/tasks.json`).
 * Reads are idempotent (missing/unparseable file → empty list).
 * Writes are atomic (`tmp-<pid>-<ts>` → rename).
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { TasksProviderRegistry } from "@muse/mcp";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
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

interface PersistedTaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export function registerTasksRoutes(server: FastifyInstance, gate: TasksRoutesGate): void {
  const { tasksFile } = gate;

  server.get("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const status = readStatusQuery((request.query as { readonly status?: string } | undefined)?.status);
    const tasks = await readTasksFile(tasksFile);
    const filtered = tasks
      .filter((task) => status === "all" || task.status === status)
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
    return { status, tasks: filtered, total: filtered.length };
  });

  server.post("/api/tasks", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = request.body as { readonly title?: unknown; readonly notes?: unknown; readonly tags?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return reply.status(400).send({ code: "INVALID_TASK", message: "title must be a non-empty string" });
    }
    const tasks = await readTasksFile(tasksFile);
    const created: PersistedTaskRow = {
      createdAt: new Date().toISOString(),
      id: `task_${randomUUID()}`,
      status: "open",
      title,
      ...(typeof body?.notes === "string" && body.notes.trim().length > 0 ? { notes: body.notes.trim() } : {}),
      ...(Array.isArray(body?.tags)
        ? { tags: (body.tags as unknown[]).filter((entry): entry is string => typeof entry === "string") }
        : {})
    };
    await writeTasksFile(tasksFile, [...tasks, created]);
    return reply.status(201).send(created);
  });

  server.post("/api/tasks/:id/complete", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const tasks = await readTasksFile(tasksFile);
    const index = tasks.findIndex((task) => task.id === id);
    if (index < 0) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    const completed: PersistedTaskRow = { ...tasks[index]!, completedAt: new Date().toISOString(), status: "done" };
    const next = [...tasks];
    next[index] = completed;
    await writeTasksFile(tasksFile, next);
    return completed;
  });

  server.delete("/api/tasks/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const tasks = await readTasksFile(tasksFile);
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) {
      return reply.status(404).send({ code: "TASK_NOT_FOUND", message: `task not found: ${id}` });
    }
    await writeTasksFile(tasksFile, next);
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

function readStatusQuery(value: string | undefined): "open" | "done" | "all" {
  return value === "done" || value === "all" ? value : "open";
}

async function readTasksFile(file: string): Promise<readonly PersistedTaskRow[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { readonly tasks?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
      return [];
    }
    return (parsed.tasks as unknown[]).flatMap((entry): readonly PersistedTaskRow[] =>
      isPersistedTaskRow(entry) ? [entry] : []
    );
  } catch {
    return [];
  }
}

async function writeTasksFile(file: string, tasks: readonly PersistedTaskRow[]): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function isPersistedTaskRow(value: unknown): value is PersistedTaskRow {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as PersistedTaskRow).id === "string"
    && typeof (value as PersistedTaskRow).title === "string"
    && typeof (value as PersistedTaskRow).createdAt === "string"
    && ((value as PersistedTaskRow).status === "open" || (value as PersistedTaskRow).status === "done");
}
