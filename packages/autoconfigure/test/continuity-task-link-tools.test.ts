import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonalThread, readAttunementState } from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

async function writeTasks(
  file: string,
  tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly status?: "open" | "done";
  }[]
): Promise<void> {
  await writeFile(file, JSON.stringify({
    tasks: tasks.map((task, index) => ({
      createdAt: `2026-07-2${index.toString()}T00:00:00.000Z`,
      id: task.id,
      status: task.status ?? "open",
      title: task.title
    }))
  }));
}

describe("normal-chat continuity exact task link tools", () => {
  it("previews byte-identically, rejects fuzzy/stale sources, then links only the exact approved proposal", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-task-link-"));
    const attunementFile = join(directory, "attunement.json");
    const tasksFile = join(directory, "tasks.json");
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Ship daily-agent loop"
    }, {
      idFactory: () => "daily",
      now: () => new Date("2026-07-28T00:00:00.000Z")
    });
    await writeTasks(tasksFile, [
      { id: "task_alpha123", title: "Close exact link seam" },
      { id: "task_duplicate1", title: "Duplicate title" },
      { id: "task_duplicate2", title: "Duplicate title" }
    ]);
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: directory,
        MUSE_ATTUNEMENT_FILE: attunementFile,
        MUSE_TASKS_FILE: tasksFile
      }
    });
    const preview = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.task.link.preview"
    );
    const confirm = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.task.link"
    );
    expect(preview).toHaveLength(1);
    expect(confirm).toHaveLength(1);
    expect(preview[0]!.definition.risk).toBe("read");
    expect(confirm[0]!.definition.risk).toBe("write");
    expect(preview[0]!.definition.description).toContain("rejects prefix/title lookup");
    expect(confirm[0]!.definition.description).toContain("explicit owner approval");

    const proposal = {
      expectedTitle: "Close exact link seam",
      role: "next-step",
      taskId: "task_alpha123",
      threadId: thread.id
    };
    const before = await readFile(attunementFile);
    const firstPreview = await preview[0]!.execute(proposal, { runId: "preview_1" });
    const secondPreview = await preview[0]!.execute(proposal, { runId: "preview_2" });
    expect(secondPreview).toEqual(firstPreview);
    expect(firstPreview).toMatchObject({
      mutation: false,
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      proposedLink: {
        artifactId: proposal.taskId,
        artifactType: "task",
        providerId: "local",
        role: proposal.role,
        threadId: proposal.threadId
      }
    });
    expect(await readFile(attunementFile)).toEqual(before);

    await expect(preview[0]!.execute(
      { ...proposal, taskId: "task_alpha" },
      { runId: "prefix" }
    )).rejects.toThrow(/exact canonical id/u);
    await expect(preview[0]!.execute(
      { ...proposal, expectedTitle: "Duplicate title", taskId: "Duplicate title" },
      { runId: "duplicate-title" }
    )).rejects.toThrow(/full canonical taskId/u);
    await expect(preview[0]!.execute(
      { ...proposal, expectedTitle: "Old title" },
      { runId: "renamed" }
    )).rejects.toThrow(/was renamed/u);
    await expect(preview[0]!.execute(
      { ...proposal, taskId: "task_deleted" },
      { runId: "deleted" }
    )).rejects.toThrow(/exact canonical id/u);
    expect(await readFile(attunementFile)).toEqual(before);

    const previewDigest = firstPreview["previewDigest"] as string;
    await writeTasks(tasksFile, [
      { id: "task_alpha123", title: "Renamed after preview" }
    ]);
    await expect(confirm[0]!.execute(
      { ...proposal, previewDigest },
      { runId: "confirm_stale" }
    )).rejects.toThrow(/was renamed/u);
    expect(await readFile(attunementFile)).toEqual(before);

    await writeTasks(tasksFile, [
      { id: "task_alpha123", title: "Close exact link seam" }
    ]);
    await expect(confirm[0]!.execute(
      { ...proposal, previewDigest },
      { runId: "confirm_1" }
    )).resolves.toMatchObject({
      created: true,
      success: true
    });
    const linked = await readAttunementState(attunementFile);
    expect(linked.threads[0]!.links).toHaveLength(1);
    expect(linked.threads[0]!.links[0]).toMatchObject({
      artifactId: proposal.taskId,
      artifactType: "task",
      providerId: "local",
      role: proposal.role,
      threadId: proposal.threadId
    });
    const afterFirstLink = await readFile(attunementFile);

    await expect(confirm[0]!.execute(
      { ...proposal, previewDigest },
      { runId: "confirm_duplicate" }
    )).resolves.toMatchObject({
      created: false,
      success: true
    });
    expect(await readFile(attunementFile)).toEqual(afterFirstLink);
  });

  it("rejects extra, accessor, and custom-prototype inputs before any dependency call", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-task-shape-"));
    const assembly = createMuseRuntimeAssembly({
      env: { HOME: directory }
    });
    const preview = assembly.toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.task.link.preview"
    )!;
    let getterReads = 0;
    const accessor = Object.defineProperty({
      expectedTitle: "Title",
      role: "context",
      taskId: "task_exact"
    }, "threadId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "thread_exact";
      }
    });
    const custom = Object.assign(Object.create({ inherited: true }), {
      expectedTitle: "Title",
      role: "context",
      taskId: "task_exact",
      threadId: "thread_exact"
    });

    await expect(preview.execute(
      { expectedTitle: "Title", role: "context", taskId: "task_exact", threadId: "thread_exact", title: "Title" },
      { runId: "extra" }
    )).rejects.toThrow(/requires exactly/u);
    await expect(preview.execute(accessor, { runId: "accessor" }))
      .rejects.toThrow(/plain data property/u);
    await expect(preview.execute(custom, { runId: "custom" }))
      .rejects.toThrow(/plain object/u);
    expect(getterReads).toBe(0);
  });
});
