import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { fixBrokenLinks, formatBrokenBacklinkWarning, notesLinkingTo, parseNotesSearchLimit, renameNoteWithLinkRewrite, resolveIngestNotePath, resolveUrlNotePath, registerNotesCommands, type NotesCommandHelpers } from "./commands-notes.js";
import type { ProgramIO } from "./program.js";

describe("fixBrokenLinks", () => {
  const seedCorpus = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "muse-fixlinks-"));
    writeFileSync(join(dir, "concepts.md"), "# Concepts");
    writeFileSync(join(dir, "journal.md"), "See [[concpets]] for the idea, and [[totallymissing]] too.");
    return dir;
  };

  it("snaps a broken typo'd link to its unique closest note, leaving a genuinely-missing one alone", async () => {
    const dir = seedCorpus();
    const res = await fixBrokenLinks(dir);
    expect(res.linksRewritten).toBe(1);
    expect(res.fixes).toEqual([{ distance: 2, from: "concpets", to: "concepts" }]);
    expect(res.unresolved).toEqual(["totallymissing"]);
    expect(readFileSync(join(dir, "journal.md"), "utf8")).toBe("See [[concepts]] for the idea, and [[totallymissing]] too.");
  });

  it("--dry-run plans the fix without editing any note", async () => {
    const dir = seedCorpus();
    const res = await fixBrokenLinks(dir, true);
    expect(res).toMatchObject({ dryRun: true, linksRewritten: 1 });
    expect(readFileSync(join(dir, "journal.md"), "utf8")).toContain("[[concpets]]"); // unchanged
  });

  it("reports nothing to fix when all links resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-fixlinks-ok-"));
    writeFileSync(join(dir, "a.md"), "# A");
    writeFileSync(join(dir, "b.md"), "Links to [[a]].");
    const res = await fixBrokenLinks(dir);
    expect(res.fixes).toEqual([]);
    expect(res.unresolved).toEqual([]);
  });
});

describe("renameNoteWithLinkRewrite", () => {
  const seedCorpus = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-rename-"));
    writeFileSync(join(dir, "ideas.md"), "# Ideas\nseed thoughts");
    writeFileSync(join(dir, "journal.md"), "Today I expanded [[ideas]] and [[ideas|my ideas]].");
    writeFileSync(join(dir, "todo.md"), "Unrelated: [[tasks]].");
    return dir;
  };

  it("renames the file and rewrites every [[link]] to it across the corpus", async () => {
    const dir = seedCorpus();
    const res = await renameNoteWithLinkRewrite(dir, "ideas.md", "concepts.md");
    expect(res.ok).toBe(true);
    expect(res.linksRewritten).toBe(2);
    expect(res.notesTouched).toBe(1);
    expect(existsSync(join(dir, "concepts.md"))).toBe(true);
    expect(existsSync(join(dir, "ideas.md"))).toBe(false); // moved, not copied
    expect(readFileSync(join(dir, "journal.md"), "utf8")).toBe("Today I expanded [[concepts]] and [[concepts|my ideas]].");
    expect(readFileSync(join(dir, "todo.md"), "utf8")).toContain("[[tasks]]"); // untouched
  });

  it("--dry-run counts the links without moving the file or editing any note", async () => {
    const dir = seedCorpus();
    const res = await renameNoteWithLinkRewrite(dir, "ideas.md", "concepts.md", true);
    expect(res).toMatchObject({ dryRun: true, linksRewritten: 2, ok: true });
    expect(existsSync(join(dir, "ideas.md"))).toBe(true); // NOT moved
    expect(readFileSync(join(dir, "journal.md"), "utf8")).toContain("[[ideas]]"); // NOT rewritten
  });

  it("refuses a missing source or an existing destination (no clobber)", async () => {
    const dir = seedCorpus();
    expect((await renameNoteWithLinkRewrite(dir, "nope.md", "x.md")).error).toMatch(/no note at/u);
    writeFileSync(join(dir, "concepts.md"), "exists");
    expect((await renameNoteWithLinkRewrite(dir, "ideas.md", "concepts.md")).error).toMatch(/already exists/u);
    expect(existsSync(join(dir, "ideas.md"))).toBe(true); // refusal left everything intact
  });
});

