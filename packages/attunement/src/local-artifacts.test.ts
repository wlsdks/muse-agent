import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTasks, type PersistedTask } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { createLocalExactArtifactResolver, type ArtifactLink } from "./index.js";

const TASK: PersistedTask = {
  createdAt: "2026-07-14T00:00:00.000Z",
  dueAt: "2026-07-18T09:00:00.000Z",
  id: "task_local-parity",
  notes: "  Ask Jamie which flowers they prefer.\nThen send only the matching options.  ",
  status: "open",
  tags: ["birthday", "Jamie"],
  title: "Send the flower options"
};

const LINK: ArtifactLink = {
  artifactId: TASK.id,
  artifactType: "task",
  linkedAt: "2026-07-17T00:00:00.000Z",
  linkedBy: "user",
  providerId: "local",
  role: "next-step",
  threadId: "thread_life"
};

describe("createLocalExactArtifactResolver", () => {
  it("returns one canonical local task shape for every Continuity surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-attunement-local-"));
    const notesDir = join(root, "notes");
    mkdirSync(notesDir);
    const tasksFile = join(root, "tasks.json");
    await writeTasks(tasksFile, [TASK]);

    const resolve = createLocalExactArtifactResolver({ notesDir, tasksFile });

    await expect(resolve(LINK)).resolves.toEqual({
      artifactId: TASK.id,
      artifactType: "task",
      providerId: "local",
      role: "next-step",
      summary: "Ask Jamie which flowers they prefer. Then send only the matching options.",
      taskDueAt: TASK.dueAt,
      taskStatus: "open",
      taskTags: ["birthday", "Jamie"],
      title: TASK.title,
      updatedAt: TASK.createdAt
    });
  });
});
