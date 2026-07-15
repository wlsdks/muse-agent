import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFsWriteTools, FileCheckpointStore, type CheckpointManifest } from "@muse/fs";
import { Command } from "commander";
import { beforeEach, describe, expect, it } from "vitest";

import { formatCheckpointList, registerRollbackCommand, resolveCheckpointRef } from "./commands-rollback.js";

const NOW = new Date("2026-07-15T12:00:00.000Z");

function manifest(over: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    action: "edit",
    at: "2026-07-15T11:55:00.000Z",
    bytes: 4,
    existedBefore: true,
    id: "ckpt_deadbeef0001",
    path: "/abs/notes.md",
    summary: "Apply 1 edit to notes.md",
    version: 1,
    ...over
  };
}

describe("formatCheckpointList", () => {
  it("reports 'no checkpoints yet' for an empty list", () => {
    expect(formatCheckpointList([], NOW)).toContain("No checkpoints yet");
  });

  it("numbers each row and includes id, action, path, summary, relative time", () => {
    const text = formatCheckpointList([manifest()], NOW);
    expect(text).toContain("[ckpt_deadbeef0001]");
    expect(text).toContain("edit");
    expect(text).toContain("/abs/notes.md");
    expect(text).toContain("Apply 1 edit to notes.md");
    expect(text).toContain("5m ago");
  });

  it("flags a truncated (too-large) checkpoint", () => {
    const text = formatCheckpointList([manifest({ truncated: true })], NOW);
    expect(text).toContain("too large to restore");
  });

  it("skips a FUTURE-version checkpoint from the itemized rows and folds it into one warning line (R3-5)", () => {
    const text = formatCheckpointList([manifest({ id: "ckpt_current0001" }), manifest({ id: "ckpt_future00001", version: 2 })], NOW);
    expect(text).toContain("[ckpt_current0001]");
    expect(text).not.toContain("ckpt_future00001");
    expect(text).toContain("1 checkpoint(s) skipped");
    expect(text).toContain("newer version of Muse");
  });

  it("an ALL-future-version list still shows the skip warning instead of an empty/blank list", () => {
    const text = formatCheckpointList([manifest({ version: 2 })], NOW);
    expect(text).toContain("1 checkpoint(s) skipped");
    expect(text).not.toContain("No checkpoints yet");
  });
});

describe("resolveCheckpointRef", () => {
  const list = [manifest({ id: "ckpt_aaaa0001" }), manifest({ id: "ckpt_aaaa0002" }), manifest({ id: "ckpt_bbbb0001" })];

  it("resolves an exact id", () => {
    expect(resolveCheckpointRef(list, "ckpt_bbbb0001")).toEqual({ manifest: list[2], status: "resolved" });
  });

  it("resolves an unambiguous prefix", () => {
    expect(resolveCheckpointRef(list, "ckpt_bbbb")).toEqual({ manifest: list[2], status: "resolved" });
  });

  it("fails closed on an ambiguous prefix — returns every candidate, resolves nothing", () => {
    const result = resolveCheckpointRef(list, "ckpt_aaaa");
    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" ? result.candidates : []).toHaveLength(2);
  });

  it("resolves 'last' to the FIRST (newest) entry in a newest-first list", () => {
    expect(resolveCheckpointRef(list, "last")).toEqual({ manifest: list[0], status: "resolved" });
  });

  it("'last' on an empty list is not-found", () => {
    expect(resolveCheckpointRef([], "last")).toEqual({ status: "not-found" });
  });

  it("an unknown id is not-found", () => {
    expect(resolveCheckpointRef(list, "nope")).toEqual({ status: "not-found" });
  });
});

async function run(dir: string, args: string[]): Promise<{ stdout: string; stderr: string; error?: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prev = process.env.MUSE_CHECKPOINTS_DIR;
  process.env.MUSE_CHECKPOINTS_DIR = dir;
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerRollbackCommand(program, io);
    await program.parseAsync(["node", "muse", "rollback", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (prev === undefined) delete process.env.MUSE_CHECKPOINTS_DIR;
    else process.env.MUSE_CHECKPOINTS_DIR = prev;
  }
  return { error, stderr: stderr.join(""), stdout: stdout.join("") };
}

function checkpointsDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-cli-rollback-"));
}

function targetFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cli-rollback-target-")), "file.md");
}

