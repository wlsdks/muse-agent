import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMuseExport, DEFAULT_EXPORT_FILES } from "./commands-export.js";

describe("muse export — bundles every user-data store, not just some", () => {
  let dir: string;
  afterEach(() => { /* tmpdirs are disposable; left for OS cleanup */ });

  it("includes the people graph, feeds, objectives, vetoes, and personas when present", async () => {
    dir = mkdtempSync(join(tmpdir(), "muse-export-"));
    const museDir = join(dir, ".muse");
    const notesDir = join(museDir, "notes");
    mkdirSync(notesDir, { recursive: true });
    // Seed the stores a user would hate to lose on restore.
    for (const f of ["contacts.json", "feeds.json", "objectives.json", "vetoes.json", "persona.json", "tasks.json"]) {
      writeFileSync(join(museDir, f), "{}", "utf8");
    }
    const out = await buildMuseExport({ museDir, notesDir, outputPath: join(dir, "backup.tar.gz") });
    for (const f of ["contacts.json", "feeds.json", "objectives.json", "vetoes.json", "persona.json", "tasks.json"]) {
      expect(out.files).toContain(f);
    }
  });

  it("DEFAULT_EXPORT_FILES lists the recently-added stores", () => {
    for (const f of ["contacts.json", "feeds.json", "objectives.json", "vetoes.json", "persona.json"]) {
      expect(DEFAULT_EXPORT_FILES).toContain(f);
    }
  });
});
