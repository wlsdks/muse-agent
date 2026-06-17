import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileGrepTool, createFileListTool, createFileReadTool } from "./fs-read-tools.js";

const ctx = { runId: "test-run" };

describe("file_read / file_list / file_grep", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "muse-fs-read-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const opts = () => ({ baseDir: root, roots: [root] });

  describe("file_read", () => {
    it("reads a text file by path and carries a citeable source", async () => {
      await writeFile(join(root, "todo.md"), "line1\nline2\nline3");
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "todo.md") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(true);
      expect(out["text"]).toBe("line1\nline2\nline3");
      expect(out["source"]).toContain("todo.md");
      expect(out["totalLines"]).toBe(3);
    });

    it("honours offset and limit", async () => {
      await writeFile(join(root, "n.txt"), "a\nb\nc\nd\ne");
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ limit: 2, offset: 2, path: join(root, "n.txt") }, ctx)) as JsonObject;
      expect(out["text"]).toBe("b\nc");
      expect(out["truncated"]).toBe(true);
    });

    it("resolves a NAME fragment within the doc roots to the newest match", async () => {
      await writeFile(join(root, "invoice-old.md"), "old");
      await writeFile(join(root, "invoice-new.md"), "newest invoice body");
      await utimes(join(root, "invoice-old.md"), new Date(1_000_000), new Date(1_000_000));
      await utimes(join(root, "invoice-new.md"), new Date(2_000_000), new Date(2_000_000));
      const tool = createFileReadTool({ ...opts(), docRoots: [root] });
      const out = (await tool.execute({ path: "invoice" }, ctx)) as JsonObject;
      expect(out["read"]).toBe(true);
      expect(String(out["path"])).toContain("invoice-new.md");
    });

    it("an unmatched name lists recent files instead of reading anything", async () => {
      await writeFile(join(root, "groceries.md"), "milk");
      const tool = createFileReadTool({ ...opts(), docRoots: [root] });
      const out = (await tool.execute({ path: "tax-return-2099" }, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
      expect((out["recent"] as string[]).length).toBeGreaterThan(0);
    });

    it("routes a PDF through the injected extractor", async () => {
      await writeFile(join(root, "scan.pdf"), Buffer.from("%PDF-1.5 binary..."));
      const tool = createFileReadTool({ ...opts(), extractPdfText: async () => "EXTRACTED PDF" });
      const out = (await tool.execute({ path: join(root, "scan.pdf") }, ctx)) as JsonObject;
      expect(out).toMatchObject({ kind: "pdf", read: true, text: "EXTRACTED PDF" });
    });

    it("reads an image via the injected vision callback", async () => {
      await writeFile(join(root, "receipt.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
      const tool = createFileReadTool({ ...opts(), describeImage: async () => ({ ok: true, text: "Cafe Muse 12,400 KRW" }) });
      const out = (await tool.execute({ path: join(root, "receipt.png") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(true);
      expect(String(out["text"])).toContain("Cafe Muse");
    });

    it("refuses an image when no vision callback is wired", async () => {
      await writeFile(join(root, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "pic.png") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
    });

    it("refuses a denied path (fail-close) instead of reading it", async () => {
      await mkdir(join(root, ".ssh"), { recursive: true });
      await writeFile(join(root, ".ssh", "id_rsa"), "KEY");
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, ".ssh", "id_rsa") }, ctx)) as JsonObject;
      expect(out["refused"]).toBe(true);
      expect(out["text"]).toBeUndefined();
    });

    it("reports a directory rather than reading it", async () => {
      await mkdir(join(root, "sub"), { recursive: true });
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "sub") }, ctx)) as JsonObject;
      expect(String(out["reason"])).toContain("directory");
    });

    it("requires a path", async () => {
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({}, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
      expect(String(out["reason"])).toContain("path");
    });

    it("default text is raw (no line-number prefixes for clean editing)", async () => {
      await writeFile(join(root, "c.ts"), "a\nb");
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "c.ts") }, ctx)) as JsonObject;
      expect(out["text"]).toBe("a\nb");
    });

    it("numbered:true prefixes line numbers honoring offset", async () => {
      await writeFile(join(root, "c.ts"), "a\nb\nc\nd");
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ numbered: true, offset: 2, path: join(root, "c.ts") }, ctx)) as JsonObject;
      const text = String(out["text"]);
      expect(text.split("\n")[0]).toMatch(/^\s+2\t/u);
      expect(text).toContain("b");
    });
  });

  describe("file_list", () => {
    it("finds files by glob and excludes node_modules", async () => {
      await writeFile(join(root, "a.md"), "1");
      await mkdir(join(root, "notes"), { recursive: true });
      await writeFile(join(root, "notes", "b.md"), "2");
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "c.md"), "3");
      const tool = createFileListTool(opts());
      const out = (await tool.execute({ cwd: root, pattern: "**/*.md" }, ctx)) as JsonObject;
      const paths = out["paths"] as string[];
      expect(paths.some((p) => p.endsWith("a.md"))).toBe(true);
      expect(paths.some((p) => p.endsWith(join("notes", "b.md")))).toBe(true);
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    });

    it("requires a pattern", async () => {
      const tool = createFileListTool(opts());
      const out = (await tool.execute({}, ctx)) as JsonObject;
      expect(out["error"]).toBe("pattern is required");
    });

    it("honors .gitignore by default and can be overridden", async () => {
      await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n");
      await mkdir(join(root, "ignored"), { recursive: true });
      await writeFile(join(root, "ignored", "secret.md"), "x");
      await writeFile(join(root, "app.log"), "x");
      await writeFile(join(root, "keep.md"), "x");
      const tool = createFileListTool(opts());

      const honored = (await tool.execute({ cwd: root, pattern: "**/*" }, ctx)) as JsonObject;
      const honoredPaths = honored["paths"] as string[];
      expect(honoredPaths.some((p) => p.endsWith("keep.md"))).toBe(true);
      expect(honoredPaths.some((p) => p.includes(`ignored${"/"}secret.md`))).toBe(false);
      expect(honoredPaths.some((p) => p.endsWith("app.log"))).toBe(false);

      const all = (await tool.execute({ cwd: root, includeIgnored: true, pattern: "**/*" }, ctx)) as JsonObject;
      const allPaths = all["paths"] as string[];
      expect(allPaths.some((p) => p.endsWith("app.log"))).toBe(true);
    });
  });

  describe("file_grep", () => {
    it("returns matching files in files mode", async () => {
      await writeFile(join(root, "x.md"), "the dentist appointment");
      await writeFile(join(root, "y.md"), "groceries");
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ path: root, pattern: "dentist" }, ctx)) as JsonObject;
      const files = out["files"] as string[];
      expect(files.some((p) => p.endsWith("x.md"))).toBe(true);
      expect(files.some((p) => p.endsWith("y.md"))).toBe(false);
    });

    it("returns matching lines with line numbers in content mode", async () => {
      await writeFile(join(root, "z.md"), "alpha\nbeta dentist\ngamma");
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ mode: "content", path: root, pattern: "dentist" }, ctx)) as JsonObject;
      const matches = out["matches"] as Array<{ line: number; text: string }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]?.line).toBe(2);
      expect(matches[0]?.text).toContain("dentist");
    });

    it("rejects an invalid regular expression", async () => {
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ path: root, pattern: "(" }, ctx)) as JsonObject;
      expect(String(out["error"])).toContain("invalid regular expression");
    });

    it("content mode marks the matched file READ (grounds a grep→edit loop, like file_read's partial view)", async () => {
      await writeFile(join(root, "z.md"), "alpha\nbeta dentist\ngamma");
      const seen: string[] = [];
      const tool = createFileGrepTool({ ...opts(), onPathRead: (p) => seen.push(p) });
      await tool.execute({ mode: "content", path: root, pattern: "dentist" }, ctx);
      expect(seen.some((p) => p.endsWith("z.md"))).toBe(true);
    });

    it("files mode does NOT mark read (no content shown to ground an edit)", async () => {
      await writeFile(join(root, "z.md"), "alpha\nbeta dentist\ngamma");
      const seen: string[] = [];
      const tool = createFileGrepTool({ ...opts(), onPathRead: (p) => seen.push(p) });
      await tool.execute({ mode: "files", path: root, pattern: "dentist" }, ctx);
      expect(seen).toHaveLength(0);
    });

    it("defaults the scope to a configured root when path is omitted (not the home dir)", async () => {
      await writeFile(join(root, "x.md"), "the dentist appointment");
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ pattern: "dentist" }, ctx)) as JsonObject;
      expect(out["refused"]).not.toBe(true);
      const files = out["files"] as string[];
      expect(files.some((p) => p.endsWith("x.md"))).toBe(true);
    });
  });

  describe("file_read onPathRead (read-before-edit grounding)", () => {
    it("reports the resolved canonical path on a successful read", async () => {
      await writeFile(join(root, "todo.md"), "line1\nline2");
      const seen: string[] = [];
      const tool = createFileReadTool({ baseDir: root, roots: [root], onPathRead: (p) => seen.push(p) });
      const out = (await tool.execute({ path: join(root, "todo.md") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(true);
      expect(seen.some((p) => p.endsWith("todo.md"))).toBe(true);
    });

    it("does NOT report a path on a failed read (nothing to ground an edit on)", async () => {
      const seen: string[] = [];
      const tool = createFileReadTool({ baseDir: root, roots: [root], onPathRead: (p) => seen.push(p) });
      const out = (await tool.execute({ path: join(root, "missing.md") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
      expect(seen).toHaveLength(0);
    });
  });
});
