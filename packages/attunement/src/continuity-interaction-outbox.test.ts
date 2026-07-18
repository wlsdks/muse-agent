import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutateTasks, writeTasks } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTINUITY_INTERACTION_OUTBOX_MAX_PENDING,
  ContinuityInteractionOutboxError,
  prepareContinuityTaskCompletionInteraction,
  readContinuityInteractionOutbox,
  resolveContinuityInteractionOutboxFile,
  retryContinuityTaskCompletionInteractions
} from "./continuity-interaction-outbox.js";
import {
  createPersonalThread,
  linkArtifact,
  readAttunementState
} from "./attunement-store.js";
import { createLocalArtifactValidator, createLocalExactArtifactResolver } from "./local-artifacts.js";
import { openPreparedContinuityPack } from "./continuity-preparation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(taskId: string) {
  const root = await mkdtemp(join(tmpdir(), "muse-continuity-outbox-"));
  roots.push(root);
  const attunementFile = join(root, "attunement.json");
  const notesDir = join(root, "notes");
  const tasksFile = join(root, "tasks.json");
  await mkdir(notesDir);
  await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: taskId, status: "open", title: "Outbox task" }]);
  const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Outbox thread" });
  await linkArtifact(attunementFile, {
    artifactId: taskId, artifactType: "task", role: "next-step", threadId: thread.id
  }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
  await openPreparedContinuityPack(
    attunementFile,
    thread.id,
    createLocalExactArtifactResolver({ notesDir, tasksFile }),
    { now: () => Date.parse("2026-07-18T01:00:00.000Z") }
  );
  return { attunementFile, root, tasksFile };
}

function pendingEvent(index: number) {
  const taskId = `task_full_${index.toString()}`;
  const completedAt = `2026-07-18T02:${Math.floor(index / 60).toString().padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`;
  const suffix = createHash("sha256").update(`${taskId}\u0000${completedAt}`).digest("hex").slice(0, 24);
  return {
    attempts: 0,
    completedAt,
    eventId: `continuity_interaction_pending_${suffix}`,
    preparedAt: "2026-07-18T01:00:00.000Z",
    taskId
  };
}

describe("Continuity interaction outbox", () => {
  it("is owner-only and refuses to overwrite corrupt or full pending state", async () => {
    const root = await mkdtemp(join(tmpdir(), "muse-continuity-outbox-strict-"));
    roots.push(root);
    const attunementFile = join(root, "attunement.json");
    const outboxFile = resolveContinuityInteractionOutboxFile(attunementFile);
    await prepareContinuityTaskCompletionInteraction(attunementFile, {
      completedAt: "2026-07-18T02:00:00.000Z",
      taskId: "task_owner_only"
    });
    expect((await stat(outboxFile)).mode & 0o777).toBe(0o600);

    const corruptBytes = "{\"schemaVersion\":999,\"entries\":[]}\n";
    await writeFile(outboxFile, corruptBytes);
    await expect(prepareContinuityTaskCompletionInteraction(attunementFile, {
      completedAt: "2026-07-18T02:01:00.000Z",
      taskId: "task_after_corrupt"
    })).rejects.toBeInstanceOf(ContinuityInteractionOutboxError);
    expect(await readFile(outboxFile, "utf8")).toBe(corruptBytes);

    const fullBytes = `${JSON.stringify({
      entries: Array.from({ length: CONTINUITY_INTERACTION_OUTBOX_MAX_PENDING }, (_, index) => pendingEvent(index)),
      schemaVersion: 1
    })}\n`;
    await writeFile(outboxFile, fullBytes);
    await expect(prepareContinuityTaskCompletionInteraction(attunementFile, {
      completedAt: "2026-07-19T00:00:00.000Z",
      taskId: "task_over_capacity"
    })).rejects.toThrow("refusing to drop pending evidence");
    expect(await readFile(outboxFile, "utf8")).toBe(fullBytes);
  });

  it("retains open work, removes mismatches, and replays a receipt without duplication after record-before-ack", async () => {
    const { attunementFile, tasksFile } = await fixture("task_crash_replay");
    const completedAt = "2026-07-18T02:00:00.000Z";
    await prepareContinuityTaskCompletionInteraction(attunementFile, { completedAt, taskId: "task_crash_replay" });

    const open = await retryContinuityTaskCompletionInteractions(attunementFile, tasksFile, { batchSize: Number.NaN });
    expect(open).toMatchObject({ recorded: 0, retained: 1, terminal: 0 });

    await mutateTasks(tasksFile, (tasks) => tasks.map((task) => task.id === "task_crash_replay"
      ? { ...task, completedAt: "2026-07-18T02:01:00.000Z", status: "done" }
      : task));
    const mismatch = await retryContinuityTaskCompletionInteractions(attunementFile, tasksFile);
    expect(mismatch).toMatchObject({ recorded: 0, retained: 0, terminal: 1 });
    expect((await readAttunementState(attunementFile)).interactionReceipts).toHaveLength(0);

    const exact = await fixture("task_exact_replay");
    await prepareContinuityTaskCompletionInteraction(exact.attunementFile, { completedAt, taskId: "task_exact_replay" });
    await mutateTasks(exact.tasksFile, (tasks) => tasks.map((task) => task.id === "task_exact_replay"
      ? { ...task, completedAt, status: "done" }
      : task));
    expect(await retryContinuityTaskCompletionInteractions(exact.attunementFile, exact.tasksFile))
      .toMatchObject({ recorded: 1, retained: 0, terminal: 1 });
    expect((await readAttunementState(exact.attunementFile)).interactionReceipts).toHaveLength(1);

    await prepareContinuityTaskCompletionInteraction(exact.attunementFile, { completedAt, taskId: "task_exact_replay" });
    expect(await retryContinuityTaskCompletionInteractions(exact.attunementFile, exact.tasksFile))
      .toMatchObject({ recorded: 1, retained: 0, terminal: 1 });
    const replayed = await readAttunementState(exact.attunementFile);
    expect(replayed.interactionReceipts).toHaveLength(1);
    expect(replayed.deliveries[0]?.outcome).toBeUndefined();
    expect((await readContinuityInteractionOutbox(exact.attunementFile)).entries).toHaveLength(0);
  });
});
