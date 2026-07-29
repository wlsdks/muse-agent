import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attenuateToolExposureAuthority,
  createToolExposureAuthority,
  PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  resolveToolExposureAuthority
} from "@muse/policy";
import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileCheckpointStore, type CheckpointRecordInput, type CheckpointStore } from "./fs-checkpoints.js";
import { applyEdit, applyEdits, createFileDeleteTool, createFileEditTool, createFileMoveTool, createFileMultiEditTool, createFileWriteTool, type FsWriteApprovalGate } from "./fs-write-tools.js";

const ctx = { runId: "test-run" };
const allow: FsWriteApprovalGate = () => ({ approved: true });
const deny: FsWriteApprovalGate = () => ({ approved: false, reason: "user said no" });

/** Records every `record()` call so a test can assert what got checkpointed (and when). */
function spyCheckpointStore(): { readonly calls: CheckpointRecordInput[]; readonly store: CheckpointStore } {
  const calls: CheckpointRecordInput[] = [];
  return {
    calls,
    store: {
      get: async () => undefined,
      list: async () => [],
      record: async (input) => {
        calls.push(input);
        return "ckpt_test";
      }
    }
  };
}

/** A checkpoint store whose `record()` always fails — the fail-close snapshot case. */
const failingCheckpointStore: CheckpointStore = {
  get: async () => undefined,
  list: async () => [],
  record: async () => { throw new Error("disk full"); }
};

describe("applyEdit / applyEdits (pure, no disk)", () => {
  it("replaces a unique match", () => {
    expect(applyEdit("a b c", { new_string: "B", old_string: "b" })).toEqual({ content: "a B c", ok: true });
  });

  it("refuses an ambiguous match without replace_all", () => {
    const out = applyEdit("x x x", { new_string: "y", old_string: "x" });
    expect(out.ok).toBe(false);
  });

  it("replace_all replaces every occurrence", () => {
    expect(applyEdit("x x x", { new_string: "y", old_string: "x", replace_all: true })).toEqual({ content: "y y y", ok: true });
  });

  it("refuses a missing old_string", () => {
    expect(applyEdit("abc", { new_string: "z", old_string: "q" }).ok).toBe(false);
  });

  it("a gross-miss old_string (no close line) STILL gets the recovery action, not a bare 'not found'", () => {
    // "zzz qqq www" shares no words with any file line → no nearestLineHint.
    const out = applyEdit("alpha beta\ngamma delta\n", { new_string: "x", old_string: "zzz qqq www" });
    expect(out.ok).toBe(false);
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("file_read"); // tells the model HOW to recover
    expect(reason).toContain("byte-for-byte"); // and WHY it missed (exact-match requirement)
  });

  it("a near-miss old_string (shares words) names the closest line to copy", () => {
    const out = applyEdit("const total = sum(a, b);\n", { new_string: "x", old_string: "const total = sum(a,b)" });
    expect(out.ok).toBe(false);
    const reason = (out as { reason: string }).reason;
    expect(reason).toContain("Closest line");
    expect(reason).toContain("copy the exact text");
  });

  it("applies edits in order, aborting on first failure", () => {
    expect(applyEdits("a b", [{ new_string: "A", old_string: "a" }, { new_string: "B", old_string: "b" }])).toEqual({ content: "A B", ok: true });
    expect(applyEdits("a b", [{ new_string: "A", old_string: "a" }, { new_string: "Z", old_string: "missing" }]).ok).toBe(false);
  });

  describe("fuzzy fallback (Codex-style, exact-first)", () => {
    it("prefers an exact match and does NOT mark it fuzzy", () => {
      const out = applyEdit("  const x = 1;\n", { new_string: "  const x = 2;", old_string: "  const x = 1;" });
      expect(out.ok).toBe(true);
      expect((out as { fuzzy?: boolean }).fuzzy).toBeUndefined();
    });

    it("matches a multi-line block despite leading-indentation drift", () => {
      // File is tab-indented; the model recalled the block with 2-space indent —
      // not a contiguous substring, but a line-block match after trimming.
      const file = "if (x) {\n\t\tdoThing();\n\t\tlog();\n}\n";
      const out = applyEdit(file, { new_string: "  doThing();\n  log2();", old_string: "  doThing();\n  log();" });
      expect(out).toMatchObject({ fuzzy: true, ok: true });
      if (out.ok) {
        expect(out.content).toContain("log2();");
        expect(out.content).not.toContain("log();");
      }
    });

    it("matches despite trailing whitespace in the recalled old_string", () => {
      // Pattern has a trailing space the file line lacks → not a substring.
      const out = applyEdit("alpha\nbeta\n", { new_string: "ALPHA", old_string: "alpha   " });
      expect(out).toMatchObject({ fuzzy: true, ok: true });
      if (out.ok) {
        expect(out.content).toBe("ALPHA\nbeta\n");
      }
    });

    it("matches across a typographic-quote difference", () => {
      const file = "const msg = “hello”;\n";
      const out = applyEdit(file, { new_string: 'const msg = "bye";', old_string: 'const msg = "hello";' });
      expect(out).toMatchObject({ fuzzy: true, ok: true });
    });

    it("refuses a fuzzy match that is NOT unique (no guessing)", () => {
      const file = "  return 1;\n  return 1;\n";
      const out = applyEdit(file, { new_string: "return 2;", old_string: "return 1;" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toMatch(/multiple|unique/u);
      }
    });

    it("still refuses a genuinely absent old_string", () => {
      expect(applyEdit("abc\n", { new_string: "z", old_string: "totally missing line" }).ok).toBe(false);
    });

    it("a near-miss old_string (wrong content, not whitespace) gets a nearest-line hint to self-correct", () => {
      // The 12B guessed "return a + b" but the file has "return a - b" — a real
      // content difference fuzzy matching (whitespace-only) won't bridge. The
      // failure names the closest actual line so the model can copy it exactly.
      const file = "export function add(a, b) {\n  return a - b;\n}\n";
      const out = applyEdit(file, { new_string: "return a + b;", old_string: "return a + b" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toContain("return a - b");
      }
    });

    it("an unrelated old_string gets NO nearest-line hint (no noise)", () => {
      const out = applyEdit("export function add(a, b) {\n  return a - b;\n}\n", { new_string: "z", old_string: "xyzzy frobnicate qux" });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).not.toContain("return");
      }
    });

    it("repairs a model that double-escaped newlines as literal \\n in old_string", () => {
      // A small local model often emits "a\\nb" (backslash-n text) instead of a
      // real newline in its tool-call JSON; exact + line-block both miss. The
      // deterministic repair un-escapes and retries — old AND new together.
      const file = "export function add(a, b) {\n  return a - b;\n}\n";
      const out = applyEdit(file, {
        new_string: "export function add(a, b) {\\n  return a + b;\\n}",
        old_string: "export function add(a, b) {\\n  return a - b;\\n}"
      });
      expect(out).toMatchObject({ fuzzy: true, ok: true });
      if (out.ok) {
        expect(out.content).toContain("return a + b;");
        expect(out.content).not.toContain("return a - b;");
        expect(out.content).not.toContain("\\n");
      }
    });

    it("does NOT un-escape when the literal-\\n old_string already matches verbatim", () => {
      // The file genuinely contains a backslash-n (e.g. a regex source) — the
      // exact pass matches first, so the repair never rewrites it.
      const file = 'const re = "\\\\n";\n';
      const out = applyEdit(file, { new_string: 'const re = "\\\\t";', old_string: 'const re = "\\\\n";' });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect((out as { fuzzy?: boolean }).fuzzy).toBeUndefined();
      }
    });
  });
});

