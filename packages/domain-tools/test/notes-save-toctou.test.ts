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
});
