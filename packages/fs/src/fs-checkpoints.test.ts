import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_CHECKPOINT_VERSION, createInMemoryCheckpointStore, defaultCheckpointsDir, defaultMaxCheckpoints, FileCheckpointStore } from "./fs-checkpoints.js";

describe("defaultCheckpointsDir / defaultMaxCheckpoints", () => {
  it("uses MUSE_CHECKPOINTS_DIR when set", () => {
    expect(defaultCheckpointsDir({ MUSE_CHECKPOINTS_DIR: "/tmp/custom-ckpts" })).toBe("/tmp/custom-ckpts");
  });

  it("falls back to ~/.muse/checkpoints when unset", () => {
    expect(defaultCheckpointsDir({})).toMatch(/\.muse[/\\]checkpoints$/u);
  });

  it("uses MUSE_CHECKPOINTS_MAX when a positive integer", () => {
    expect(defaultMaxCheckpoints({ MUSE_CHECKPOINTS_MAX: "5" })).toBe(5);
  });

  it("falls back to the default cap on a missing/invalid value", () => {
    expect(defaultMaxCheckpoints({})).toBe(200);
    expect(defaultMaxCheckpoints({ MUSE_CHECKPOINTS_MAX: "not-a-number" })).toBe(200);
    expect(defaultMaxCheckpoints({ MUSE_CHECKPOINTS_MAX: "-3" })).toBe(200);
    expect(defaultMaxCheckpoints({ MUSE_CHECKPOINTS_MAX: "5.5" })).toBe(200);
    expect(defaultMaxCheckpoints({ MUSE_CHECKPOINTS_MAX: "5files" })).toBe(200);
  });
});

