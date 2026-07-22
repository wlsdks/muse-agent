/**
 * `/api/works/*` — the "일" (Work) surface: docs/design/muse-work.md. A Work
 * is a reference-only BINDING (goal + linked flows/board-tasks/thread +
 * outcome history) — it never executes anything, never sends anything, and
 * deleting one only severs its own references (the linked stores are never
 * touched from here).
 *
 * Link/unlink validates the target id against the store it names before
 * writing the reference (fail-close — a Work never carries a dangling
 * reference). The scheduler / board / attunement stores are all cheaply
 * readable, so every kind gets a real existence check EXCEPT `flow` when no
 * scheduler is wired at all (a server built without one, e.g. some tests) —
 * that case links unchecked and returns an honest `meta.warning` rather than
 * inventing scheduler plumbing this route doesn't otherwise need.
 */

import {
  addWorkOutcome,
  createWork,
  getWork,
  linkWorkBoardTask,
  linkWorkFlow,
  listWorks,
  serializeWork,
  unlinkWorkBoardTask,
  unlinkWorkFlow,
  updateWork,
  WorksStoreError,
  type WorkOutcomeKind,
  type WorkStatus
} from "@muse/stores";
import { defaultBoardFile, readBoard } from "@muse/multi-agent";
import { AttunementStoreError, deleteWorkContinuitySafe, projectWorkContinuity, setWorkContinuityThread } from "@muse/attunement";
import type { FastifyInstance } from "fastify";

import { requireAuthenticated } from "./server-helpers.js";
import type { SchedulerRouteScheduler } from "./scheduler-routes.js";
import type { ServerOptions } from "./server.js";

export interface WorksRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly worksFile: string;
  readonly attunementFile: string;
  readonly scheduler?: SchedulerRouteScheduler;
}

