import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AttunementStoreError,
  createLocalArtifactValidator,
  createPersonalThread,
  linkArtifact,
  readAttunementState,
  type OpenPreparedContinuityPack
} from "@muse/attunement";
import { writeTasks, type PersistedTask } from "@muse/stores";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAttunementRoutes, type AttunementRoutesGate } from "./attunement-routes.js";

let root: string;
let attunementFile: string;
let notesDir: string;
let tasksFile: string;
let threadId: string;

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-16T10:00:00.000Z",
  id: "task_api_prepare",
  notes: "  Ask Jamie which flowers they prefer.\nThen send matching options.  ",
  status: "open",
  tags: ["birthday", "Jamie"],
  title: "Send flower options"
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "muse-attunement-api-"));
  attunementFile = join(root, "attunement.json");
  notesDir = join(root, "notes");
  tasksFile = join(root, "tasks.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [TASK]);
  const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Prepare birthday" }, {
    idFactory: () => "api",
    now: () => new Date("2026-07-14T00:00:00.000Z")
  });
  threadId = thread.id;
  await linkArtifact(attunementFile, {
    artifactId: TASK.id,
    artifactType: "task",
    role: "next-step",
    threadId
  }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function server(overrides: Partial<AttunementRoutesGate> = {}) {
  const app = Fastify();
  registerAttunementRoutes(app, {
    attunementFile,
    authService: undefined,
    notesDir,
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
    tasksFile,
    ...overrides
  });
  return app;
}

describe("POST /api/attunement/threads/:threadId/continue", () => {
  it("keeps missing threads at a structured 404", async () => {
    const response = await server().inject({ method: "POST", url: "/api/attunement/threads/thread_missing/continue" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ errorMessage: "personal thread not found" });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("keeps externally linked threads at a structured 409 for CLI resolution", async () => {
    await linkArtifact(attunementFile, {
      artifactId: "github/example/issues/1",
      artifactType: "resource",
      providerId: "mcp:github",
      role: "context",
      threadId
    }, {
      validateArtifact: async ({ artifactId, artifactType, providerId }) => ({ artifactId, artifactType, providerId })
    });
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      errorMessage: "this thread has an external resource; continue it through the CLI while its MCP connection is verified"
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("returns the canonical prepared task metadata and records one delivery", async () => {
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pack.nextStep).toMatchObject({
      summary: "Ask Jamie which flowers they prefer. Then send matching options.",
      taskDueAt: TASK.dueAt,
      taskDueState: "overdue",
      taskStatus: "open",
      taskTags: TASK.tags
    });
    expect(body.pack.evidence[0].reference).toEqual({
      artifactId: TASK.id,
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(1);
  });

  it("maps unavailable preparation to a structured 409 without a delivery", async () => {
    await writeTasks(tasksFile, []);
    const response = await server().inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ errorMessage: expect.stringContaining("no currently available linked evidence") });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });

  it("maps a preparation policy race to a structured 409 without a delivery", async () => {
    const openContinuityPack: OpenPreparedContinuityPack = async () => {
      throw new AttunementStoreError("thread policy changed while building this pack; rebuild before opening it");
    };
    const response = await server({ openContinuityPack }).inject({ method: "POST", url: `/api/attunement/threads/${threadId}/continue` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ errorMessage: "thread policy changed while building this pack; rebuild before opening it" });
    expect((await readAttunementState(attunementFile)).deliveries).toHaveLength(0);
  });
});

describe("POST /api/attunement/timing/sessions/:sessionId/evaluate", () => {
  it("previews an offer through preparation without opening a delivery", async () => {
    const app = server();
    const started = await app.inject({
      method: "POST",
      payload: { consentVersion: 1, threadId },
      url: "/api/attunement/timing/sessions"
    });
    const sessionId = started.json().id as string;
    for (const observation of [
      { appCategory: "building", endedAt: "2026-07-17T09:25:00.000Z", startedAt: "2026-07-17T09:00:00.000Z" },
      { appCategory: "planning", endedAt: "2026-07-17T09:50:00.000Z", startedAt: "2026-07-17T09:25:00.000Z" }
    ]) {
      await app.inject({
        method: "POST",
        payload: { ...observation, durationMs: 25 * 60_000 },
        url: `/api/attunement/timing/sessions/${sessionId}/observations`
      });
    }

    const before = (await readAttunementState(attunementFile)).deliveries.length;
    const evaluated = await app.inject({ method: "POST", url: `/api/attunement/timing/sessions/${sessionId}/evaluate` });
    const after = (await readAttunementState(attunementFile)).deliveries.length;

    expect(evaluated.statusCode).toBe(200);
    expect(evaluated.json()).toMatchObject({ candidate: { decision: "offer" }, pack: { nextStep: { taskDueState: "overdue" } } });
    expect(after).toBe(before);
  });
});