describe("FileCheckpointStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-checkpoints-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("rejects invalid storage caps instead of silently bypassing retention", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new FileCheckpointStore({ dir, maxCheckpoints: value })).toThrow(RangeError);
      expect(() => new FileCheckpointStore({ dir, maxBytesPerSnapshot: value })).toThrow(RangeError);
    }
  });

  it("refuses unsafe checkpoint ids before filesystem paths are constructed", async () => {
    const store = new FileCheckpointStore({ dir, idFactory: () => "../../outside" });

    await expect(store.record({ action: "write", originalContent: undefined, path: "/abs/x.md", summary: "x" })).rejects.toThrow(TypeError);
    await expect(store.get("../../outside")).resolves.toBeUndefined();
  });

  it("round-trips a checkpoint: record -> list -> get returns the original content", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "edit", originalContent: "hello world", path: "/abs/notes.md", summary: "Apply 1 edit to notes.md" });
    expect(id).toMatch(/^ckpt_/u);

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ action: "edit", bytes: 11, existedBefore: true, id, path: "/abs/notes.md" });
    // list() is manifest-only — no content leaks into it.
    expect((listed[0] as unknown as { content?: string }).content).toBeUndefined();

    const got = await store.get(id);
    expect(got?.content?.toString("utf8")).toBe("hello world");
    expect(got?.existedBefore).toBe(true);
  });

  it("round-trips ARBITRARY BYTES byte-for-byte — a Buffer originalContent is never decoded/re-encoded through UTF-8", async () => {
    // JPEG SOI/APP0 header bytes — not valid UTF-8 (0xFF is a lone continuation
    // byte with no lead byte). A "utf8" read/write anywhere in the path would
    // silently corrupt this to U+FFFD replacement characters.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x80, 0xc3, 0x28]);
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "delete", originalContent: jpegBytes, path: "/abs/photo.jpg", summary: "Delete photo.jpg" });
    const got = await store.get(id);
    expect(got?.bytes).toBe(jpegBytes.length);
    expect(got?.content).toBeInstanceOf(Buffer);
    expect(Buffer.compare(got?.content ?? Buffer.alloc(0), jpegBytes)).toBe(0);
  });

  it("records existedBefore:false when originalContent is undefined (a brand-new file)", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "write", originalContent: undefined, path: "/abs/new.md", summary: "Create new.md" });
    const got = await store.get(id);
    expect(got?.existedBefore).toBe(false);
    expect(got?.bytes).toBe(0);
    expect(got?.content).toBeUndefined();
  });

  it("carries fromPath for a move checkpoint", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "move", fromPath: "/abs/a.md", originalContent: undefined, path: "/abs/b.md", summary: "Move a.md -> b.md" });
    const got = await store.get(id);
    expect(got?.fromPath).toBe("/abs/a.md");
    expect(got?.path).toBe("/abs/b.md");
  });

  it("get() returns undefined for an unknown id", async () => {
    const store = new FileCheckpointStore({ dir });
    expect(await store.get("ckpt_doesnotexist")).toBeUndefined();
  });

  it("list() is newest-first", async () => {
    const store = new FileCheckpointStore({ dir, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const first = await store.record({ action: "write", originalContent: undefined, path: "/abs/1.md", summary: "one" });
    const store2 = new FileCheckpointStore({ dir, now: () => new Date("2026-01-02T00:00:00.000Z") });
    const second = await store2.record({ action: "write", originalContent: undefined, path: "/abs/2.md", summary: "two" });
    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([second, first]);
  });

  it("truncates a snapshot over the per-file cap — manifest-only, no content stored", async () => {
    const store = new FileCheckpointStore({ dir, maxBytesPerSnapshot: 10 });
    const big = "x".repeat(50);
    const id = await store.record({ action: "write", originalContent: big, path: "/abs/big.md", summary: "Overwrite big.md" });
    const listed = await store.list();
    expect(listed[0]).toMatchObject({ existedBefore: true, truncated: true });
    const got = await store.get(id);
    expect(got?.truncated).toBe(true);
    expect(got?.content).toBeUndefined();
  });

  it("cap eviction: drops the oldest checkpoints once retention exceeds the max, never the one just written", async () => {
    // Explicit, strictly-increasing timestamps — a real Date.now() clock can
    // tie at millisecond resolution inside a tight loop, which would make
    // eviction order among ties depend on filesystem readdir order instead
    // of proving anything about the actual cap logic.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const store = new FileCheckpointStore({ dir, maxCheckpoints: 3, now: () => new Date(2026, 0, 1, 0, 0, i) });
      ids.push(await store.record({ action: "write", originalContent: undefined, path: `/abs/${i.toString()}.md`, summary: `write ${i.toString()}` }));
    }
    const listed = await new FileCheckpointStore({ dir }).list();
    expect(listed).toHaveLength(3);
    // The last-written checkpoint always survives its own write.
    expect(listed.map((m) => m.id)).toContain(ids[ids.length - 1]);
    // The earliest ones were evicted.
    expect(listed.map((m) => m.id)).not.toContain(ids[0]);
    expect(listed.map((m) => m.id)).not.toContain(ids[1]);
  });

  it("cap eviction never deletes the checkpoint being written, even when it is the CHRONOLOGICALLY OLDEST (a non-monotonic clock)", async () => {
    // Deterministic regardless of filesystem readdir order: three prior
    // checkpoints get a LATER timestamp than the one written last, so a
    // naive "delete however many sort oldest-first" would unambiguously
    // pick the just-written one FIRST (no tie to get lucky on).
    const later = new FileCheckpointStore({ dir, now: () => new Date("2026-02-01T00:00:00.000Z") });
    await later.record({ action: "write", originalContent: undefined, path: "/abs/a.md", summary: "a" });
    await later.record({ action: "write", originalContent: undefined, path: "/abs/b.md", summary: "b" });
    await later.record({ action: "write", originalContent: undefined, path: "/abs/c.md", summary: "c" });

    const earlier = new FileCheckpointStore({ dir, maxCheckpoints: 3, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const justWrittenId = await earlier.record({ action: "write", originalContent: undefined, path: "/abs/oldest-but-newest.md", summary: "d" });

    const listed = await later.list();
    expect(listed.map((m) => m.id)).toContain(justWrittenId);
    expect(listed).toHaveLength(3);
  });

  it("quarantines a corrupt manifest.json — list() skips it instead of crashing", async () => {
    const store = new FileCheckpointStore({ dir });
    const goodId = await store.record({ action: "write", originalContent: "fine", path: "/abs/good.md", summary: "good" });

    // Hand-craft a checkpoint directory with an unparsable manifest.
    const corruptId = "ckpt_corrupt0001";
    const corruptDir = join(dir, corruptId);
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, "manifest.json"), "{ not valid json", "utf8");

    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([goodId]);

    // The corrupt entry was renamed aside (quarantined), not deleted or left in place.
    const entries = await readdir(dir);
    expect(entries.some((name) => name.startsWith(`${corruptId}.corrupt-`))).toBe(true);
    expect(entries).not.toContain(corruptId);
  });

  it("an unrecognized manifest shape is also quarantined and skipped (not a crash)", async () => {
    const store = new FileCheckpointStore({ dir });
    const goodId = await store.record({ action: "write", originalContent: "fine", path: "/abs/good2.md", summary: "good2" });

    const badId = "ckpt_badshape0001";
    const badDir = join(dir, badId);
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "manifest.json"), JSON.stringify({ id: badId }), "utf8"); // missing required fields

    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([goodId]);
  });
});