describe("resolveIngestNotePath", () => {
  it("derives a .md note name from the file basename", () => {
    expect(resolveIngestNotePath("/tmp/reports/q3.txt")).toBe("q3.md");
    expect(resolveIngestNotePath("/a/b/notes.md")).toBe("notes.md");
    expect(resolveIngestNotePath("/a/README")).toBe("README.md");
  });
  it("honours an explicit --path override", () => {
    expect(resolveIngestNotePath("/tmp/q3.txt", "archive/q3-2026.md")).toBe("archive/q3-2026.md");
    expect(resolveIngestNotePath("/tmp/q3.txt", "   ")).toBe("q3.md");
  });
});

describe("resolveUrlNotePath", () => {
  it("slugs the host + path into a .md name, dropping www", () => {
    expect(resolveUrlNotePath("https://www.example.com/blog/post")).toBe("example.com-blog-post.md");
    expect(resolveUrlNotePath("https://news.site.org/")).toBe("news.site.org.md");
  });
  it("honours an explicit --path override", () => {
    expect(resolveUrlNotePath("https://x.test/y", "reading/x.md")).toBe("reading/x.md");
  });
});

describe("muse notes ingest --local — pull a local file into the notes corpus", () => {
  const prev = process.env.MUSE_NOTES_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_NOTES_DIR;
    else process.env.MUSE_NOTES_DIR = prev;
  });

  async function run(args: string[], fetchImpl?: typeof globalThis.fetch): Promise<string> {
    const out: string[] = [];
    const io: ProgramIO = { stderr: (m: string) => out.push(m), stdout: (m: string) => out.push(m) };
    const helpers: NotesCommandHelpers = {
      apiRequest: async () => { throw new Error("apiRequest must not be called in --local mode"); },
      ...(fetchImpl ? { fetchImpl } : {}),
      writeOutput: (wio, value) => wio.stdout(`${JSON.stringify(value)}\n`)
    };
    const program = new Command();
    program.exitOverride();
    registerNotesCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "notes", ...args]);
    return out.join("");
  }

  it("writes the file's content as a .md note under the notes root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-notes-ingest-"));
    process.env.MUSE_NOTES_DIR = dir;
    const src = join(mkdtempSync(join(tmpdir(), "muse-src-")), "meeting.txt");
    writeFileSync(src, "Q3 planning notes: ship the recap.", "utf8");

    await run(["ingest", "--local", src]);
    expect(existsSync(join(dir, "meeting.md"))).toBe(true);
    expect(readFileSync(join(dir, "meeting.md"), "utf8")).toContain("ship the recap");
  });

  it("rejects --url before fetch, local note save, or provenance write under local-only", async () => {
    const fetchCalls: string[] = [];
    const notesDir = mkdtempSync(join(tmpdir(), "muse-cli-notes-local-only-"));
    const stderr: string[] = [];
    process.env.MUSE_NOTES_DIR = notesDir;
    process.env.MUSE_LOCAL_ONLY = "true";
    const fetchImpl = (async (input) => {
      fetchCalls.push(String(input));
      return new Response("<title>Must not persist</title><p>body</p>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof globalThis.fetch;
    try {
      const io: ProgramIO = { stderr: (message) => { stderr.push(message); }, stdout: () => undefined };
      const helpers: NotesCommandHelpers = {
        apiRequest: async () => { throw new Error("API must not run"); },
        fetchImpl,
        writeOutput: () => undefined
      };
      const program = new Command();
      registerNotesCommands(program, io, helpers);
      await program.parseAsync(["node", "muse", "notes", "ingest", "--local", "--url", "https://example.test/report"]);
    } finally {
      delete process.env.MUSE_LOCAL_ONLY;
    }
    expect(stderr.join("")).toBe("muse notes ingest: interactive public-web access is blocked by local-only.\n");
    expect(fetchCalls).toEqual([]);
    expect(existsSync(join(notesDir, "example.test-report.md"))).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  it("does not save a local note when a public URL redirects to a private target", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "muse-cli-notes-redirect-"));
    const requests: string[] = [];
    process.env.MUSE_NOTES_DIR = notesDir;
    const fetchImpl = (async (input) => {
      requests.push(String(input));
      return new Response("redirect body must stay unread", { status: 302, headers: { location: "http://127.0.0.1/private" } });
    }) as typeof globalThis.fetch;
    await expect(run(["ingest", "--local", "--url", "https://93.184.216.34/start"], fetchImpl)).rejects.toThrow(/Could not ingest.*redirected to a blocked host/u);
    expect(requests).toEqual(["https://93.184.216.34/start"]);
    expect(existsSync(join(notesDir, "93.184.216.34-start.md"))).toBe(false);
  });
});