describe("muse rollback list / muse rollback (no id)", () => {
  it("says there's nothing to roll back when the store is empty", async () => {
    const r = await run(checkpointsDir(), []);
    expect(r.stdout).toContain("No checkpoints yet");
  });

  it("`list` and no-arg produce the same listing", async () => {
    const dir = checkpointsDir();
    const store = new FileCheckpointStore({ dir });
    await store.record({ action: "write", originalContent: undefined, path: "/abs/a.md", summary: "Create a.md" });
    const noArg = await run(dir, []);
    const listArg = await run(dir, ["list"]);
    expect(noArg.stdout).toBe(listArg.stdout);
    expect(noArg.stdout).toContain("/abs/a.md");
  });
});

describe("muse rollback <id> — safety gates", () => {
  it("without --yes, shows the preview and touches nothing", async () => {
    const dir = checkpointsDir();
    const target = targetFile();
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "edit", originalContent: "original", path: target, summary: "Apply 1 edit" });
    await writeFile(target, "current", "utf8");
    const r = await run(dir, [id]);
    expect(r.stdout).toContain("Pass --yes to confirm");
    expect(await readFile(target, "utf8")).toBe("current"); // unchanged
  });

  it("an unknown id refuses with a clear message, nothing touched", async () => {
    const r = await run(checkpointsDir(), ["ckpt_totallymissing", "--yes"]);
    expect(r.error).toMatch(/No checkpoint found/u);
  });

  it("an ambiguous prefix refuses and lists every candidate", async () => {
    const dir = checkpointsDir();
    const store1 = new FileCheckpointStore({ dir, idFactory: () => "ckpt_ambigxxxx1" });
    await store1.record({ action: "write", originalContent: undefined, path: "/abs/1.md", summary: "one" });
    const store2 = new FileCheckpointStore({ dir, idFactory: () => "ckpt_ambigxxxx2" });
    await store2.record({ action: "write", originalContent: undefined, path: "/abs/2.md", summary: "two" });
    const r = await run(dir, ["ckpt_ambigxxxx", "--yes"]);
    expect(r.error).toMatch(/Ambiguous checkpoint id/u);
    expect(r.error).toContain("ckpt_ambigxxxx1");
    expect(r.error).toContain("ckpt_ambigxxxx2");
  });

  it("a truncated checkpoint refuses with the size explanation, nothing touched", async () => {
    const dir = checkpointsDir();
    const store = new FileCheckpointStore({ dir, maxBytesPerSnapshot: 1 });
    const id = await store.record({ action: "write", originalContent: "way too big", path: "/abs/big.md", summary: "Overwrite big.md" });
    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toMatch(/too large to snapshot/u);
  });

  it("a FUTURE-version checkpoint refuses restore fail-closed with a clear message, nothing touched (R3-5)", async () => {
    const dir = checkpointsDir();
    const target = targetFile();
    await writeFile(target, "current on disk", "utf8");
    const id = "ckpt_future0000001";
    const ckptDir = join(dir, id);
    await mkdir(ckptDir, { recursive: true });
    await writeFile(join(ckptDir, "manifest.json"), JSON.stringify({
      action: "edit",
      at: "2026-07-15T00:00:00.000Z",
      bytes: 5,
      existedBefore: true,
      id,
      path: target,
      summary: "written by a newer Muse",
      version: 2
    }), "utf8");
    await writeFile(join(ckptDir, "content"), "older", "utf8");

    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toMatch(/newer version of Muse/u);
    expect(await readFile(target, "utf8")).toBe("current on disk"); // untouched
  });
});

