import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { parseNotesSearchLimit, resolveIngestNotePath, registerNotesCommands, type NotesCommandHelpers } from "./commands-notes.js";
import type { ProgramIO } from "./program.js";

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

describe("muse notes ingest --local — pull a local file into the notes corpus", () => {
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

  it("writes the file's content as a .md note under the notes root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cli-notes-ingest-"));
    process.env.MUSE_NOTES_DIR = dir;
    const src = join(mkdtempSync(join(tmpdir(), "muse-src-")), "meeting.txt");
    writeFileSync(src, "Q3 planning notes: ship the recap.", "utf8");

    await run(["ingest", "--local", src]);
    expect(existsSync(join(dir, "meeting.md"))).toBe(true);
    expect(readFileSync(join(dir, "meeting.md"), "utf8")).toContain("ship the recap");
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

describe("parseNotesSearchLimit (goal 188)", () => {
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
