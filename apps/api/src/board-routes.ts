/**
 * `/api/board` — the durable agent task board, shared with the CLI
 * (`muse board`). GET feeds the web Kanban; the write routes give the
 * web the same management verbs the CLI has (add / move / retry /
 * review / remove), all through the one persisted FileAgentTaskBoard
 * so both surfaces stay one board. Review resolution goes through
 * `resolveReview` — the draft-first approval seam — never a bare
 * status flip to done.
 */

import { randomUUID } from "node:crypto";

import {
  addTask,
  FileAgentTaskBoard,
  removeTask,
  resolveReview,
  retryTask,
  transitionTask,
  type AgentTask,
  type TaskStatus
} from "@muse/multi-agent";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { toBody } from "./compat-parsers.js";

const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "review", "blocked", "done", "failed"];
const READ_ONLY_BOARD_ERROR = "board is read-only in this wiring";

function boardReadOnlyError(): Error {
  return new Error(READ_ONLY_BOARD_ERROR);
}

async function throwBoardReadOnly(): Promise<never> {
  throw boardReadOnlyError();
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value);
}

interface BoardStore {
  readonly list: () => Promise<readonly AgentTask[]>;
  readonly mutate: (transform: (tasks: readonly AgentTask[]) => AgentTask[]) => Promise<readonly AgentTask[]>;
}

export interface BoardRoutesOptions {
  /** Override the board source (tests inject a fake); defaults to the on-disk board. */
  readonly board?: BoardStore;
  /** @deprecated kept for existing wiring — read-only override. */
  readonly listTasks?: () => Promise<readonly AgentTask[]>;
}

export function registerBoardRoutes(server: FastifyInstance, options: BoardRoutesOptions = {}): void {
  const board: BoardStore = options.board
    ?? (options.listTasks
      ? { list: options.listTasks, mutate: throwBoardReadOnly }
      : new FileAgentTaskBoard());

  server.get("/api/board", async (_request, reply) => {
    const tasks = await board.list();
    return reply.send({ tasks });
  });

  server.post("/api/board/tasks", async (request, reply) => {
    const body = toBody(request.body);
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return reply.status(400).send({ reason: "title is required" });
    }
    const id = randomUUID();
    const tasks = await board.mutate((all) =>
      addTask(all, { id, title, ...(body.description?.trim() ? { description: body.description.trim() } : {}) }, new Date().toISOString())
    );
    return reply.status(201).send({ task: tasks.find((t) => t.id === id) });
  });

  const findOr404 = async (id: string, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) => {
    const tasks = await board.list();
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      reply.status(404).send({ reason: `no task "${id}"` });
    }
    return task;
  };

  server.patch("/api/board/tasks/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = request.params.id;
    const body = toBody(request.body);
    const status = body.status;
    if (!isTaskStatus(status)) {
      return reply.status(400).send({ reason: `status must be one of ${TASK_STATUSES.join(", ")}` });
    }
    if (!(await findOr404(id, reply))) {
      return reply;
    }
    const tasks = await board.mutate((all) => transitionTask(all, id, status, new Date().toISOString()));
    return { task: tasks.find((t) => t.id === id) };
  });

  server.post("/api/board/tasks/:id/retry", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = request.params.id;
    const existing = await findOr404(id, reply);
    if (!existing) {
      return reply;
    }
    if (existing.status !== "blocked" && existing.status !== "failed") {
      return reply.status(409).send({ reason: "only a blocked or failed task can be retried" });
    }
    const tasks = await board.mutate((all) => retryTask(all, id, new Date().toISOString()));
    return { task: tasks.find((t) => t.id === id) };
  });

  server.post("/api/board/tasks/:id/review", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = request.params.id;
    const body = toBody(request.body);
    if (typeof body.approved !== "boolean") {
      return reply.status(400).send({ reason: "approved must be a boolean" });
    }
    const existing = await findOr404(id, reply);
    if (!existing) {
      return reply;
    }
    if (existing.status !== "review") {
      return reply.status(409).send({ reason: "task is not awaiting review" });
    }
    const approved = body.approved;
    const tasks = await board.mutate((all) => resolveReview(all, id, approved, new Date().toISOString()));
    return { task: tasks.find((t) => t.id === id) };
  });

  server.delete("/api/board/tasks/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = request.params.id;
    if (!(await findOr404(id, reply))) {
      return reply;
    }
    await board.mutate((all) => removeTask(all, id));
    return reply.status(204).send();
  });
}