describe("muse notes delete --local — prune a note from the local store", () => {
  const prev = process.env.MUSE_NOTES_DIR;
  afterEach(() => {
    if (prev === undefined) delete process.env.MUSE_NOTES_DIR;
    else process.env.MUSE_NOTES_DIR = prev;
  });

  async function run(args: string[]): Promise<string> {
    const out: string[] = [];
    const io: ProgramIO = { stderr: (m: string) => out.push(m), stdout: (m: string) => out.push(m) };
    const helpers: NotesCommandHelpers = {
      apiRequest: async () => { throw new Error("apiRequest must not be called in --local mode"); },
      writeOutput: (wio, value) => wio.stdout(`${JSON.stringify(value)}\n`)
    };
    const program = new Command();
    program.exitOverride();
    registerNotesCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "notes", ...args]);
    return out.join("");
  }

  it("removes the file and confirms; a second delete reports not found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-notes-del-"));
    process.env.MUSE_NOTES_DIR = dir;
    writeFileSync(join(dir, "stale.md"), "old", "utf8");

    const first = await run(["delete", "--local", "stale.md"]);
    expect(first).toContain("Deleted stale.md");
    expect(existsSync(join(dir, "stale.md"))).toBe(false);

    const second = await run(["delete", "--local", "stale.md"]);
    expect(second).toContain("No note found at stale.md");
  });
});

describe("parseNotesSearchLimit", () => {
  it("returns undefined when absent or blank (server/tool default)", () => {
    expect(parseNotesSearchLimit(undefined)).toBeUndefined();
    expect(parseNotesSearchLimit("")).toBeUndefined();
    expect(parseNotesSearchLimit("   ")).toBeUndefined();
  });

  it("accepts a genuine positive number, truncating", () => {
    expect(parseNotesSearchLimit("10")).toBe(10);
    expect(parseNotesSearchLimit(" 5 ")).toBe(5);
    expect(parseNotesSearchLimit("3.9")).toBe(3);
  });

  it("rejects a unit slip / non-numeric instead of silently dropping it", () => {
    expect(() => parseNotesSearchLimit("20x")).toThrow(/--limit must be a positive number \(got '20x'\)/u);
    expect(() => parseNotesSearchLimit("abc")).toThrow(/positive number/u);
  });

  it("rejects 0 / negative instead of passing them through to the tool", () => {
    expect(() => parseNotesSearchLimit("0")).toThrow(/positive number/u);
    expect(() => parseNotesSearchLimit("-3")).toThrow(/positive number/u);
  });
});

describe("notesLinkingTo + formatBrokenBacklinkWarning — warn before a delete breaks backlinks", () => {
  it("returns the notes whose [[wiki-links]] point at the target (the ones a delete would break)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-delete-backlinks-"));
    writeFileSync(join(dir, "health.md"), "# Health\nsee [[nutrition]] for details");
    writeFileSync(join(dir, "running.md"), "Cardio supports [[nutrition]] and recovery");
    writeFileSync(join(dir, "nutrition.md"), "# Nutrition\nprotein targets");
    writeFileSync(join(dir, "unrelated.md"), "# Unrelated\nno links here");
    expect([...(await notesLinkingTo(dir, "nutrition.md"))].sort()).toEqual(["health", "running"]);
  });

  it("returns [] for a note nothing links to (no spurious warning)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-delete-nobacklinks-"));
    writeFileSync(join(dir, "lonely.md"), "# Lonely\nno one links here");
    writeFileSync(join(dir, "other.md"), "# Other note");
    expect(await notesLinkingTo(dir, "lonely.md")).toEqual([]);
  });

  it("formatBrokenBacklinkWarning: count + names + the fix command, empty when none", () => {
    expect(formatBrokenBacklinkWarning([])).toBe("");
    const w = formatBrokenBacklinkWarning(["health", "running"]);
    expect(w).toContain("2 note(s)");
    expect(w).toContain("health");
    expect(w).toContain("running");
    expect(w).toContain("muse notes fix-links");
  });
})