describe("manifest version (R3-5)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-checkpoints-version-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("record() writes the CURRENT_CHECKPOINT_VERSION onto every new manifest", async () => {
    const store = new FileCheckpointStore({ dir });
    const id = await store.record({ action: "write", originalContent: "hi", path: "/abs/x.md", summary: "x" });
    const [listed] = await store.list();
    expect(listed?.version).toBe(CURRENT_CHECKPOINT_VERSION);
    const got = await store.get(id);
    expect(got?.version).toBe(CURRENT_CHECKPOINT_VERSION);
  });

  it("a PRE-R3-5 on-disk manifest with no version field is read as version 1 and stays fully restorable (compat)", async () => {
    // Hand-crafted fixture mirroring exactly what a pre-R3-5 build wrote:
    // no `version` key at all.
    const id = "ckpt_prer3s5000001";
    const ckptDir = join(dir, id);
    await mkdir(ckptDir, { recursive: true });
    await writeFile(join(ckptDir, "manifest.json"), JSON.stringify({
      action: "write",
      at: "2026-01-01T00:00:00.000Z",
      bytes: 5,
      existedBefore: true,
      id,
      path: "/abs/legacy.md",
      summary: "legacy write"
    }), "utf8");
    await writeFile(join(ckptDir, "content"), "hello", "utf8");

    const store = new FileCheckpointStore({ dir });
    const [listed] = await store.list();
    expect(listed?.id).toBe(id);
    expect(listed?.version).toBe(1);
    const got = await store.get(id);
    expect(got?.version).toBe(1);
    expect(got?.content?.toString("utf8")).toBe("hello");
  });

  it("a malformed version value (non-integer/string) also defaults to 1, not a crash or quarantine", async () => {
    const id = "ckpt_badversion00001";
    const ckptDir = join(dir, id);
    await mkdir(ckptDir, { recursive: true });
    await writeFile(join(ckptDir, "manifest.json"), JSON.stringify({
      action: "write",
      at: "2026-01-01T00:00:00.000Z",
      bytes: 0,
      existedBefore: false,
      id,
      path: "/abs/weird.md",
      summary: "weird",
      version: "not-a-number"
    }), "utf8");

    const store = new FileCheckpointStore({ dir });
    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([id]);
    expect(listed[0]?.version).toBe(1);
  });

  it("a FUTURE-version manifest is still returned by list()/get() (store stays honest — CLI-level display/restore does the version gating)", async () => {
    const id = "ckpt_future000000001";
    const ckptDir = join(dir, id);
    await mkdir(ckptDir, { recursive: true });
    await writeFile(join(ckptDir, "manifest.json"), JSON.stringify({
      action: "write",
      at: "2026-01-01T00:00:00.000Z",
      bytes: 0,
      existedBefore: false,
      id,
      path: "/abs/future.md",
      summary: "written by a newer Muse",
      version: CURRENT_CHECKPOINT_VERSION + 1
    }), "utf8");

    const store = new FileCheckpointStore({ dir });
    const listed = await store.list();
    expect(listed.map((m) => m.id)).toEqual([id]);
    expect(listed[0]?.version).toBe(CURRENT_CHECKPOINT_VERSION + 1);
    const got = await store.get(id);
    expect(got?.version).toBe(CURRENT_CHECKPOINT_VERSION + 1);
  });
});

describe("createInMemoryCheckpointStore", () => {
  it("round-trips without touching disk", async () => {
    const store = createInMemoryCheckpointStore();
    const id = await store.record({ action: "edit", originalContent: "abc", path: "/x/y.md", summary: "edit y.md" });
    expect((await store.list()).map((m) => m.id)).toEqual([id]);
    expect((await store.get(id))?.content?.toString("utf8")).toBe("abc");
  });

  it("records existedBefore:false for a create", async () => {
    const store = createInMemoryCheckpointStore();
    const id = await store.record({ action: "write", originalContent: undefined, path: "/x/new.md", summary: "create" });
    expect((await store.get(id))?.existedBefore).toBe(false);
  });
});
