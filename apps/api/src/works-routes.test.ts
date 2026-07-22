import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, linkWorkContinuity } from "@muse/attunement";
import { addTask } from "@muse/multi-agent";
import { InMemoryScheduledJobStore, type ScheduledJobInput } from "@muse/scheduler";
import { createWork, readWorks, writeWorks } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerWorksRoutes } from "./works-routes.js";

let root: string;
let worksFile: string;
let attunementFile: string;
let boardFile: string;
let previousBoardFile: string | undefined;

const JOB_INPUT: ScheduledJobInput = {
  cronExpression: "0 9 * * *",
  enabled: true,
  jobType: "agent",
  name: "Morning brief"
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-works-api-"));
  worksFile = join(root, "works.json");
  attunementFile = join(root, "attunement.json");
  boardFile = join(root, "board.json");
  previousBoardFile = process.env.MUSE_BOARD_FILE;
  process.env.MUSE_BOARD_FILE = boardFile;
});

afterEach(async () => {
  if (previousBoardFile === undefined) {
    delete process.env.MUSE_BOARD_FILE;
  } else {
    process.env.MUSE_BOARD_FILE = previousBoardFile;
  }
  await rm(root, { force: true, recursive: true });
});

describe("GET /api/works — empty store", () => {
  it("returns an empty list, never a 500", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const res = await server.inject({ method: "GET", url: "/api/works" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ continuityReferences: [], works: [] });
  });

  it("does not advertise projection-ineligible hostile Work text", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    await createWork(worksFile, { goal: "\u0000\t", name: "\u0000\n" }, process.env, {
      idFactory: () => "work_11111111-1111-4111-8111-111111111111"
    });
    const response = await server.inject({ method: "GET", url: "/api/works" });
    expect(response.json().continuityReferences).toEqual([]);
  });
});

describe("POST /api/works — create", () => {
  it("creates a Work from name+goal and rejects an empty one", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });

    const created = await server.inject({
      method: "POST",
      payload: { goal: "다음 주 토요일까지 준비 끝내기", name: "생일 파티 준비" },
      url: "/api/works"
    });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.body) as { id: string; name: string; status: string };
    expect(body.name).toBe("생일 파티 준비");
    expect(body.status).toBe("active");
    const listed = await server.inject({ method: "GET", url: "/api/works" });
    expect(JSON.parse(listed.body).continuityReferences).toEqual([
      { artifactId: body.id, artifactType: "work", providerId: "local", role: "context" }
    ]);

    const rejected = await server.inject({ method: "POST", payload: { goal: "", name: "" }, url: "/api/works" });
    expect(rejected.statusCode).toBe(400);
  });
});

describe("GET /api/works/:id and PATCH", () => {
  it("404s an unknown id, then renames/changes status of a real one", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const missing = await server.inject({ method: "GET", url: "/api/works/nope" });
    expect(missing.statusCode).toBe(404);

    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const patched = await server.inject({
      method: "PATCH",
      payload: { name: "New name", status: "paused" },
      url: `/api/works/${work.id}`
    });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body)).toMatchObject({ name: "New name", status: "paused" });

    const invalidStatus = await server.inject({ method: "PATCH", payload: { status: "cancelled" }, url: `/api/works/${work.id}` });
    expect(invalidStatus.statusCode).toBe(400);
  });

  it("GET and PATCH accept a unique SHORT id prefix — the id `muse work start` prints, not just the full uuid", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, {
      idFactory: () => "work_bb5cb52d-3812-4a11-9000-000000000001"
    });
    const short = work.id.slice(0, 10);

    const shown = await server.inject({ method: "GET", url: `/api/works/${short}` });
    expect(shown.statusCode).toBe(200);
    expect(JSON.parse(shown.body).id).toBe(work.id);

    const patched = await server.inject({ method: "PATCH", payload: { status: "paused" }, url: `/api/works/${short}` });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.body)).toMatchObject({ id: work.id, status: "paused" });
  });
});

describe("POST /api/works/:id/link — flow (validated against the real scheduler store)", () => {
  it("REFUSES a link to a nonexistent scheduler job id with a verbatim actionable message, and never mutates the store", async () => {
    const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => "job_1" });
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, scheduler: { store: schedulerStore }, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readWorks(worksFile);

    const res = await server.inject({
      method: "POST",
      payload: { id: "job_missing", kind: "flow" },
      url: `/api/works/${work.id}/link`
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/no flow.*job_missing/);
    expect(await readWorks(worksFile)).toEqual(before);
  });

  it("links a REAL scheduler job id", async () => {
    const schedulerStore = new InMemoryScheduledJobStore({ idFactory: () => "job_1" });
    const job = await schedulerStore.save(JOB_INPUT);
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, scheduler: { store: schedulerStore }, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({
      method: "POST",
      payload: { id: job.id, kind: "flow" },
      url: `/api/works/${work.id}/link`
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).work.flowIds).toEqual([job.id]);
  });

  it("links unchecked with an honest ⚠ warning when no scheduler is configured at all", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({
      method: "POST",
      payload: { id: "job_anything", kind: "flow" },
      url: `/api/works/${work.id}/link`
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { work: { flowIds: string[] }; meta?: { warning: string } };
    expect(body.work.flowIds).toEqual(["job_anything"]);
    expect(body.meta?.warning).toMatch(/no scheduler configured/);
  });
});

