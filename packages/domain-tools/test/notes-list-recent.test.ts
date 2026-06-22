import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNotesMcpServer } from "../src/index.js";

interface ListResult {
  readonly entries: Array<{ name: string; modifiedAtIso?: string; isDirectory: boolean }>;
}

describe("muse.notes list — sort: 'recent' (my latest notes)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-notes-recent-"));
    // Write three notes and stamp distinct modification times.
    for (const [name, day] of [["old.md", 20], ["new.md", 24], ["mid.md", 22]] as const) {
      const path = join(dir, name);
      await writeFile(path, `# ${name}\n`, "utf8");
      const t = new Date(2026, 4, day, 9, 0);
      await utimes(path, t, t);
    }
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const listTool = () => createNotesMcpServer({ notesDir: dir }).tools.find((t) => t.name === "list")!;

  it("sort:'recent' orders the notes newest-modified first", async () => {
    const out = await listTool().execute({ sort: "recent" }) as ListResult;
    expect(out.entries.map((e) => e.name)).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("every entry carries a modifiedAtIso timestamp", async () => {
    const out = await listTool().execute({ sort: "recent" }) as ListResult;
    expect(out.entries[0]!.modifiedAtIso).toBe(new Date(2026, 4, 24, 9, 0).toISOString());
    expect(out.entries.every((e) => typeof e.modifiedAtIso === "string")).toBe(true);
  });

  it("without sort, all notes are still listed (default directory order)", async () => {
    const out = await listTool().execute({}) as ListResult;
    expect(out.entries.map((e) => e.name).sort()).toEqual(["mid.md", "new.md", "old.md"]);
  });
});
