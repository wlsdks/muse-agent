import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNotesMcpServer } from "../src/index.js";

const saveTool = (server: ReturnType<typeof createNotesMcpServer>) => {
  const t = server.tools.find((e) => e.name === "save");
  if (!t) throw new Error("save tool not found");
  return t;
};

describe("muse.notes save — TOCTOU: the wx write refuses to clobber a concurrent create", () => {
  it("does NOT overwrite a file that appeared after the existence probe (overwrite:false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-toctou-"));
    // probeExists returns false — the note was absent when we checked — but a
    // concurrent writer creates it before our write lands (the TOCTOU window).
    const server = createNotesMcpServer({ notesDir: dir, probeExists: async () => false });
    const abs = join(dir, "note.md");
    writeFileSync(abs, "ORIGINAL", "utf8");
    const out = (await saveTool(server).execute({ path: "note.md", content: "CLOBBER", overwrite: false })) as {
      error?: string;
      created?: boolean;
    };
    expect(out.error ?? "").toContain("already exists");
    expect(readFileSync(abs, "utf8")).toBe("ORIGINAL"); // the concurrent create survives, not clobbered
  });

  it("still overwrites intentionally when overwrite:true (wx guards only the no-overwrite path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-toctou-ow-"));
    const server = createNotesMcpServer({ notesDir: dir, probeExists: async () => false });
    const abs = join(dir, "note.md");
    writeFileSync(abs, "ORIGINAL", "utf8");
    const out = (await saveTool(server).execute({ path: "note.md", content: "NEW", overwrite: true })) as { error?: string };
    expect(out.error).toBeUndefined();
    expect(readFileSync(abs, "utf8")).toBe("NEW");
  });

  it("serializes concurrent appends so the byte cap cannot be exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-append-cap-"));
    const server = createNotesMcpServer({ maxFileBytes: 2_000, notesDir: dir });
    const abs = join(dir, "note.md");
    writeFileSync(abs, "x".repeat(1_000), "utf8");
    const append = server.tools.find((entry) => entry.name === "append");
    if (!append) throw new Error("append tool not found");

    const outcomes = await Promise.all([
      append.execute({ content: "a".repeat(700), path: "note.md" }),
      append.execute({ content: "b".repeat(700), path: "note.md" })
    ]);

    expect(outcomes.filter((outcome) => "error" in outcome)).toHaveLength(1);
    expect(readFileSync(abs, "utf8")).toHaveLength(1_700);
  });

  it("uses the default list bound when a configured limit is non-finite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-notes-list-limit-"));
    writeFileSync(join(dir, "one.md"), "one", "utf8");
    writeFileSync(join(dir, "two.md"), "two", "utf8");
    const server = createNotesMcpServer({ maxListEntries: Number.NaN, notesDir: dir });
    const list = server.tools.find((entry) => entry.name === "list");
    if (!list) throw new Error("list tool not found");
    const output = await list.execute({}) as { entries: unknown[] };
    expect(output.entries).toHaveLength(2);
  });
});