describe("file_write / file_edit / file_multi_edit — gated writes", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-write-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const opts = (gate: FsWriteApprovalGate) => ({ approvalGate: gate, baseDir: root, roots: [root] });

  describe("delegated canonical writable scope", () => {
    it("allows only in-scope canonical targets across every file mutation tool", async () => {
      const allowedRoot = join(root, "allowed");
      const outsideRoot = join(root, "outside");
      await mkdir(allowedRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      const authority = createToolExposureAuthority({
        allowedToolNames: ["file_write", "file_edit", "file_multi_edit", "file_delete", "file_move"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        localMode: true,
        writablePaths: [allowedRoot]
      });
      const scopedCtx = { ...ctx, toolExposureAuthority: authority };

      const write = createFileWriteTool(opts(allow));
      const allowedFile = join(allowedRoot, "ok.md");
      expect((await write.execute({ content: "ok", path: allowedFile }, scopedCtx) as JsonObject)["written"]).toBe(true);
      const edit = createFileEditTool(opts(allow));
      expect((await edit.execute({ new_string: "edited", old_string: "ok", path: allowedFile }, scopedCtx) as JsonObject)["written"]).toBe(true);
      const multi = createFileMultiEditTool(opts(allow));
      expect((await multi.execute({
        edits: [{ new_string: "EDITED", old_string: "edited" }],
        path: allowedFile
      }, scopedCtx) as JsonObject)["written"]).toBe(true);
      const move = createFileMoveTool(opts(allow));
      const movedFile = join(allowedRoot, "moved.md");
      expect((await move.execute({ from: allowedFile, to: movedFile }, scopedCtx) as JsonObject)["moved"]).toBe(true);
      const remove = createFileDeleteTool(opts(allow));
      expect((await remove.execute({ path: movedFile }, scopedCtx) as JsonObject)["deleted"]).toBe(true);

      expect((await write.execute({ content: "no", path: join(outsideRoot, "no.md") }, scopedCtx) as JsonObject)).toMatchObject({
        refused: true,
        written: false
      });

      const editTarget = join(outsideRoot, "edit.md");
      await writeFile(editTarget, "old");
      expect((await edit.execute({ new_string: "new", old_string: "old", path: editTarget }, scopedCtx) as JsonObject)["written"]).toBe(false);
      expect(await readFile(editTarget, "utf8")).toBe("old");

      const multiTarget = join(outsideRoot, "multi.md");
      await writeFile(multiTarget, "alpha beta");
      expect((await multi.execute({
        edits: [{ new_string: "A", old_string: "alpha" }, { new_string: "B", old_string: "beta" }],
        path: multiTarget
      }, scopedCtx) as JsonObject)["written"]).toBe(false);
      expect(await readFile(multiTarget, "utf8")).toBe("alpha beta");

      const deleteTarget = join(outsideRoot, "delete.md");
      await writeFile(deleteTarget, "keep");
      expect((await remove.execute({ path: deleteTarget }, scopedCtx) as JsonObject)["deleted"]).toBe(false);
      expect(await readFile(deleteTarget, "utf8")).toBe("keep");

      const moveSource = join(allowedRoot, "move.md");
      await writeFile(moveSource, "stay");
      expect((await move.execute({ from: moveSource, to: join(outsideRoot, "move.md") }, scopedCtx) as JsonObject)["moved"]).toBe(false);
      expect(await readFile(moveSource, "utf8")).toBe("stay");
      const outsideSource = join(outsideRoot, "outside-source.md");
      await writeFile(outsideSource, "also-stay");
      expect((await move.execute({ from: outsideSource, to: join(allowedRoot, "inside-destination.md") }, scopedCtx) as JsonObject)["moved"]).toBe(false);
      expect(await readFile(outsideSource, "utf8")).toBe("also-stay");
    });

    it("denies empty, forged, and expired delegated authority without changing legacy no-authority writes", async () => {
      const target = join(root, "target.md");
      const tool = createFileWriteTool(opts(allow));
      for (const toolExposureAuthority of [
        createToolExposureAuthority({
          allowedToolNames: ["file_write"],
          expiresAt: "2099-01-01T00:00:00.000Z",
          localMode: true,
          writablePaths: []
        }),
        null as never,
        {} as never,
        createToolExposureAuthority({
          allowedToolNames: ["file_write"],
          expiresAt: "2000-01-01T00:00:00.000Z",
          localMode: true,
          writablePaths: [root]
        })
      ]) {
        const out = await tool.execute(
          { content: "blocked", path: target },
          { ...ctx, toolExposureAuthority }
        ) as JsonObject;
        expect(out["written"]).toBe(false);
      }
      expect((await tool.execute({ content: "legacy", path: target }, ctx) as JsonObject)["written"]).toBe(true);
      expect(await readFile(target, "utf8")).toBe("legacy");
    });

    it("fails closed when an opaque absolute scope cannot be canonicalized", async () => {
      const blocker = join(root, "scope-blocker");
      await writeFile(blocker, "not a directory");
      const impossibleRoot = join(blocker, "child");
      const authority = createToolExposureAuthority({
        allowedToolNames: ["file_write"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        localMode: true,
        writablePaths: [impossibleRoot]
      });
      const out = await createFileWriteTool(opts(allow)).execute(
        { content: "blocked", path: join(root, "target.md") },
        { ...ctx, toolExposureAuthority: authority }
      ) as JsonObject;
      expect(out).toMatchObject({ refused: true, written: false });
      expect(String(out["reason"])).toMatch(/canonicalized/u);
    });

    it("denies a direct file tool call outside the opaque tool-name ceiling or under safe-default-only authority", async () => {
      const target = join(root, "direct.md");
      const tool = createFileWriteTool(opts(allow));
      const scopedWithoutWrite = createToolExposureAuthority({
        allowedToolNames: ["file_edit"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        localMode: true,
        writablePaths: [root]
      });
      const safeDefault = attenuateToolExposureAuthority(undefined, ["file_write"], {
        expiresAt: "2099-01-01T00:00:00.000Z",
        writablePaths: [root]
      })!;
      const profileExcluded = createToolExposureAuthority({
        allowedToolNames: ["file_write"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        localMode: true,
        profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID,
        writablePaths: [root]
      });
      for (const toolExposureAuthority of [scopedWithoutWrite, safeDefault, profileExcluded]) {
        const out = await tool.execute(
          { content: "blocked", path: target },
          { ...ctx, toolExposureAuthority }
        ) as JsonObject;
        expect(out).toMatchObject({ refused: true, written: false });
      }
      await expect(readFile(target, "utf8")).rejects.toThrow();
    });

    it("re-checks expiry at concrete execution after the authority was previously current", async () => {
      const target = join(root, "expiry-race.md");
      const authority = createToolExposureAuthority({
        allowedToolNames: ["file_write"],
        expiresAt: "2030-01-01T00:00:00.000Z",
        localMode: true,
        writablePaths: [root]
      });
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(Date.parse("2029-12-31T23:59:59.000Z"));
        expect(resolveToolExposureAuthority(authority)).toBeDefined();
        clock.mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
        const out = await createFileWriteTool(opts(allow)).execute(
          { content: "blocked", path: target },
          { ...ctx, toolExposureAuthority: authority }
        ) as JsonObject;
        expect(out).toMatchObject({ refused: true, written: false });
        await expect(readFile(target, "utf8")).rejects.toThrow();
      } finally {
        clock.mockRestore();
      }
    });

    it.skipIf(process.platform === "win32")("checks the resolved symlink target, not the lexical in-scope path", async () => {
      const allowedRoot = join(root, "allowed");
      const outsideRoot = join(root, "outside");
      await mkdir(allowedRoot, { recursive: true });
      await mkdir(outsideRoot, { recursive: true });
      await symlink(outsideRoot, join(allowedRoot, "link"));
      const authority = createToolExposureAuthority({
        allowedToolNames: ["file_write"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        localMode: true,
        writablePaths: [allowedRoot]
      });
      const tool = createFileWriteTool(opts(allow));
      const out = await tool.execute(
        { content: "blocked", path: join(allowedRoot, "link", "escape.md") },
        { ...ctx, toolExposureAuthority: authority }
      ) as JsonObject;
      expect(out).toMatchObject({ refused: true, written: false });
      await expect(readFile(join(outsideRoot, "escape.md"), "utf8")).rejects.toThrow();
    });
  });

  describe("file_write", () => {
    it("creates a file when the gate approves", async () => {
      const tool = createFileWriteTool(opts(allow));
      const out = (await tool.execute({ content: "hello", path: join(root, "new.md") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(true);
      expect(out["created"]).toBe(true);
      expect(await readFile(join(root, "new.md"), "utf8")).toBe("hello");
    });

    it("writes NOTHING when the gate denies", async () => {
      const tool = createFileWriteTool(opts(deny));
      const out = (await tool.execute({ content: "hello", path: join(root, "denied.md") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      await expect(readFile(join(root, "denied.md"), "utf8")).rejects.toThrow();
    });

    it("writes NOTHING when the gate throws (fail-close)", async () => {
      const tool = createFileWriteTool(opts(() => { throw new Error("no TTY"); }));
      const out = (await tool.execute({ content: "x", path: join(root, "boom.md") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      await expect(readFile(join(root, "boom.md"), "utf8")).rejects.toThrow();
    });

    it("refuses a denied path without writing", async () => {
      const tool = createFileWriteTool(opts(allow));
      const out = (await tool.execute({ content: "KEY", path: join(root, ".ssh", "id_rsa") }, ctx)) as JsonObject;
      expect(out["refused"]).toBe(true);
      expect(out["written"]).toBe(false);
    });

    it("refuses to write through a symlink that escapes the root (no write to the target)", async () => {
      const outside = await mkdtemp(join(tmpdir(), "muse-fs-out-"));
      try {
        await symlink(outside, join(root, "link"));
        const tool = createFileWriteTool(opts(allow));
        const out = (await tool.execute({ content: "PWNED", path: join(root, "link", "loot.txt") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        await expect(readFile(join(outside, "loot.txt"), "utf8")).rejects.toThrow();
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });

    it.skipIf(process.platform === "win32")("refuses to write through a DANGLING symlink leaf (audit #1 — no write to the escaped target)", async () => {
      const outside = await mkdtemp(join(tmpdir(), "muse-fs-out-"));
      try {
        // Leaf is a symlink whose target does NOT exist yet — realpath can't
        // resolve it, so only O_NOFOLLOW at write time catches the escape.
        await symlink(join(outside, "created.txt"), join(root, "dangling.txt"));
        const tool = createFileWriteTool(opts(allow));
        const out = (await tool.execute({ content: "PWNED", path: join(root, "dangling.txt") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        await expect(readFile(join(outside, "created.txt"), "utf8")).rejects.toThrow();
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });

    it.skipIf(process.platform === "win32")("refuses a symlink swapped in during the approval gate (audit #2 — TOCTOU)", async () => {
      const outside = await mkdtemp(join(tmpdir(), "muse-fs-out-"));
      try {
        const racingGate: FsWriteApprovalGate = async () => {
          await symlink(join(outside, "pwned.txt"), join(root, "target.txt"));
          return { approved: true };
        };
        const tool = createFileWriteTool(opts(racingGate));
        const out = (await tool.execute({ content: "PWNED-TOCTOU", path: join(root, "target.txt") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        await expect(readFile(join(outside, "pwned.txt"), "utf8")).rejects.toThrow();
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });

    describe("read-before-OVERWRITE grounding gate (existing file)", () => {
      it("fail-closes an overwrite of an existing file the model has NOT read (no fabrication / data loss)", async () => {
        await writeFile(join(root, "exists.md"), "original");
        const tool = createFileWriteTool({ ...opts(allow), wasPathRead: () => false });
        const out = (await tool.execute({ content: "REPLACED", path: join(root, "exists.md") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        expect(String(out["reason"])).toMatch(/read|ungrounded/iu);
        expect(await readFile(join(root, "exists.md"), "utf8")).toBe("original");
      });

      it("allows the overwrite once the file has been read", async () => {
        await writeFile(join(root, "exists.md"), "original");
        const tool = createFileWriteTool({ ...opts(allow), wasPathRead: () => true });
        const out = (await tool.execute({ content: "REPLACED", path: join(root, "exists.md") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(true);
        expect(await readFile(join(root, "exists.md"), "utf8")).toBe("REPLACED");
      });

      it("allows CREATING a new file without a prior read (nothing to ground)", async () => {
        const tool = createFileWriteTool({ ...opts(allow), wasPathRead: () => false });
        const out = (await tool.execute({ content: "fresh", path: join(root, "brand-new.md") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(true);
        expect(out["created"]).toBe(true);
      });

      it("a PARTIAL grep-read does NOT satisfy an overwrite — needs a FULL read (no silent loss of unmatched lines)", async () => {
        // file_grep records a path as read so the grep->edit loop works, but a
        // whole-file OVERWRITE discards everything the model never saw. When the
        // caller distinguishes full reads (wasPathFullyRead), an existing file
        // that was only grepped (wasPathRead true, wasPathFullyRead false) must
        // still fail-close the overwrite.
        await writeFile(join(root, "exists.md"), "line1\nline2\nline3");
        const tool = createFileWriteTool({ ...opts(allow), wasPathFullyRead: () => false, wasPathRead: () => true });
        const out = (await tool.execute({ content: "REPLACED", path: join(root, "exists.md") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        expect(String(out["reason"])).toMatch(/read|ungrounded|full/iu);
        expect(await readFile(join(root, "exists.md"), "utf8")).toBe("line1\nline2\nline3");
      });

      it("a FULL read (wasPathFullyRead) DOES satisfy the overwrite", async () => {
        await writeFile(join(root, "exists.md"), "original");
        const tool = createFileWriteTool({ ...opts(allow), wasPathFullyRead: () => true, wasPathRead: () => false });
        const out = (await tool.execute({ content: "REPLACED", path: join(root, "exists.md") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(true);
        expect(await readFile(join(root, "exists.md"), "utf8")).toBe("REPLACED");
      });
    });
  });

  describe("file_edit", () => {
    it("applies a unique edit on approval", async () => {
      await writeFile(join(root, "c.ts"), "const PORT = 3000;");
      const tool = createFileEditTool(opts(allow));
      const out = (await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "c.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(true);
      expect(await readFile(join(root, "c.ts"), "utf8")).toBe("const PORT = 8080;");
    });

    it("leaves the file unchanged when the gate denies", async () => {
      await writeFile(join(root, "c.ts"), "original");
      const tool = createFileEditTool(opts(deny));
      const out = (await tool.execute({ new_string: "changed", old_string: "original", path: join(root, "c.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      expect(await readFile(join(root, "c.ts"), "utf8")).toBe("original");
    });

    it("leaves the file unchanged when old_string is not found (no partial write)", async () => {
      await writeFile(join(root, "c.ts"), "original");
      const tool = createFileEditTool(opts(allow));
      const out = (await tool.execute({ new_string: "z", old_string: "nonexistent", path: join(root, "c.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      expect(await readFile(join(root, "c.ts"), "utf8")).toBe("original");
    });

    it("refuses to edit a non-existent file with an actionable hint, not a raw ENOENT errno", async () => {
      const tool = createFileEditTool(opts(allow));
      const out = (await tool.execute({ new_string: "b", old_string: "a", path: join(root, "missing.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      // The 12B self-corrects off the message: it must point at the recovery
      // route (create via file_write) and not leak a raw "ENOENT … stat '/abs'".
      const hint = String(out["reason"]);
      expect(hint).toMatch(/file_write/u);
      expect(hint).toContain("missing.ts");
      expect(hint).not.toMatch(/ENOENT|errno|\bstat\b/u);
    });

    describe("read-before-edit grounding gate (wasPathRead)", () => {
      it("fail-closes an edit to a file that was never read this session", async () => {
        await writeFile(join(root, "c.ts"), "const PORT = 3000;");
        const tool = createFileEditTool({ ...opts(allow), wasPathRead: () => false });
        const out = (await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "c.ts") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(false);
        expect(String(out["reason"])).toMatch(/read|ungrounded/iu);
        expect(await readFile(join(root, "c.ts"), "utf8")).toBe("const PORT = 3000;");
      });

      it("applies the edit once the path is in the read set", async () => {
        await writeFile(join(root, "c.ts"), "const PORT = 3000;");
        const tool = createFileEditTool({ ...opts(allow), wasPathRead: () => true });
        const out = (await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "c.ts") }, ctx)) as JsonObject;
        expect(out["written"]).toBe(true);
        expect(await readFile(join(root, "c.ts"), "utf8")).toBe("const PORT = 8080;");
      });

      it("keys the read check on the resolved canonical path (what file_read records)", async () => {
        await writeFile(join(root, "c.ts"), "const PORT = 3000;");
        const seen: string[] = [];
        const tool = createFileEditTool({ ...opts(allow), wasPathRead: (p) => { seen.push(p); return true; } });
        await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "c.ts") }, ctx);
        expect(seen.some((p) => p.endsWith("c.ts"))).toBe(true);
      });
    });
  });

  describe("file_multi_edit", () => {
    it("applies all edits atomically on approval", async () => {
      await writeFile(join(root, "f.ts"), "alpha beta gamma");
      const tool = createFileMultiEditTool(opts(allow));
      const out = (await tool.execute({
        edits: [{ new_string: "A", old_string: "alpha" }, { new_string: "G", old_string: "gamma" }],
        path: join(root, "f.ts")
      }, ctx)) as JsonObject;
      expect(out["written"]).toBe(true);
      expect(await readFile(join(root, "f.ts"), "utf8")).toBe("A beta G");
    });

    it("writes NOTHING if any edit fails (atomic)", async () => {
      await writeFile(join(root, "f.ts"), "alpha beta");
      const tool = createFileMultiEditTool(opts(allow));
      const out = (await tool.execute({
        edits: [{ new_string: "A", old_string: "alpha" }, { new_string: "Z", old_string: "missing" }],
        path: join(root, "f.ts")
      }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      expect(await readFile(join(root, "f.ts"), "utf8")).toBe("alpha beta");
    });
  });

  describe("file_delete", () => {
    it("deletes a file on approval", async () => {
      await writeFile(join(root, "old.md"), "x");
      const tool = createFileDeleteTool(opts(allow));
      const out = (await tool.execute({ path: join(root, "old.md") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(true);
      await expect(readFile(join(root, "old.md"), "utf8")).rejects.toThrow();
    });

    it("keeps the file when the gate denies", async () => {
      await writeFile(join(root, "keep.md"), "x");
      const tool = createFileDeleteTool(opts(deny));
      const out = (await tool.execute({ path: join(root, "keep.md") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(false);
      expect(await readFile(join(root, "keep.md"), "utf8")).toBe("x");
    });

    it("refuses a directory", async () => {
      await mkdir(join(root, "dir"), { recursive: true });
      const tool = createFileDeleteTool(opts(allow));
      const out = (await tool.execute({ path: join(root, "dir") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(false);
      expect(String(out["reason"])).toContain("directory");
    });

    it("refuses a protected path", async () => {
      const tool = createFileDeleteTool(opts(allow));
      const out = (await tool.execute({ path: join(root, ".ssh", "id_rsa") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(false);
      expect(out["refused"]).toBe(true);
    });
  });

  describe("file_move", () => {
    it("renames a file on approval", async () => {
      await writeFile(join(root, "a.md"), "body");
      const tool = createFileMoveTool(opts(allow));
      const out = (await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx)) as JsonObject;
      expect(out["moved"]).toBe(true);
      expect(await readFile(join(root, "b.md"), "utf8")).toBe("body");
      await expect(readFile(join(root, "a.md"), "utf8")).rejects.toThrow();
    });

    it("does not move when the gate denies", async () => {
      await writeFile(join(root, "a.md"), "body");
      const tool = createFileMoveTool(opts(deny));
      const out = (await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx)) as JsonObject;
      expect(out["moved"]).toBe(false);
      expect(await readFile(join(root, "a.md"), "utf8")).toBe("body");
    });

    it("refuses to overwrite an existing destination", async () => {
      await writeFile(join(root, "a.md"), "A");
      await writeFile(join(root, "b.md"), "B");
      const tool = createFileMoveTool(opts(allow));
      const out = (await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx)) as JsonObject;
      expect(out["moved"]).toBe(false);
      expect(await readFile(join(root, "b.md"), "utf8")).toBe("B");
    });

    it("refuses a destination outside the sandbox", async () => {
      await writeFile(join(root, "a.md"), "A");
      const outside = await mkdtemp(join(tmpdir(), "muse-fs-out-"));
      try {
        const tool = createFileMoveTool(opts(allow));
        const out = (await tool.execute({ from: join(root, "a.md"), to: join(outside, "a.md") }, ctx)) as JsonObject;
        expect(out["moved"]).toBe(false);
        expect(await readFile(join(root, "a.md"), "utf8")).toBe("A");
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  });
});

describe("checkpoint wiring (undo substrate)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-checkpoints-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  describe("file_write", () => {
    it("records a checkpoint (existedBefore:false) BEFORE creating a brand-new file", async () => {
      const spy = spyCheckpointStore();
      const tool = createFileWriteTool({ approvalGate: allow, baseDir: root, checkpointStore: spy.store, roots: [root] });
      const out = (await tool.execute({ content: "hello", path: join(root, "new.md") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(true);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toMatchObject({ action: "write" });
      expect(spy.calls[0]?.originalContent).toBeUndefined();
    });

    it("records the CURRENT content BEFORE overwriting an existing file", async () => {
      await writeFile(join(root, "exists.md"), "original");
      const spy = spyCheckpointStore();
      const tool = createFileWriteTool({ approvalGate: allow, baseDir: root, checkpointStore: spy.store, roots: [root], wasPathRead: () => true });
      await tool.execute({ content: "REPLACED", path: join(root, "exists.md") }, ctx);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]?.originalContent).toBeInstanceOf(Buffer);
      expect((spy.calls[0]?.originalContent as Buffer).toString("utf8")).toBe("original");
    });

    it("records NO checkpoint when the gate denies", async () => {
      const spy = spyCheckpointStore();
      const tool = createFileWriteTool({ approvalGate: deny, baseDir: root, checkpointStore: spy.store, roots: [root] });
      await tool.execute({ content: "x", path: join(root, "denied.md") }, ctx);
      expect(spy.calls).toHaveLength(0);
    });

    it("a snapshot failure fails the write closed (file unchanged, checkpoint store still tried)", async () => {
      const tool = createFileWriteTool({ approvalGate: allow, baseDir: root, checkpointStore: failingCheckpointStore, roots: [root] });
      const out = (await tool.execute({ content: "PWNED", path: join(root, "new.md") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      expect(String(out["reason"])).toMatch(/checkpoint|snapshot/iu);
      await expect(readFile(join(root, "new.md"), "utf8")).rejects.toThrow();
    });
  });

  describe("file_edit", () => {
    it("records the pre-edit content on approval", async () => {
      await writeFile(join(root, "c.ts"), "const PORT = 3000;");
      const spy = spyCheckpointStore();
      const tool = createFileEditTool({ approvalGate: allow, baseDir: root, checkpointStore: spy.store, roots: [root] });
      await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "c.ts") }, ctx);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toMatchObject({ action: "edit" });
      expect(spy.calls[0]?.originalContent).toBeInstanceOf(Buffer);
      expect((spy.calls[0]?.originalContent as Buffer).toString("utf8")).toBe("const PORT = 3000;");
    });

    it("an invalid-UTF-8 file's pre-edit snapshot round-trips byte-for-byte through a REAL FileCheckpointStore (AC1 regression)", async () => {
      const checkpointDir = await mkdtemp(join(tmpdir(), "muse-fs-checkpoint-store-"));
      // 0xC3 with no valid UTF-8 continuation byte, followed by a plain-ASCII
      // target the edit engine can still text-match against — proves the
      // SNAPSHOT survives byte-exact even though the edit's own decode-to-
      // string step is inherently best-effort on non-UTF-8 content.
      const fileBytes = Buffer.concat([Buffer.from([0xc3, 0x28]), Buffer.from("const PORT = 3000;", "utf8")]);
      await writeFile(join(root, "invalid.ts"), fileBytes);

      const store = new FileCheckpointStore({ dir: checkpointDir });
      const tool = createFileEditTool({ approvalGate: allow, baseDir: root, checkpointStore: store, roots: [root] });
      const out = (await tool.execute({ new_string: "const PORT = 8080;", old_string: "const PORT = 3000;", path: join(root, "invalid.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(true);

      const [manifest] = await store.list();
      expect(manifest).toBeDefined();
      const record = await store.get(manifest!.id);
      expect(record?.content).toBeInstanceOf(Buffer);
      expect(Buffer.compare(record!.content as Buffer, fileBytes)).toBe(0);
    });

    it("records NO checkpoint when the gate denies", async () => {
      await writeFile(join(root, "c.ts"), "original");
      const spy = spyCheckpointStore();
      const tool = createFileEditTool({ approvalGate: deny, baseDir: root, checkpointStore: spy.store, roots: [root] });
      await tool.execute({ new_string: "changed", old_string: "original", path: join(root, "c.ts") }, ctx);
      expect(spy.calls).toHaveLength(0);
    });

    it("a snapshot failure fails the edit closed (file byte-identical)", async () => {
      await writeFile(join(root, "c.ts"), "original");
      const tool = createFileEditTool({ approvalGate: allow, baseDir: root, checkpointStore: failingCheckpointStore, roots: [root] });
      const out = (await tool.execute({ new_string: "changed", old_string: "original", path: join(root, "c.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
      expect(await readFile(join(root, "c.ts"), "utf8")).toBe("original");
    });
  });

  describe("file_delete", () => {
    it("records the deleted file's content on approval", async () => {
      await writeFile(join(root, "old.md"), "gone soon");
      const spy = spyCheckpointStore();
      const tool = createFileDeleteTool({ approvalGate: allow, baseDir: root, checkpointStore: spy.store, roots: [root] });
      const out = (await tool.execute({ path: join(root, "old.md") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(true);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toMatchObject({ action: "delete" });
      expect(spy.calls[0]?.originalContent).toBeInstanceOf(Buffer);
      expect((spy.calls[0]?.originalContent as Buffer).toString("utf8")).toBe("gone soon");
    });

    it("records NO checkpoint when the gate denies", async () => {
      await writeFile(join(root, "keep.md"), "x");
      const spy = spyCheckpointStore();
      const tool = createFileDeleteTool({ approvalGate: deny, baseDir: root, checkpointStore: spy.store, roots: [root] });
      await tool.execute({ path: join(root, "keep.md") }, ctx);
      expect(spy.calls).toHaveLength(0);
    });

    it("a snapshot failure fails the delete closed (file still present)", async () => {
      await writeFile(join(root, "old.md"), "x");
      const tool = createFileDeleteTool({ approvalGate: allow, baseDir: root, checkpointStore: failingCheckpointStore, roots: [root] });
      const out = (await tool.execute({ path: join(root, "old.md") }, ctx)) as JsonObject;
      expect(out["deleted"]).toBe(false);
      expect(await readFile(join(root, "old.md"), "utf8")).toBe("x");
    });
  });

  describe("file_move", () => {
    it("records a move checkpoint with fromPath, no content needed (destination never existed)", async () => {
      await writeFile(join(root, "a.md"), "body");
      const spy = spyCheckpointStore();
      const tool = createFileMoveTool({ approvalGate: allow, baseDir: root, checkpointStore: spy.store, roots: [root] });
      const out = (await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx)) as JsonObject;
      expect(out["moved"]).toBe(true);
      expect(spy.calls).toHaveLength(1);
      // Compare against the RESOLVED from/to the tool itself returns — `root`
      // may still contain a symlink component (e.g. macOS /var -> /private/var)
      // that resolveSafePath's realpath canonicalizes away.
      expect(spy.calls[0]).toMatchObject({ action: "move", fromPath: out["from"], path: out["to"] });
      expect(spy.calls[0]?.originalContent).toBeUndefined();
    });

    it("records NO checkpoint when the gate denies", async () => {
      await writeFile(join(root, "a.md"), "body");
      const spy = spyCheckpointStore();
      const tool = createFileMoveTool({ approvalGate: deny, baseDir: root, checkpointStore: spy.store, roots: [root] });
      await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx);
      expect(spy.calls).toHaveLength(0);
    });

    it("a snapshot failure fails the move closed (source stays put)", async () => {
      await writeFile(join(root, "a.md"), "body");
      const tool = createFileMoveTool({ approvalGate: allow, baseDir: root, checkpointStore: failingCheckpointStore, roots: [root] });
      const out = (await tool.execute({ from: join(root, "a.md"), to: join(root, "b.md") }, ctx)) as JsonObject;
      expect(out["moved"]).toBe(false);
      expect(await readFile(join(root, "a.md"), "utf8")).toBe("body");
      await expect(readFile(join(root, "b.md"), "utf8")).rejects.toThrow();
    });
  });

  it("without an injected checkpointStore, writes still succeed via the ephemeral in-memory default", async () => {
    const tool = createFileWriteTool({ approvalGate: allow, baseDir: root, roots: [root] });
    const out = (await tool.execute({ content: "no store injected", path: join(root, "fallback.md") }, ctx)) as JsonObject;
    expect(out["written"]).toBe(true);
    expect(await readFile(join(root, "fallback.md"), "utf8")).toBe("no store injected");
  });
});
