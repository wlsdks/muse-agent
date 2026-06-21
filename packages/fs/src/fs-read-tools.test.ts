import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "@muse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileGrepPattern, createFileGrepTool, createFileListTool, createFileReadTool, fileReadCharBudget, isCatastrophicGrepPattern } from "./fs-read-tools.js";

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

  describe("fileReadCharBudget — a single read must fit the model context", () => {
    it("caps a read to HALF a 32K-token window (~64K chars), well under the 200K default that would overflow it", () => {
      expect(fileReadCharBudget(32768)).toBe(65536); // 16384 tokens × 4 chars
      expect(fileReadCharBudget(32768)).toBeLessThan(200 * 1024); // < DEFAULT_MAX_TEXT_CHARS
      // a larger window gets a larger budget; a tiny one is floored, never zero.
      expect(fileReadCharBudget(131072)).toBe(262144);
      expect(fileReadCharBudget(1024)).toBe(4 * 1024);
    });

    it("is ENFORCED — a file over the budget truncates at it (the model then pages)", async () => {
      const budget = fileReadCharBudget(32768);
      await writeFile(join(root, "huge.txt"), "x".repeat(budget + 4096));
      const tool = createFileReadTool({ ...opts(), maxTextChars: budget });
      const out = (await tool.execute({ path: join(root, "huge.txt") }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(true);
      expect(String(out["text"]).length).toBe(budget);
    });
  });

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

    it("a line-truncated read carries nextOffset so the model can PAGE deterministically", async () => {
      await writeFile(join(root, "n.txt"), Array.from({ length: 20 }, (_, i) => `line ${(i + 1).toString()}`).join("\n"));
      const tool = createFileReadTool(opts());
      // read lines 1-5 of 20 → truncated, continue at line 6
      const head = (await tool.execute({ limit: 5, path: join(root, "n.txt") }, ctx)) as JsonObject;
      expect(head["truncated"]).toBe(true);
      expect(head["nextOffset"]).toBe(6);
      // read lines 6-10 → continue at line 11
      const mid = (await tool.execute({ limit: 5, offset: 6, path: join(root, "n.txt") }, ctx)) as JsonObject;
      expect(mid["nextOffset"]).toBe(11);
      // a COMPLETE read (no more lines) carries NO nextOffset
      const whole = (await tool.execute({ path: join(root, "n.txt") }, ctx)) as JsonObject;
      expect(whole["truncated"]).toBe(false);
      expect(whole["nextOffset"]).toBeUndefined();
    });

    it("a CHAR-capped read TRIMS to a clean line boundary and pages from the next line (no partial line)", async () => {
      // 10 lines of ~50 chars; the first 100 chars hold 1 complete line + part of
      // the 2nd. The page is trimmed to the complete line and nextOffset continues
      // from line 2 — deterministic paging without a trailing partial line.
      await writeFile(join(root, "wide.txt"), Array.from({ length: 10 }, (_, i) => `${(i + 1).toString()}-${"x".repeat(48)}`).join("\n"));
      const tool = createFileReadTool({ ...opts(), maxTextChars: 100 });
      const out = (await tool.execute({ limit: 8, path: join(root, "wide.txt") }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(true);
      expect(out["nextOffset"]).toBe(2);
      expect(String(out["text"]).split("\n")).toHaveLength(1); // only the 1 complete line, no partial
      expect(String(out["text"]).endsWith("x")).toBe(true);
    });

    it("a SINGLE line longer than the cap can't be paged by line — nextOffset stays undefined", async () => {
      await writeFile(join(root, "giant.txt"), "z".repeat(300)); // one 300-char line, no newline
      const tool = createFileReadTool({ ...opts(), maxTextChars: 100 });
      const out = (await tool.execute({ path: join(root, "giant.txt") }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(true);
      expect(out["nextOffset"]).toBeUndefined();
      expect(String(out["text"]).length).toBe(100);
    });

    it("char-cap paging round-trips: every line is eventually read, none skipped", async () => {
      await writeFile(join(root, "doc.txt"), Array.from({ length: 10 }, (_, i) => `line${(i + 1).toString()}-${"y".repeat(20)}`).join("\n"));
      const tool = createFileReadTool({ ...opts(), maxTextChars: 60 });
      const seen: string[] = [];
      let offset = 1;
      for (let guard = 0; guard < 30; guard += 1) {
        const out = (await tool.execute({ offset, path: join(root, "doc.txt") }, ctx)) as JsonObject;
        seen.push(...String(out["text"]).split("\n").filter(Boolean));
        const next = out["nextOffset"];
        if (typeof next !== "number") break;
        expect(next).toBeGreaterThan(offset); // always advances — no infinite loop
        offset = next;
      }
      for (let i = 1; i <= 10; i += 1) {
        expect(seen.some((l) => l.startsWith(`line${i.toString()}-`))).toBe(true);
      }
    });

    it("a COMPLETE read fires onFullRead; a truncated (offset/limit) read does NOT", async () => {
      await writeFile(join(root, "n.txt"), "a\nb\nc\nd\ne");
      const full: string[] = [];
      const fullTool = createFileReadTool({ ...opts(), onFullRead: (p) => full.push(p) });
      await fullTool.execute({ path: join(root, "n.txt") }, ctx);
      expect(full).toHaveLength(1);

      const partial: string[] = [];
      const partialTool = createFileReadTool({ ...opts(), onFullRead: (p) => partial.push(p) });
      await partialTool.execute({ limit: 2, path: join(root, "n.txt") }, ctx);
      expect(partial).toHaveLength(0);

      // An OFFSET-skipped read sees the TAIL only (truncated=false but lines
      // before `offset` unseen) — it is NOT a full read.
      const skipped: string[] = [];
      const skippedTool = createFileReadTool({ ...opts(), onFullRead: (p) => skipped.push(p) });
      const out = (await skippedTool.execute({ offset: 4, path: join(root, "n.txt") }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(false);
      expect(skipped).toHaveLength(0);
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

    it("refuses a text-EXTENSION file that is actually BINARY (a NUL byte) instead of returning corrupted text", async () => {
      // a .txt whose bytes include a NUL — binary disguised as text. file_grep
      // already skips these; file_read must too, or the model gets corrupted,
      // edit-poisoning content back.
      await writeFile(join(root, "fake.txt"), Buffer.from([0x68, 0x69, 0x00, 0x6f]));
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "fake.txt") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
      expect(out["text"]).toBeUndefined();
      expect(String(out["reason"])).toMatch(/binary|NUL/iu);
      // a normal text file with the same extension still reads fine.
      await writeFile(join(root, "real.txt"), "hello\nworld");
      const ok = (await tool.execute({ path: join(root, "real.txt") }, ctx)) as JsonObject;
      expect(ok["read"]).toBe(true);
      expect(ok["text"]).toBe("hello\nworld");
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

    it("a missing DIRECT path yields an actionable recovery hint, not a raw ENOENT errno", async () => {
      const tool = createFileReadTool(opts());
      const out = (await tool.execute({ path: join(root, "nested", "missing.ts") }, ctx)) as JsonObject;
      expect(out["read"]).toBe(false);
      // The small model self-corrects off the message — it must name the recovery
      // tool (file_list) and the file, not leak a raw "ENOENT ... stat '/...'".
      const hint = String(out["reason"] ?? out["error"]);
      expect(hint).toMatch(/file_list/u);
      expect(hint).toContain("missing.ts");
      expect(hint).not.toMatch(/ENOENT|errno|\bstat\b/u);
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

    it("returns a DETERMINISTIC (sorted) order, not the unspecified glob-iteration order", async () => {
      // glob order is filesystem-defined → flaky model input across pass^k. The
      // tool must sort. Fixture chosen so glob's order (top-level files, then
      // subdirs) differs from sorted order (subdirs interleaved alphabetically).
      for (const f of ["zebra.ts", "alpha.ts", "beta.ts"]) await writeFile(join(root, f), "x");
      await mkdir(join(root, "lib"), { recursive: true });
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "lib", "util.ts"), "x");
      await writeFile(join(root, "src", "app.ts"), "x");
      const tool = createFileListTool(opts());
      const out = (await tool.execute({ cwd: root, pattern: "**/*.ts" }, ctx)) as JsonObject;
      const paths = out["paths"] as string[];
      // the returned order is sorted (by full path) — reproducible regardless of
      // the filesystem's glob-iteration order.
      expect(paths).toEqual([...paths].sort());
      expect(paths.length).toBe(5);
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

    it("a missing search PATH yields an actionable hint, not a raw ENOENT errno (sibling of file_read)", async () => {
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ mode: "content", path: join(root, "nope"), pattern: "x" }, ctx)) as JsonObject;
      const hint = String(out["error"] ?? out["reason"]);
      expect(hint).toMatch(/file_list/u);
      expect(hint).not.toMatch(/ENOENT|errno|\bstat\b/u);
    });

    it("degrades a malformed regex to a LITERAL search instead of dead-ending", async () => {
      // A small model routinely emits an invalid regex; a hard error makes it
      // loop and never reach file_edit. "(" is invalid as a regex → searched
      // literally so the file containing a "(" is still found.
      await writeFile(join(root, "code.js"), "fn(a, b);\n");
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ mode: "content", path: root, pattern: "(" }, ctx)) as JsonObject;
      expect(out["error"]).toBeUndefined();
      const matches = out["matches"] as Array<{ text: string }>;
      expect(matches.some((m) => m.text.includes("fn(a, b)"))).toBe(true);
    });

    it("rejects a catastrophic-backtracking (ReDoS) pattern instead of hanging the process", async () => {
      // `(a+)+$` on a failing line never returns in JS's backtracking RegExp.
      // The grep must REFUSE it (clear error) rather than wedge the agent. This
      // test completes instantly BECAUSE of the guard — without it, the search
      // over the file's line would hang the runner.
      await writeFile(join(root, "data.txt"), `${"a".repeat(60)}!`);
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ mode: "content", path: root, pattern: "(a+)+$" }, ctx)) as JsonObject;
      expect(String(out["error"])).toMatch(/catastroph|slow|simplif/iu);
    });

    it.each(["(a+)+$", "(.*)*", "(\\d+)*x", "(\\w+){2,}", "(ab+)*c"])(
      "isCatastrophicGrepPattern flags nested-quantifier ReDoS %s",
      (p) => expect(isCatastrophicGrepPattern(p)).toBe(true)
    );

    it.each([
      "dentist", "src/math\\.mjs", "TODO|FIXME", "\\bfoo\\b", "a{2,5}", "(abc)+", "[a-z]+\\d+",
      // QUANTIFIED-ALTERNATION patterns: a `|` inside a quantified group is NOT
      // catastrophic when the alternatives don't overlap — these are common in
      // code search and MUST stay allowed (the guard against a future over-block
      // that flags `|` blanket-style, which would dead-end the grep→edit loop).
      "(foo|bar)+", "(TODO|FIXME)+", "(a|b)*", "(import|export)\\s+\\w+", "(GET|POST|PUT)\\s", "(error|warn|info)+"
    ])(
      "isCatastrophicGrepPattern allows the safe pattern %s (no false-positive)",
      (p) => expect(isCatastrophicGrepPattern(p)).toBe(false)
    );

    it("content mode marks the matched file READ (grounds a grep→edit loop, like file_read's partial view)", async () => {
      await writeFile(join(root, "z.md"), "alpha\nbeta dentist\ngamma");
      const seen: string[] = [];
      const tool = createFileGrepTool({ ...opts(), onPathRead: (p) => seen.push(p) });
      await tool.execute({ mode: "content", path: root, pattern: "dentist" }, ctx);
      expect(seen.some((p) => p.endsWith("z.md"))).toBe(true);
    });

    it("caps TOTAL content-match output to maxGrepOutputChars (a broad grep can't dominate a small context)", async () => {
      // 50 matching lines of 20 chars each = 1000 chars of match text.
      await writeFile(join(root, "many.txt"), Array.from({ length: 50 }, () => `match${"x".repeat(14)}`).join("\n"));
      const capped = createFileGrepTool({ ...opts(), maxGrepOutputChars: 100 });
      const out = (await capped.execute({ mode: "content", path: root, pattern: "match" }, ctx)) as JsonObject;
      const matches = out["matches"] as unknown[];
      expect(matches.length).toBeLessThan(50); // stopped early on the char budget
      expect(matches.length).toBeLessThanOrEqual(6); // ~100 chars / 20 per match
      expect(out["truncated"]).toBe(true);
      // without the cap, all 50 are returned (the default is large).
      const uncapped = createFileGrepTool(opts());
      const all = (await uncapped.execute({ mode: "content", path: root, pattern: "match" }, ctx)) as JsonObject;
      expect((all["matches"] as unknown[]).length).toBe(50);
    });

    it("a TRUNCATED grep carries an actionable narrowing hint so the 12B can re-run tighter (not page blindly)", async () => {
      await writeFile(join(root, "many.txt"), Array.from({ length: 50 }, () => `match${"x".repeat(14)}`).join("\n"));
      const capped = createFileGrepTool({ ...opts(), maxGrepOutputChars: 100 });
      const out = (await capped.execute({ mode: "content", path: root, pattern: "match" }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(true);
      expect(String(out["hint"])).toContain("narrow the search");
      expect(String(out["hint"])).toContain("glob"); // default glob "**/*" → suggest a glob
    });

    it("a NON-truncated grep carries NO hint (no pollution of a complete result)", async () => {
      await writeFile(join(root, "few.txt"), "one match\ntwo match");
      const tool = createFileGrepTool(opts());
      const out = (await tool.execute({ mode: "content", path: root, pattern: "match" }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(false);
      expect(out["hint"]).toBeUndefined();
    });

    it("the narrowing hint omits the glob suggestion when a glob was already supplied", async () => {
      await writeFile(join(root, "many.txt"), Array.from({ length: 50 }, () => `match${"x".repeat(14)}`).join("\n"));
      const capped = createFileGrepTool({ ...opts(), maxGrepOutputChars: 100 });
      const out = (await capped.execute({ glob: "**/*.txt", mode: "content", path: root, pattern: "match" }, ctx)) as JsonObject;
      expect(out["truncated"]).toBe(true);
      expect(String(out["hint"])).toContain("more specific");
      expect(String(out["hint"])).not.toContain("glob");
    });

    it("content mode marks READ but NOT FULLY-READ — a partial grep cannot ground a whole-file overwrite", async () => {
      await writeFile(join(root, "z.md"), "alpha\nbeta dentist\ngamma");
      const read: string[] = [];
      const full: string[] = [];
      const tool = createFileGrepTool({ ...opts(), onFullRead: (p) => full.push(p), onPathRead: (p) => read.push(p) });
      await tool.execute({ mode: "content", path: root, pattern: "dentist" }, ctx);
      expect(read.some((p) => p.endsWith("z.md"))).toBe(true);
      expect(full).toHaveLength(0);
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

describe("compileGrepPattern — never throws, degrades gracefully", () => {
  it("compiles a valid regex normally", () => {
    expect(compileGrepPattern("foo\\d+").test("foo123")).toBe(true);
  });

  it("tolerates a lone } (fatal under the u flag) by matching it literally", () => {
    // `function multiply.*}` — a lone `}` is 'Lone quantifier brackets' under /u;
    // the non-unicode fallback compiles it and matches the literal brace.
    const re = compileGrepPattern("multiply.*}");
    expect(re.test("function multiply(a, b) { return a + b; }")).toBe(true);
  });

  it("falls back to a LITERAL search for an unsalvageable regex", () => {
    // "(" cannot compile under any flag → escaped to match the literal char.
    const re = compileGrepPattern("(");
    expect(re.test("fn(a)")).toBe(true);
    expect(re.test("no paren here")).toBe(false);
  });

  it("never throws for a pile of metacharacters", () => {
    expect(() => compileGrepPattern("*+?{[(\\")).not.toThrow();
  });
});
