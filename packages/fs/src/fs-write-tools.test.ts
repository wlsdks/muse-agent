import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdit, applyEdits, createFileEditTool, createFileMultiEditTool, createFileWriteTool, type FsWriteApprovalGate } from "./fs-write-tools.js";

const ctx = { runId: "test-run" };
const allow: FsWriteApprovalGate = () => ({ approved: true });
const deny: FsWriteApprovalGate = () => ({ approved: false, reason: "user said no" });

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

  it("applies edits in order, aborting on first failure", () => {
    expect(applyEdits("a b", [{ new_string: "A", old_string: "a" }, { new_string: "B", old_string: "b" }])).toEqual({ content: "A B", ok: true });
    expect(applyEdits("a b", [{ new_string: "A", old_string: "a" }, { new_string: "Z", old_string: "missing" }]).ok).toBe(false);
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

    it("refuses to write through a DANGLING symlink leaf (audit #1 — no write to the escaped target)", async () => {
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

    it("refuses a symlink swapped in during the approval gate (audit #2 — TOCTOU)", async () => {
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

    it("refuses to edit a non-existent file", async () => {
      const tool = createFileEditTool(opts(allow));
      const out = (await tool.execute({ new_string: "b", old_string: "a", path: join(root, "missing.ts") }, ctx)) as JsonObject;
      expect(out["written"]).toBe(false);
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
});
