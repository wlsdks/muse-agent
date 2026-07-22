import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isNotesIndexStale, loadIndex, reindexCheckpointPath, reindexNotes } from "./notes-index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "notes-index-budget-")); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

function embeddingFetch(prompts: string[] = []): typeof globalThis.fetch {
  return (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { prompt: string };
    prompts.push(body.prompt);
    return new Response(JSON.stringify({ embedding: [prompts.length, 0.5] }), { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("bounded resumable notes reindex", () => {
  it("checkpoints a partial file, resumes without duplicate fetches, and publishes only when complete", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "long.md"), `# Long\n\n${"distinct sentence. ".repeat(80)}`);
    const prompts: string[] = [];
    const options = {
      baseUrlResolver: () => "http://127.0.0.1:11434",
      chunkChars: 120,
      dir,
      embedTimeoutMs: 5_000,
      fetchImpl: embeddingFetch(prompts),
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    } as const;

    const first = await reindexNotes(options);
    expect(first).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "budget", status: "pending" });
    await expect(stat(reindexCheckpointPath(indexPath))).resolves.toBeDefined();
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();

    let result = first;
    for (let pass = 0; pass < 30 && result.status !== "complete"; pass += 1) result = await reindexNotes(options);
    expect(result.status).toBe("complete");
    const loaded = await loadIndex(indexPath);
    expect(loaded?.files).toHaveLength(1);
    expect(prompts).toHaveLength(loaded!.files[0]!.chunks.length);
    await expect(stat(reindexCheckpointPath(indexPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns aborted before lock acquisition with zero fetch and no files", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    let calls = 0;
    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => { calls += 1; throw new Error("must not run"); }) as typeof globalThis.fetch,
      indexPath: join(dir, "notes-index.json"),
      maxEmbeddingAttempts: 1,
      model: "test-embed",
      signal: controller.signal
    });
    expect(result).toEqual({ attemptedEmbeddings: 0, indexPath: join(dir, "notes-index.json"), pendingReason: "caller-abort", status: "aborted" });
    expect(calls).toBe(0);
  });

  it("detects an old-mtime new file through path-set equality", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "alpha");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    const old = new Date("2000-01-01T00:00:00.000Z");
    const added = join(dir, "old.md");
    await writeFile(added, "old timestamp, newly added path");
    await utimes(added, old, old);
    expect(await isNotesIndexStale(dir, indexPath)).toBe(true);
  });

  it("keeps the prior model live while a bounded model migration stages multiple files", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "alpha");
    await writeFile(join(dir, "b.md"), "beta");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "old-model" });
    const first = await reindexNotes({ dir, fetchImpl: embeddingFetch(), indexPath, maxEmbeddingAttempts: 1, model: "new-model" });
    expect(first.status).toBe("pending");
    expect((await loadIndex(indexPath))?.model).toBe("old-model");
    const second = await reindexNotes({ dir, fetchImpl: embeddingFetch(), indexPath, maxEmbeddingAttempts: 1, model: "new-model" });
    expect(second.status).toBe("complete");
    expect((await loadIndex(indexPath))?.model).toBe("new-model");
  });

  it("stores a content-addressed sidecar pointer and verifies its digest", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "alpha");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    const metadata = JSON.parse(await readFile(indexPath, "utf8")) as { embeddingFile: string; embeddingSha256: string };
    expect(metadata.embeddingFile).toMatch(/^notes-index\.embeddings\.[0-9a-f]{64}\.bin$/u);
    expect(metadata.embeddingFile).toContain(metadata.embeddingSha256);
  });

  it("admits one writer and makes a contender do zero fetches", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "alpha");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = reindexNotes({
      dir,
      fetchImpl: (async () => {
        firstCalls += 1;
        started.resolve();
        await release.promise;
        return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
      }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    await started.promise;
    const contender = await reindexNotes({
      dir,
      fetchImpl: (async () => { secondCalls += 1; throw new Error("must not fetch"); }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    expect(contender).toEqual({ attemptedEmbeddings: 0, indexPath, pendingReason: "writer-active", status: "busy" });
    expect(secondCalls).toBe(0);
    release.resolve();
    expect((await first).status).toBe("complete");
    expect(firstCalls).toBe(1);
  });

  it("commits deletions before a changed file becomes pending", async () => {
    const indexPath = join(dir, "notes-index.json");
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    await writeFile(a, "alpha");
    await writeFile(b, "beta");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    await rm(b);
    await writeFile(a, `# changed\n${"long content ".repeat(80)}`);
    const partial = await reindexNotes({ chunkChars: 120, dir, fetchImpl: embeddingFetch(), indexPath, maxEmbeddingAttempts: 1, model: "test-embed" });
    expect(partial.status).toBe("pending");
    expect((await loadIndex(indexPath))?.files.map((file) => file.path)).toEqual([a]);
  });

  it("fails closed on vector dimension drift without publishing a partial generation", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "long.md"), "dimension drift ".repeat(80));
    let calls = 0;
    const result = await reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ embedding: calls === 1 ? [1, 0] : [1, 0, 0] }), { status: 200 });
      }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 4,
      model: "test-embed"
    });
    expect(result).toMatchObject({ pendingReason: "embedding-error", status: "pending" });
    expect(calls).toBe(2);
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
    await expect(stat(reindexCheckpointPath(indexPath))).resolves.toBeDefined();
  });

  it("keeps the last complete file when vector dimensions drift between files", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.md"), "alpha");
    await writeFile(join(dir, "b.md"), "beta");
    let calls = 0;
    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ embedding: calls === 1 ? [1, 0] : [1, 0, 0] }), { status: 200 });
      }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 2,
      model: "test-embed"
    });
    expect(result).toMatchObject({ pendingReason: "embedding-error", status: "pending" });
    expect((await loadIndex(indexPath))?.files.map((file) => file.path)).toEqual([join(dir, "a.md")]);
  });

  it("rejects source mutation during fetch and never publishes the stale bytes", async () => {
    const indexPath = join(dir, "notes-index.json");
    const note = join(dir, "mutable.md");
    await writeFile(note, "before mutation");
    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => {
        await writeFile(note, "after mutation");
        return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
      }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    expect(result).toMatchObject({ pendingReason: "embedding-error", status: "pending" });
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
    await expect(stat(reindexCheckpointPath(indexPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("observes caller abort after fetch and fences checkpoint and live publication", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "cancel.md"), "cancel at the commit boundary");
    const controller = new AbortController();
    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => {
        controller.abort("stop-before-commit");
        return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 });
      }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed",
      signal: controller.signal
    });
    expect(result).toMatchObject({ pendingReason: "caller-abort", status: "aborted" });
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
    await expect(stat(reindexCheckpointPath(indexPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains G0 immutable bytes across G1 and G2 commits", async () => {
    const indexPath = join(dir, "notes-index.json");
    const note = join(dir, "generation.md");
    const generationPrompts: string[] = [];
    await writeFile(note, "generation zero");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(generationPrompts), force: true, indexPath, model: "test-embed" });
    const g0 = JSON.parse(await readFile(indexPath, "utf8")) as { embeddingFile: string };
    const g0Bytes = await readFile(join(dir, g0.embeddingFile));
    for (const body of ["generation one", "generation two"]) {
      await writeFile(note, body);
      await reindexNotes({ dir, fetchImpl: embeddingFetch(generationPrompts), force: true, indexPath, model: "test-embed" });
    }
    expect(await readFile(join(dir, g0.embeddingFile))).toEqual(g0Bytes);
    expect((await readdir(dir)).filter((name) => name.includes(".embeddings.")).length).toBeGreaterThanOrEqual(3);
  });

  it("discards a hostile checkpoint and restarts from chunk zero", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "long.md"), "hostile checkpoint ".repeat(80));
    const firstPrompts: string[] = [];
    const base = { chunkChars: 120, dir, indexPath, maxEmbeddingAttempts: 1, model: "test-embed" } as const;
    await reindexNotes({ ...base, fetchImpl: embeddingFetch(firstPrompts) });
    const checkpointPath = reindexCheckpointPath(indexPath);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as { file: { relativePath: string } };
    checkpoint.file.relativePath = "../outside.md";
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    const resumedPrompts: string[] = [];
    const result = await reindexNotes({ ...base, fetchImpl: embeddingFetch(resumedPrompts) });
    expect(result).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "budget", status: "pending" });
    expect(resumedPrompts[0]).toBe(firstPrompts[0]);
  });

  it("discards a hostile checkpoint whose dimension conflicts with the committed generation", async () => {
    const indexPath = join(dir, "notes-index.json");
    const note = join(dir, "dimension.md");
    await writeFile(note, "short original");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    await writeFile(note, "dimension checkpoint ".repeat(80));
    const firstPrompts: string[] = [];
    const options = { chunkChars: 120, dir, indexPath, maxEmbeddingAttempts: 1, model: "test-embed" } as const;
    await reindexNotes({ ...options, fetchImpl: embeddingFetch(firstPrompts) });
    const checkpointPath = reindexCheckpointPath(indexPath);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as { chunks: { embedding: number[] }[]; embeddingDim: number };
    checkpoint.embeddingDim = 3;
    checkpoint.chunks = checkpoint.chunks.map((chunk) => ({ ...chunk, embedding: [1, 0, 0] }));
    await writeFile(checkpointPath, JSON.stringify(checkpoint));
    const resumedPrompts: string[] = [];
    const result = await reindexNotes({ ...options, fetchImpl: embeddingFetch(resumedPrompts) });
    expect(result).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "budget", status: "pending" });
    expect(resumedPrompts[0]).toBe(firstPrompts[0]);
    expect((await loadIndex(indexPath))?.files[0]?.chunks[0]?.embedding.length).toBe(2);
  });

  it("counts earlier unresolved files together with the current and unvisited remainder", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "a.pdf"), "not a valid pdf");
    await writeFile(join(dir, "b.md"), "bounded remainder ".repeat(80));
    await writeFile(join(dir, "c.md"), "not visited");
    const result = await reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: embeddingFetch(),
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    expect(result).toMatchObject({
      attemptedEmbeddings: 1,
      embedded: 0,
      failed: 1,
      pendingFiles: 3,
      pendingReason: "budget",
      skipped: 0,
      status: "pending",
      totalChunks: 0,
      totalFiles: 3
    });
  });

  it("completes deletion-only work with zero embedding attempts", async () => {
    const indexPath = join(dir, "notes-index.json");
    const removed = join(dir, "removed.md");
    await writeFile(removed, "remove me");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    await rm(removed);
    let fetches = 0;
    const result = await reindexNotes({
      dir,
      fetchImpl: (async () => { fetches += 1; throw new Error("must not fetch"); }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    expect(result).toMatchObject({ attemptedEmbeddings: 0, pendingFiles: 0, status: "complete", totalFiles: 0 });
    expect(fetches).toBe(0);
    expect((await loadIndex(indexPath))?.files).toEqual([]);
  });

  it("keeps explicit full mode unlimited across chunks and preserves a prior file on failure", async () => {
    const indexPath = join(dir, "notes-index.json");
    const note = join(dir, "full.md");
    await writeFile(note, "original");
    await reindexNotes({ dir, fetchImpl: embeddingFetch(), force: true, indexPath, model: "test-embed" });
    const priorText = (await loadIndex(indexPath))?.files[0]?.chunks[0]?.text;
    await writeFile(note, "explicit full pass ".repeat(80));
    let calls = 0;
    const success = await reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: (async () => { calls += 1; return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 }); }) as typeof globalThis.fetch,
      indexPath,
      model: "test-embed"
    });
    expect(success.status).toBe("complete");
    expect(calls).toBeGreaterThan(1);
    await writeFile(note, "failing full pass ".repeat(80));
    const failed = await reindexNotes({
      chunkChars: 120,
      dir,
      fetchImpl: (async () => new Response("failure", { status: 500 })) as typeof globalThis.fetch,
      indexPath,
      model: "test-embed"
    });
    expect(failed).toMatchObject({ pendingReason: "embedding-error", status: "pending" });
    expect((await loadIndex(indexPath))?.files[0]?.chunks[0]?.text).not.toBe(priorText);
    expect((await loadIndex(indexPath))?.files[0]?.chunks[0]?.text).toContain("explicit full pass");
  });

  it("writes a stable requires-full marker without starting a fetch storm", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "huge.md"), "bounded chunk ".repeat(50_000));
    let fetches = 0;
    const options = {
      chunkChars: 120,
      dir,
      fetchImpl: (async () => { fetches += 1; return new Response(JSON.stringify({ embedding: [1, 0] }), { status: 200 }); }) as typeof globalThis.fetch,
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    } as const;
    expect(await reindexNotes(options)).toMatchObject({ pendingReason: "checkpoint-too-large", status: "pending" });
    expect(fetches).toBe(0);
    expect(JSON.parse(await readFile(reindexCheckpointPath(indexPath), "utf8"))).toMatchObject({ kind: "requires-full", reason: "checkpoint-too-large" });
    expect(await reindexNotes(options)).toMatchObject({ attemptedEmbeddings: 0, pendingReason: "checkpoint-too-large", status: "pending" });
    expect(fetches).toBe(0);
  });

  it("uses actual serialized UTF-8 bytes when a progress checkpoint exceeds its cap", async () => {
    const indexPath = join(dir, "notes-index.json");
    await writeFile(join(dir, "serialized.md"), "quote: \\\" and unicode 한글 ".repeat(20));
    const result = await reindexNotes({
      checkpointMaxBytesForTesting: 256,
      chunkChars: 120,
      dir,
      fetchImpl: embeddingFetch(),
      indexPath,
      maxEmbeddingAttempts: 1,
      model: "test-embed"
    });
    expect(result).toMatchObject({ attemptedEmbeddings: 1, pendingReason: "checkpoint-too-large", status: "pending" });
    expect(JSON.parse(await readFile(reindexCheckpointPath(indexPath), "utf8"))).toMatchObject({ kind: "requires-full", reason: "checkpoint-too-large" });
    await expect(loadIndex(indexPath)).resolves.toBeUndefined();
  });
});
