import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createPersonalThread,
  linkArtifact,
  readAttunementState
} from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat Continuity Pack preview/open tools", () => {
  it("previews byte-identically and only an exact current digest opens one delivery", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-"));
    const attunementFile = join(directory, "attunement.json");
    const notesDir = join(directory, "notes");
    const tasksFile = join(directory, "tasks.json");
    const task = {
      createdAt: "2026-07-28T00:00:00.000Z",
      id: "task_pack",
      status: "open",
      title: "Continue Pack work"
    } as const;
    await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Daily agent release"
    });
    await linkArtifact(attunementFile, {
      artifactId: task.id,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile })
    });
    const assembly = createMuseRuntimeAssembly({
      env: {
        HOME: directory,
        MUSE_ATTUNEMENT_FILE: attunementFile,
        MUSE_NOTES_DIR: notesDir,
        MUSE_TASKS_FILE: tasksFile
      }
    });
    const previews = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.pack.preview"
    );
    const opens = assembly.toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.pack.open"
    );
    expect(previews).toHaveLength(1);
    expect(opens).toHaveLength(1);
    expect(previews[0]!.definition.risk).toBe("read");
    expect(opens[0]!.definition.risk).toBe("write");
    expect(previews[0]!.definition.description).toContain("never opens the Pack");
    expect(opens[0]!.definition.description).toContain("exactly one delivery receipt");

    const before = await readFile(attunementFile);
    const first = await previews[0]!.execute(
      { threadId: thread.id },
      { runId: "preview_1" }
    );
    const second = await previews[0]!.execute(
      { threadId: thread.id },
      { runId: "preview_2" }
    );
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      mutation: false,
      pack: {
        evidenceCount: 1,
        thread: { id: thread.id },
        totalEvidence: 1,
        truncated: false
      },
      previewDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(await readFile(attunementFile)).toEqual(before);
    expect((await readAttunementState(attunementFile)).deliveries).toEqual([]);

    await expect(opens[0]!.execute({
      previewDigest: "0".repeat(64),
      threadId: thread.id
    }, { runId: "bad_digest" })).rejects.toThrow(/stale or does not match/u);
    expect(await readFile(attunementFile)).toEqual(before);

    const previewDigest = (first as { readonly previewDigest: string }).previewDigest;
    await writeFile(tasksFile, JSON.stringify({ tasks: [] }));
    await expect(opens[0]!.execute({
      previewDigest,
      threadId: thread.id
    }, { runId: "unavailable" })).rejects.toThrow(/stale or does not match/u);
    expect((await readAttunementState(attunementFile)).deliveries).toEqual([]);

    await writeFile(tasksFile, JSON.stringify({ tasks: [task] }));
    await expect(opens[0]!.execute({
      previewDigest,
      threadId: thread.id
    }, { runId: "open_1" })).resolves.toMatchObject({
      delivery: {
        evidenceCount: 1,
        id: expect.stringMatching(/^delivery_/u),
        threadId: thread.id
      },
      success: true
    });
    const state = await readAttunementState(attunementFile);
    expect(state.deliveries).toHaveLength(1);
    expect(state.deliveries[0]).toMatchObject({
      evidenceClass: "organic",
      threadId: thread.id
    });
  });

  it("rejects extra, accessor, and custom-prototype input before reading a Pack", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-pack-shape-"));
    const preview = createMuseRuntimeAssembly({
      env: { HOME: directory }
    }).toolRegistry.list().find(
      (tool) => tool.definition.name === "muse.continuity.pack.preview"
    )!;
    let getterReads = 0;
    const accessor = Object.defineProperty({}, "threadId", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "thread_exact";
      }
    });
    const custom = Object.assign(Object.create({ inherited: true }), {
      threadId: "thread_exact"
    });

    await expect(preview.execute(
      { threadId: "thread_exact", open: true },
      { runId: "extra" }
    )).rejects.toThrow(/requires exactly threadId/u);
    await expect(preview.execute(accessor, { runId: "accessor" }))
      .rejects.toThrow(/plain data property/u);
    await expect(preview.execute(custom, { runId: "custom" }))
      .rejects.toThrow(/plain object/u);
    expect(getterReads).toBe(0);
  });
});
