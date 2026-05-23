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

  it("bundles the canonical local-calendar + messaging-credentials filenames the code actually writes", async () => {
    dir = mkdtempSync(join(tmpdir(), "muse-export-cal-"));
    const museDir = join(dir, ".muse");
    mkdirSync(museDir, { recursive: true });
    // The real stores: muse calendar add → calendar.json;
    // messaging credentials → messaging.json (NOT calendar-local.json /
    // messaging-credentials.json, which nothing ever writes).
    writeFileSync(join(museDir, "calendar.json"), "{}", "utf8");
    writeFileSync(join(museDir, "messaging.json"), "{}", "utf8");
    const out = await buildMuseExport({ museDir, notesDir: join(museDir, "notes"), outputPath: join(dir, "backup.tar.gz") });
    expect(out.files).toContain("calendar.json");
    expect(out.files).toContain("messaging.json");
  });

  it("no longer lists the phantom store names that nothing writes (catalog rot)", () => {
    expect(DEFAULT_EXPORT_FILES).not.toContain("calendar-local.json");
    expect(DEFAULT_EXPORT_FILES).not.toContain("messaging-credentials.json");
    expect(DEFAULT_EXPORT_FILES).toContain("calendar.json");
    expect(DEFAULT_EXPORT_FILES).toContain("messaging.json");
  });

  it("bundles the episode index alongside its notes-index sibling (recall survives restore without an Ollama re-embed)", async () => {
    expect(DEFAULT_EXPORT_FILES).toContain("episodes-index.json");
    dir = mkdtempSync(join(tmpdir(), "muse-export-epidx-"));
    const museDir = join(dir, ".muse");
    mkdirSync(museDir, { recursive: true });
    // Both semantic indices carry embeddings that are expensive to
    // recompute and NOT auto-rebuilt on read — backing up only one
    // leaves the other's recall broken on restore.
    writeFileSync(join(museDir, "notes-index.json"), "{}", "utf8");
    writeFileSync(join(museDir, "episodes-index.json"), "{}", "utf8");
    const out = await buildMuseExport({ museDir, notesDir: join(museDir, "notes"), outputPath: join(dir, "backup.tar.gz") });
    expect(out.files).toContain("notes-index.json");
    expect(out.files).toContain("episodes-index.json");
  });
});