describe("muse rollback <id> --yes — restore semantics", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = checkpointsDir();
    target = targetFile();
  });

  it("rolling back an EDIT restores the file to byte-identical original content", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "edit", originalContent: "before the edit", path: target, summary: "Apply 1 edit" });
    await writeFile(target, "after the edit", "utf8");
    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("before the edit");
  });

  it("rolling back a CREATE (existedBefore:false) deletes the file", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "write", originalContent: undefined, path: target, summary: "Create file.md" });
    await writeFile(target, "created content", "utf8");
    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toBeUndefined();
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("rolling back a DELETE recreates the file with its original content", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "delete", originalContent: "deleted content", path: target, summary: "Delete file.md" });
    // file is currently absent, mirroring a real post-delete state
    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("deleted content");
  });

  it("rolling back a MOVE renames the file back to its source path", async () => {
    const from = join(await mkdtempSourceDir(), "source.md");
    await writeFile(target, "moved body", "utf8");
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "move", fromPath: from, originalContent: undefined, path: target, summary: `Move ${from} -> ${target}` });
    const r = await run(dir, [id, "--yes"]);
    expect(r.error).toBeUndefined();
    expect(await readFile(from, "utf8")).toBe("moved body");
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("records a pre-rollback checkpoint of the CURRENT state before restoring (undo-of-undo)", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "edit", originalContent: "v1", path: target, summary: "Apply 1 edit" });
    await writeFile(target, "v2 (current, about to be overwritten by rollback)", "utf8");
    await run(dir, [id, "--yes"]);
    const all = await store.list();
    const preRollback = all.find((m) => m.summary === `pre-rollback of ${id}`);
    expect(preRollback).toBeDefined();
    expect(preRollback?.existedBefore).toBe(true);
  });

  it("resolves 'last' to the most recently recorded checkpoint", async () => {
    const store1 = new FileCheckpointStore({ dir, now: () => new Date("2026-01-01T00:00:00.000Z") });
    await store1.record({ action: "write", originalContent: undefined, path: join(dir, "..", "old.md"), summary: "old" });
    const store2 = new FileCheckpointStore({ dir, now: () => new Date("2026-01-02T00:00:00.000Z") });
    await writeFile(target, "newest content", "utf8");
    await store2.record({ action: "edit", originalContent: "newest before", path: target, summary: "newest" });
    const r = await run(dir, ["last", "--yes"]);
    expect(r.error).toBeUndefined();
    expect(await readFile(target, "utf8")).toBe("newest before");
  });
});

describe("muse rollback --json", () => {
  it("prints the raw manifest payload", async () => {
    const dir = checkpointsDir();
    const store = new FileCheckpointStore({ dir });
    await store.record({ action: "write", originalContent: undefined, path: "/abs/a.md", summary: "Create a.md" });
    const r = await run(dir, ["--json"]);
    const parsed = JSON.parse(r.stdout) as { total: number; checkpoints: unknown[] };
    expect(parsed.total).toBe(1);
    expect(parsed.checkpoints).toHaveLength(1);
  });
});

async function mkdtempSourceDir(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "muse-cli-rollback-source-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("byte fidelity — a BINARY file deleted via the REAL file_delete tool restores byte-for-byte (AC1 regression)", () => {
  it("deleting a JPEG then `muse rollback last --yes` restores the exact original bytes, not a UTF-8-mangled string", async () => {
    const dir = checkpointsDir();
    const targetDir = mkdtempSync(join(tmpdir(), "muse-cli-rollback-jpeg-"));
    const target = join(targetDir, "photo.jpg");
    // JPEG SOI/APP0 header — not valid UTF-8 (0xFF has no valid continuation
    // here). A "utf8" read/write ANYWHERE on this path corrupts it to U+FFFD.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x80, 0xc3, 0x28]);
    await writeFile(target, jpegBytes);

    const store = new FileCheckpointStore({ dir });
    const tools = createFsWriteTools({
      approvalGate: () => ({ approved: true }),
      baseDir: targetDir,
      checkpointStore: store,
      roots: [targetDir]
    });
    const deleteTool = tools.find((t) => t.definition.name === "file_delete");
    if (!deleteTool) throw new Error("file_delete tool missing from createFsWriteTools()");
    const deleteOut = (await deleteTool.execute({ path: target }, { runId: "byte-fidelity-test" })) as { deleted?: boolean };
    expect(deleteOut.deleted).toBe(true);
    await expect(readFile(target)).rejects.toThrow(); // the delete actually happened

    const r = await run(dir, ["last", "--yes"]);
    expect(r.error).toBeUndefined();

    const restored = await readFile(target);
    expect(Buffer.compare(restored, jpegBytes)).toBe(0);
    // The specific failure mode this guards: a lossy UTF-8 round-trip
    // silently shrinks/rewrites the byte count (11 raw bytes -> 22 bytes of
    // U+FFFD replacement-character UTF-8 sequences).
    expect(restored.length).toBe(jpegBytes.length);
  });
});