const WORK_STATUSES: readonly WorkStatus[] = ["active", "paused", "done"];
const OUTCOME_KINDS: readonly WorkOutcomeKind[] = ["used", "adjusted", "ignored"];
const LINK_KINDS = ["flow", "task", "thread"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

export function registerWorksRoutes(server: FastifyInstance, gate: WorksRoutesGate): void {
  const flowExists = async (id: string): Promise<{ readonly checked: boolean; readonly exists: boolean }> => {
    if (!gate.scheduler) {
      return { checked: false, exists: true };
    }
    const job = await (gate.scheduler.service?.findById(id) ?? gate.scheduler.store.findById(id));
    return { checked: true, exists: Boolean(job) };
  };
  const boardTaskExists = async (id: string): Promise<boolean> => {
    const tasks = await readBoard(defaultBoardFile());
    return tasks.some((task) => task.id === id);
  };

  server.get("/api/works", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const works = await listWorks(gate.worksFile);
    return {
      continuityReferences: works.flatMap((work) => {
        try {
          projectWorkContinuity(work, work.id);
          return [{ artifactId: work.id, artifactType: "work", providerId: "local", role: "context" }];
        } catch {
          return [];
        }
      }),
      works: works.map(serializeWork)
    };
  });

  server.get("/api/works/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const work = await getWork(gate.worksFile, id);
    if (!work) {
      return reply.status(404).send({ code: "WORK_NOT_FOUND", message: `no work with id '${id}'` });
    }
    return serializeWork(work);
  });

  server.post("/api/works", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const body = request.body as { readonly name?: unknown; readonly goal?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
    if (name.length === 0) {
      return reply.status(400).send({ code: "INVALID_WORK", message: "name must be a non-empty string" });
    }
    if (goal.length === 0) {
      return reply.status(400).send({ code: "INVALID_WORK", message: "goal must be a non-empty string" });
    }
    const created = await createWork(gate.worksFile, { goal, name });
    return reply.status(201).send(serializeWork(created));
  });

  server.patch("/api/works/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    const body = request.body as { readonly name?: unknown; readonly status?: unknown } | null;
    if (typeof body?.status === "string" && !WORK_STATUSES.includes(body.status as WorkStatus)) {
      return reply.status(400).send({ code: "INVALID_WORK_STATUS", message: `status must be one of ${WORK_STATUSES.join(", ")} (got '${body.status}')` });
    }
    try {
      const updated = await updateWork(gate.worksFile, id, {
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(typeof body?.status === "string" ? { status: body.status as WorkStatus } : {})
      });
      return serializeWork(updated);
    } catch (cause) {
      return sendWorksStoreError(reply, cause, id);
    }
  });

  server.post("/api/works/:id/link", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id: workId } = request.params as { readonly id: string };
    const body = request.body as { readonly kind?: unknown; readonly id?: unknown } | null;
    const kind = body?.kind;
    const targetId = typeof body?.id === "string" ? body.id.trim() : "";
    if (!isLinkKind(kind)) {
      return reply.status(400).send({ code: "INVALID_LINK_KIND", message: `kind must be one of ${LINK_KINDS.join(", ")} (got '${String(kind)}')` });
    }
    if (targetId.length === 0) {
      return reply.status(400).send({ code: "INVALID_LINK_ID", message: "id must be a non-empty string" });
    }
    try {
      if (kind === "flow") {
        const check = await flowExists(targetId);
        const work = await linkWorkFlow(gate.worksFile, workId, targetId, () => check.exists);
        return {
          work: serializeWork(work),
          ...(check.checked ? {} : { meta: { warning: "no scheduler configured on this server — the flow id was linked WITHOUT an existence check" } })
        };
      }
      if (kind === "task") {
        const work = await linkWorkBoardTask(gate.worksFile, workId, targetId, boardTaskExists);
        return { work: serializeWork(work) };
      }
      const work = await setWorkContinuityThread({ attunementFile: gate.attunementFile, worksFile: gate.worksFile }, { threadId: targetId, workId });
      return { work: serializeWork(work) };
    } catch (cause) {
      return sendWorksStoreError(reply, cause, workId);
    }
  });

  server.delete("/api/works/:id/link", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id: workId } = request.params as { readonly id: string };
    const body = request.body as { readonly kind?: unknown; readonly id?: unknown } | null;
    const kind = body?.kind;
    if (!isLinkKind(kind)) {
      return reply.status(400).send({ code: "INVALID_LINK_KIND", message: `kind must be one of ${LINK_KINDS.join(", ")} (got '${String(kind)}')` });
    }
    try {
      if (kind === "flow") {
        const targetId = typeof body?.id === "string" ? body.id.trim() : "";
        const work = await unlinkWorkFlow(gate.worksFile, workId, targetId);
        return { work: serializeWork(work) };
      }
      if (kind === "task") {
        const targetId = typeof body?.id === "string" ? body.id.trim() : "";
        const work = await unlinkWorkBoardTask(gate.worksFile, workId, targetId);
        return { work: serializeWork(work) };
      }
      const work = await setWorkContinuityThread({ attunementFile: gate.attunementFile, worksFile: gate.worksFile }, { workId });
      return { work: serializeWork(work) };
    } catch (cause) {
      return sendWorksStoreError(reply, cause, workId);
    }
  });

  server.post("/api/works/:id/outcome", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id: workId } = request.params as { readonly id: string };
    const body = request.body as { readonly kind?: unknown; readonly note?: unknown } | null;
    if (typeof body?.kind !== "string" || !OUTCOME_KINDS.includes(body.kind as WorkOutcomeKind)) {
      return reply.status(400).send({ code: "INVALID_OUTCOME_KIND", message: `kind must be one of ${OUTCOME_KINDS.join(", ")} (got '${String(body?.kind)}')` });
    }
    try {
      const updated = await addWorkOutcome(gate.worksFile, workId, {
        kind: body.kind as WorkOutcomeKind,
        ...(typeof body.note === "string" ? { note: body.note } : {})
      });
      return serializeWork(updated);
    } catch (cause) {
      return sendWorksStoreError(reply, cause, workId);
    }
  });

  server.delete("/api/works/:id", async (request, reply) => {
    if (!requireAuthenticated(request, reply, Boolean(gate.authService))) {
      return reply;
    }
    const { id } = request.params as { readonly id: string };
    try {
      const removed = await deleteWorkContinuitySafe({ attunementFile: gate.attunementFile, worksFile: gate.worksFile }, id);
      if (!removed) {
        return reply.status(404).send({ code: "WORK_NOT_FOUND", message: `no work with id '${id}'` });
      }
      return reply.status(204).send();
    } catch (cause) {
      return sendWorksStoreError(reply, cause, id);
    }
  });
}

function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);
}

/**
 * `WorksStoreError` carries the exact, actionable reason (unknown work id,
 * refused link to a nonexistent target, invalid rename/status) — surfaced
 * verbatim per the CLI/API usability rule rather than collapsed to a bare
 * 500. Unknown-work-id errors are 404; a refused link / invalid input is 400.
 */
function sendWorksStoreError(
  reply: { status: (code: number) => { send: (body: unknown) => unknown } },
  cause: unknown,
  workId: string
): unknown {
  if (cause instanceof WorksStoreError || cause instanceof AttunementStoreError) {
    const status = cause.message.includes(`no work with id '${workId}'`) ? 404 : 400;
    return reply.status(status).send({ code: "WORKS_STORE_ERROR", message: cause.message });
  }
  throw cause;
}
