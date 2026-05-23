import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createNotesMcpServer, LocalDirNotesProvider } from "../src/index.js";

function notesDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-notes-del-"));
}

function tool(server: ReturnType<typeof createNotesMcpServer>, name: string) {
  const t = server.tools.find((entry) => entry.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("muse.notes delete tool — remove a note so it stops surfacing", () => {
  it("deletes an existing note (gone from read + list afterwards)", async () => {
    const dir = notesDir();
    const server = createNotesMcpServer({ notesDir: dir });
    await tool(server, "save").execute({ content: "stale draft", path: "old.md" });
    expect(await tool(server, "read").execute({ path: "old.md" })).toMatchObject({ content: "stale draft" });

    const del = await tool(server, "delete").execute({ path: "old.md" });
    expect(del).toMatchObject({ deleted: true, path: "old.md" });

    const read = await tool(server, "read").execute({ path: "old.md" }) as { error?: string; content?: string };
    expect(read.content).toBeUndefined();
    const list = await tool(server, "list").execute({}) as { entries?: { name: string }[] };
    expect((list.entries ?? []).some((e) => e.name === "old.md")).toBe(false);
  });

  it("reports deleted:false for a missing note (not an error)", async () => {
    const server = createNotesMcpServer({ notesDir: notesDir() });
    expect(await tool(server, "delete").execute({ path: "nope.md" })).toMatchObject({ deleted: false });
  });

  it("rejects a path-traversal attempt and a missing path", async () => {
    const server = createNotesMcpServer({ notesDir: notesDir() });
    expect((await tool(server, "delete").execute({ path: "../escape.md" }) as { error?: string }).error).toBeDefined();
    expect((await tool(server, "delete").execute({}) as { error?: string }).error).toBe("path is required");
  });
});

describe("LocalDirNotesProvider.delete — provider-contract deletion", () => {
  it("deletes a saved note and returns true, false when absent", async () => {
    const provider = new LocalDirNotesProvider({ notesDir: notesDir() });
    await provider.save({ body: "x", id: "n.md", title: "n" });
    expect(await provider.delete!("n.md")).toBe(true);
    expect(await provider.read("n.md")).toBeUndefined();
    expect(await provider.delete!("n.md")).toBe(false);
  });
});
