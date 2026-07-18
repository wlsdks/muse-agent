import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createLocalExactArtifactResolver,
  createPersonalThread,
  linkArtifact,
  openPreparedContinuityPack,
  readAttunementState,
  readContinuityInteractionOutbox,
  resolveContinuityInteractionOutboxFile
} from "@muse/attunement";
import { readTasks, writeTasks } from "@muse/stores";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerTasksRoutes } from "./tasks-routes.js";

describe("task completion Continuity composition", () => {
  it("records factual evidence after the authenticated task route commits open to done", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-task-interaction-api-"));
    const attunementFile = join(root, "attunement.json");
    const notesDir = join(root, "notes");
    const tasksFile = join(root, "tasks.json");
    await mkdir(notesDir);
    await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: "task_api_done", status: "open", title: "Complete through API" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "API interaction" });
    await linkArtifact(attunementFile, {
      artifactId: "task_api_done", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    const opened = await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-07-18T01:00:00.000Z") }
    );
    const app = Fastify();
    registerTasksRoutes(app, { attunementFile, authService: undefined, tasksFile });
    try {
      const response = await app.inject({ method: "POST", url: "/api/tasks/task_api_done/complete" });
      expect(response.statusCode).toBe(200);
      const state = await readAttunementState(attunementFile);
      expect(state.interactionReceipts).toContainEqual(expect.objectContaining({
        artifactId: "task_api_done",
        deliveryId: opened.delivery.id,
        transition: "open-to-done"
      }));
      expect(state.deliveries[0]?.outcome).toBeUndefined();
      const completedAt = response.json<{ completedAt: string }>().completedAt;
      const replay = await app.inject({ method: "POST", url: "/api/tasks/task_api_done/complete" });
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ completedAt: string }>().completedAt).toBe(completedAt);
      expect((await readAttunementState(attunementFile)).interactionReceipts).toHaveLength(1);
      expect((await readContinuityInteractionOutbox(attunementFile)).entries).toHaveLength(0);
    } finally {
      await app.close();
      await rm(root, { recursive: true });
    }
  });

  it("recovers a durable pending receipt on runtime restart after task commit succeeds but recording fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-task-interaction-recorder-failure-"));
    const attunementFile = join(root, "attunement.json");
    const notesDir = join(root, "notes");
    const tasksFile = join(root, "tasks.json");
    const corruptBytes = "{\"invalid\":true}\n";
    const logs: string[] = [];
    let appClosed = false;
    await mkdir(notesDir);
    await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: "task_recorder_failure", status: "open", title: "Commit despite evidence failure" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Recover API interaction" });
    await linkArtifact(attunementFile, {
      artifactId: "task_recorder_failure", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    const opened = await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-07-18T01:00:00.000Z") }
    );
    const validBytes = await readFile(attunementFile, "utf8");
    await writeFile(attunementFile, corruptBytes);
    const app = Fastify({
      logger: {
        level: "warn",
        stream: { write: (message: string) => logs.push(message) }
      }
    });
    registerTasksRoutes(app, { attunementFile, authService: undefined, tasksFile });
    try {
      const response = await app.inject({ method: "POST", url: "/api/tasks/task_recorder_failure/complete" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: "task_recorder_failure", status: "done" });
      expect(await readTasks(tasksFile)).toContainEqual(expect.objectContaining({ id: "task_recorder_failure", status: "done" }));
      expect(await readFile(attunementFile, "utf8")).toBe(corruptBytes);
      expect(corruptBytes).not.toMatch(/outcome|permission|receipt/iu);
      expect(logs.join("\n")).toContain("continuity interaction evidence recording failed");
      await app.close();
      appClosed = true;

      await writeFile(attunementFile, validBytes);
      const recovered = Fastify();
      registerTasksRoutes(recovered, { attunementFile, authService: undefined, tasksFile });
      try {
        await recovered.ready();
        const state = await readAttunementState(attunementFile);
        expect(state.interactionReceipts).toContainEqual(expect.objectContaining({
          artifactId: "task_recorder_failure",
          deliveryId: opened.delivery.id,
          transition: "open-to-done"
        }));
        expect(state.interactionReceipts).toHaveLength(1);
        expect(state.deliveries[0]?.outcome).toBeUndefined();
      } finally {
        await recovered.close();
      }
    } finally {
      if (!appClosed) await app.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps readiness but fail-closes a new completion when the durable outbox is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-task-interaction-outbox-corrupt-"));
    const attunementFile = join(root, "attunement.json");
    const tasksFile = join(root, "tasks.json");
    const outboxFile = resolveContinuityInteractionOutboxFile(attunementFile);
    const corruptBytes = "{\"schemaVersion\":999,\"entries\":[]}\n";
    const logs: string[] = [];
    await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: "task_outbox_corrupt", status: "open", title: "Do not lose intent" }]);
    await writeFile(outboxFile, corruptBytes);
    const app = Fastify({
      logger: {
        level: "warn",
        stream: { write: (message: string) => logs.push(message) }
      }
    });
    registerTasksRoutes(app, { attunementFile, authService: undefined, tasksFile });
    try {
      await expect(app.ready()).resolves.toBeDefined();
      const response = await app.inject({ method: "POST", url: "/api/tasks/task_outbox_corrupt/complete" });
      expect(response.statusCode).toBe(500);
      expect(await readTasks(tasksFile)).toContainEqual(expect.objectContaining({ id: "task_outbox_corrupt", status: "open" }));
      expect(await readFile(outboxFile, "utf8")).toBe(corruptBytes);
      expect(logs.join("\n")).toContain("continuity interaction outbox retry failed");
    } finally {
      await app.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
