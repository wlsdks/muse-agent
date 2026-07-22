import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadIndex,
  reindexCheckpointPath,
  reindexNotes,
  type NotesIndexCommitPhase
} from "./notes-index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "notes-index-durability-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

function okEmbeddingFetch(prompts: string[] = []): typeof globalThis.fetch {
  return (async (_url, init) => {
    const prompt = String((JSON.parse(String(init?.body)) as { prompt?: unknown }).prompt ?? "");
    prompts.push(prompt);
    return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
  }) as typeof globalThis.fetch;
}

async function siblingSnapshot(root: string): Promise<ReadonlyMap<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    if ((await stat(path)).isFile()) snapshot.set(name, await readFile(path));
  }
  return snapshot;
}

async function checkpointExists(indexPath: string): Promise<boolean> {
  try {
    await stat(reindexCheckpointPath(indexPath));
    return true;
  } catch {
    return false;
  }
}

async function pointedGeneration(indexPath: string): Promise<string> {
  const metadata = JSON.parse(await readFile(indexPath, "utf8")) as { embeddingFile: string };
  await expect(stat(join(dir, metadata.embeddingFile))).resolves.toBeDefined();
  return metadata.embeddingFile;
}

describe("notes index durable commit boundaries", () => {
  it("rechecks abort immediately after writer-lock acquisition before any mutation", async () => {
    const indexPath = join(dir, "notes-index.json");
    const checkpointPath = reindexCheckpointPath(indexPath);
    await writeFile(indexPath, JSON.stringify({ builtAtIso: "x", files: [], model: "old", version: 999 }));
    await writeFile(join(dir, "notes-index.embeddings.existing.bin"), Buffer.from([1, 2, 3, 4]));
    await writeFile(checkpointPath, "hostile checkpoint bytes");
    await writeFile(`${indexPath}.bak-v998-existing`, "existing backup");
    const before = await siblingSnapshot(dir);
    const controller = new AbortController();
    let fetches = 0;

    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => { fetches += 1; throw new Error("must not fetch"); }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "new",
      onWriterLockAcquiredForTesting: () => controller.abort("cancel at writer entry"),
      signal: controller.signal
    });

    expect(result).toEqual({ attemptedEmbeddings: 0, indexPath, pendingReason: "caller-abort", status: "aborted" });
    expect(fetches).toBe(0);
    expect(await siblingSnapshot(dir)).toEqual(before);
  });

  const phases: readonly NotesIndexCommitPhase[] = [
    "before-checkpoint-commit",
    "after-checkpoint-commit",
    "before-sidecar-write",
    "after-sidecar-write",
    "before-json-commit",
    "after-json-commit",
    "before-checkpoint-delete",
    "after-checkpoint-delete"
  ];

  it.each(phases)("recovers exactly from an injected %s interruption", async (phase) => {
    const indexPath = join(dir, "notes-index.json");
    const note = join(dir, "durable.md");
    await writeFile(note, "generation zero");
    await reindexNotes({ dir, fetchImpl: okEmbeddingFetch(), force: true, indexPath, model: "test-model" });
    const g0Generation = await pointedGeneration(indexPath);
    const changedBody = "durable changed content ".repeat(80);
    await writeFile(note, changedBody);

    const faultPrompts: string[] = [];
    let injected = false;
    await expect(reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: okEmbeddingFetch(faultPrompts),
      indexPath,
      maxEmbeddingAttempts: 64,
      model: "test-model",
      onCommitPhaseForTesting: (seen) => {
        if (!injected && seen === phase) {
          injected = true;
          throw new Error(`crash:${phase}`);
        }
      }
    })).rejects.toThrow(`injected notes-index interruption at ${phase}`);
    expect(injected).toBe(true);

    const afterFault = await loadIndex(indexPath);
    expect(afterFault).toBeDefined();
    const publishCommitted = phase === "after-json-commit"
      || phase === "before-checkpoint-delete"
      || phase === "after-checkpoint-delete";
    if (publishCommitted) {
      expect(afterFault!.files[0]!.chunks.map((chunk) => chunk.text).join(" ")).toContain("durable changed content");
    } else {
      expect(afterFault!.files[0]!.chunks[0]!.text).toBe("generation zero");
    }

    const checkpointCommitted = phase !== "before-checkpoint-commit" && phase !== "after-checkpoint-delete";
    expect(await checkpointExists(indexPath)).toBe(checkpointCommitted);
    const generationsAfterFault = (await readdir(dir)).filter((name) => name.includes(".embeddings.")).sort();
    const generationWritten = phase === "after-sidecar-write"
      || phase === "before-json-commit"
      || publishCommitted;
    expect(generationsAfterFault.length).toBe(generationWritten ? 2 : 1);
    expect(generationsAfterFault).toContain(basename(g0Generation));
    await pointedGeneration(indexPath);

    const recoveryPrompts: string[] = [];
    const recovered = await reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: okEmbeddingFetch(recoveryPrompts),
      indexPath,
      maxEmbeddingAttempts: 64,
      model: "test-model"
    });
    expect(recovered.status).toBe("complete");
    const g1 = await loadIndex(indexPath);
    expect(g1!.files[0]!.chunks.map((chunk) => chunk.text).join(" ")).toContain("durable changed content");
    expect(await checkpointExists(indexPath)).toBe(false);
    await pointedGeneration(indexPath);

    if (phase === "before-checkpoint-commit") {
      expect(recoveryPrompts[0]).toBe(faultPrompts[0]);
    } else if (phase === "after-checkpoint-commit") {
      expect(recoveryPrompts).not.toContain(faultPrompts[0]);
    } else {
      expect(recoveryPrompts).toEqual([]);
    }
  });

  it("rejects same-count and same-dimension sidecar byte corruption without reader writes", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "digest.md"), "digest integrity");
    await reindexNotes({ dir, fetchImpl: okEmbeddingFetch(), force: true, indexPath, model: "test-model" });
    const metadata = JSON.parse(await readFile(indexPath, "utf8")) as { embeddingFile: string; embeddingCount: number; embeddingDim: number };
    const sidecarPath = join(dir, metadata.embeddingFile);
    const sidecar = await readFile(sidecarPath);
    const corrupted = Buffer.from(sidecar);
    corrupted[0] = corrupted[0]! ^ 0xff;
    await writeFile(sidecarPath, corrupted);
    const beforeRead = await siblingSnapshot(dir);

    expect(metadata.embeddingCount).toBe(1);
    expect(metadata.embeddingDim).toBe(2);
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
    expect(await siblingSnapshot(dir)).toEqual(beforeRead);
  });

  it("keeps a later changed file's checkpoint across an earlier cached predecessor", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "cached predecessor");
    const changed = join(dir, "b.md");
    await writeFile(changed, "short original");
    await reindexNotes({ dir, fetchImpl: okEmbeddingFetch(), force: true, indexPath, model: "test-model" });
    await writeFile(changed, "later changed resumable content ".repeat(80));
    const firstPrompts: string[] = [];
    const options = {
      chunkChars: 120,
      dir,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-model"
    } as const;

    const first = await reindexNotes({ ...options, fetchImpl: okEmbeddingFetch(firstPrompts) });
    expect(first).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "budget", skipped: 1, status: "pending" });
    expect(await checkpointExists(indexPath)).toBe(true);

    const secondPrompts: string[] = [];
    const second = await reindexNotes({ ...options, fetchImpl: okEmbeddingFetch(secondPrompts) });
    expect(second).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "budget", skipped: 1, status: "pending" });
    expect(secondPrompts).not.toContain(firstPrompts[0]);
  });
});