describe("POST /api/works/:id/link — task (validated against the real board store)", () => {
  it("REFUSES a link to a nonexistent board task id, and never mutates the store", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readWorks(worksFile);

    const res = await server.inject({
      method: "POST",
      payload: { id: "task_missing", kind: "task" },
      url: `/api/works/${work.id}/link`
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/no board task.*task_missing/);
    expect(await readWorks(worksFile)).toEqual(before);
  });

  it("links a REAL board task id", async () => {
    const { writeBoard } = await import("@muse/multi-agent");
    const tasks = addTask([], { id: "board_task_1", title: "Book the venue" }, "2026-07-17T00:00:00.000Z");
    await writeBoard(boardFile, tasks);

    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({
      method: "POST",
      payload: { id: "board_task_1", kind: "task" },
      url: `/api/works/${work.id}/link`
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).work.boardTaskIds).toEqual(["board_task_1"]);
  });
});

describe("POST /api/works/:id/link — thread (validated against the real attunement store)", () => {
  it("REFUSES a link to a nonexistent thread id, and never mutates the store", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const before = await readWorks(worksFile);

    const res = await server.inject({
      method: "POST",
      payload: { id: "thread_missing", kind: "thread" },
      url: `/api/works/${work.id}/link`
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/no continuity thread.*thread_missing/);
    expect(await readWorks(worksFile)).toEqual(before);
  });

  it("links a REAL continuity thread id", async () => {
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Prepare birthday" }, { idFactory: () => "thread_1" });
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({
      method: "POST",
      payload: { id: thread.id, kind: "thread" },
      url: `/api/works/${work.id}/link`
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).work.threadId).toBe(thread.id);
  });
});

describe("DELETE /api/works/:id/link — unlink (idempotent, no validation needed)", () => {
  it("unlinks a flow that was linked, and no-ops on one that was never there", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    await writeWorks(worksFile, [{ ...work, flowIds: ["job_1"] }]);

    const res = await server.inject({ method: "DELETE", payload: { id: "job_1", kind: "flow" }, url: `/api/works/${work.id}/link` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).work.flowIds).toEqual([]);

    const noop = await server.inject({ method: "DELETE", payload: { id: "job_never", kind: "flow" }, url: `/api/works/${work.id}/link` });
    expect(noop.statusCode).toBe(200);
  });
});

describe("POST /api/works/:id/outcome", () => {
  it("records an outcome and rejects an invalid kind", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({
      method: "POST",
      payload: { kind: "used", note: "helped a lot" },
      url: `/api/works/${work.id}/outcome`
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).outcomes).toMatchObject([{ kind: "used", note: "helped a lot" }]);

    const bad = await server.inject({ method: "POST", payload: { kind: "nonsense" }, url: `/api/works/${work.id}/outcome` });
    expect(bad.statusCode).toBe(400);
  });
});

describe("DELETE /api/works/:id", () => {
  it("removes the Work; 404s a repeat delete", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });

    const res = await server.inject({ method: "DELETE", url: `/api/works/${work.id}` });
    expect(res.statusCode).toBe(204);

    const again = await server.inject({ method: "DELETE", url: `/api/works/${work.id}` });
    expect(again.statusCode).toBe(404);
  });

  it("refuses deletion while Personal Continuity still links the Work", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const work = await createWork(worksFile, { goal: "goal", name: "Name" }, process.env, { idFactory: () => "work_11111111-1111-4111-8111-111111111111" });
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Continue" });
    await linkWorkContinuity({ attunementFile, worksFile }, { threadId: thread.id, workId: work.id });
    const response = await server.inject({ method: "DELETE", url: `/api/works/${work.id}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("unlink it first");
    expect(await readWorks(worksFile)).toHaveLength(1);
  });

  it("keeps the prior 404 contract for an unknown Work thread assignment", async () => {
    const server = Fastify();
    registerWorksRoutes(server, { attunementFile, authService: undefined, worksFile });
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Continue" });
    const response = await server.inject({
      method: "POST",
      payload: { id: thread.id, kind: "thread" },
      url: "/api/works/work_11111111-1111-4111-8111-111111111111/link"
    });
    expect(response.statusCode).toBe(404);
  });
});
