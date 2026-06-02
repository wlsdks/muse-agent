import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatCorpusOverview, listNoteFiles } from "./commands-ask.js";

describe("listNoteFiles", () => {
  it("returns note files recursively as relative paths, sorted, ignoring hidden + non-notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-listnotes-"));
    await mkdir(join(dir, "projects"), { recursive: true });
    await writeFile(join(dir, "lease.md"), "x");
    await writeFile(join(dir, "projects", "vpn.md"), "x");
    await writeFile(join(dir, "data.json"), "x"); // non-note → ignored
    await writeFile(join(dir, ".hidden.md"), "x"); // hidden → ignored
    const files = await listNoteFiles(dir);
    expect(files).toEqual(["lease.md", join("projects", "vpn.md")]);
    await rm(dir, { force: true, recursive: true });
  });

  it("caps the list at max", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-listnotes-cap-"));
    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, `n${i.toString()}.md`), "x");
    expect((await listNoteFiles(dir, 3)).length).toBe(3);
    await rm(dir, { force: true, recursive: true });
  });
});

describe("formatCorpusOverview", () => {
  it("lists the inventory with the count and how to use it", () => {
    const out = formatCorpusOverview(["lease.md", "projects/vpn.md"], 2);
    expect(out).toContain("You have 2 notes");
    expect(out).toContain("• lease.md");
    expect(out).toContain("• projects/vpn.md");
    expect(out).toContain("quote the source");
  });

  it("shows '… and N more' when the shown list is capped below the total", () => {
    expect(formatCorpusOverview(["a.md", "b.md"], 10)).toContain("… and 8 more");
  });

  it("uses the singular for a single note", () => {
    expect(formatCorpusOverview(["a.md"], 1)).toContain("You have 1 note.");
  });
});
