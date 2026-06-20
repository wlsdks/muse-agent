import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyEdit, applyEdits, createFileDeleteTool, createFileEditTool, createFileMoveTool, createFileMultiEditTool, createFileWriteTool, type FsWriteApprovalGate } from "./fs-write-tools.js";

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
