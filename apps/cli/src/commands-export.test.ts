import { EventEmitter } from "node:events";
import { execFileSync, type spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileBeliefProvenanceStore,
  FileUserMemoryStore
} from "@muse/memory";
import { buildMuseExport, DEFAULT_EXPORT_FILES } from "./commands-export.js";

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
}

/**
 * `buildMuseExport` awaits real disk I/O (stat/mkdir/writeFile) before
 * calling `spawnImpl`, so a test can't synchronously emit on a
 * pre-built child — the `data`/`close` listeners aren't attached yet.
 * The factory instead defers the emission to a `setImmediate` INSIDE
 * the spawn call itself, guaranteeing it runs after the listeners are
 * registered synchronously in the same tick `spawnImpl(...)` resolves.
 */
function makeFakeSpawn(scriptedStderrChunks: readonly Buffer[], exitCode: number): typeof spawn {
  return ((): FakeChild => {
    const child = new EventEmitter() as FakeChild;
    child.stderr = new EventEmitter();
    setImmediate(() => {
      for (const chunk of scriptedStderrChunks) {
        child.stderr.emit("data", chunk);
      }
      child.emit("close", exitCode);
    });
    return child;
  }) as unknown as typeof spawn;
}

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
    for (const f of ["belief-provenance.json", "contacts.json", "feeds.json", "objectives.json", "vetoes.json", "persona.json"]) {
      expect(DEFAULT_EXPORT_FILES).toContain(f);
    }
  });

  it("bundles a deterministic provenance report and marks unversioned correction history incomplete", async () => {
    dir = mkdtempSync(join(tmpdir(), "muse-export-provenance-"));
    const museDir = join(dir, ".muse");
    mkdirSync(museDir, { recursive: true });
    const memoryFile = join(museDir, "user-memory.json");
    const provenanceFile = join(museDir, "belief-provenance.json");
    const memory = new FileUserMemoryStore({
      file: memoryFile,
      now: () => new Date("2026-02-01T00:00:00.000Z")
    });
    const provenance = new FileBeliefProvenanceStore(provenanceFile);
    await memory.upsertFact("owner", "home_city", "Seoul");
    const exact = (await memory.inspectOwnerMemory("owner"))[0]!;
    await memory.correctOwnerMemory("owner", {
      exactId: exact.exactId,
      expectedVersion: 1,
      requestId: "correct-home-city-export",
      value: "Busan"
    });
    await provenance.recordMany([
      {
        key: "home_city",
        kind: "fact",
        learnedAt: "2026-01-01T00:00:00.000Z",
        source: "user",
        userId: "owner",
        value: "Seoul"
      },
      {
        key: "home_city",
        kind: "fact",
        learnedAt: "2026-02-01T00:00:00.000Z",
        source: "user",
        userId: "owner",
        value: "Busan"
      }
    ]);
    const beforeMemory = readFileSync(memoryFile, "utf8");
    const beforeProvenance = readFileSync(provenanceFile, "utf8");
    const outputPath = join(dir, "backup.tar.gz");

    const out = await buildMuseExport({
      museDir,
      notesDir: join(museDir, "notes"),
      outputPath,
      ownerUserId: "owner",
      nowIso: "2026-03-01T00:00:00.000Z"
    });

    expect(out.memoryProvenance.complete).toBe(false);
    expect(out.memoryProvenance.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-version-link" }),
      expect.objectContaining({ code: "missing-current-link" })
    ]));
    expect(out.files).toContain("belief-provenance.json");
    expect(execFileSync("tar", ["-tzf", outputPath], { encoding: "utf8" }))
      .toContain(".muse/memory-provenance-report.export.json");
    expect(readFileSync(memoryFile, "utf8")).toBe(beforeMemory);
    expect(readFileSync(provenanceFile, "utf8")).toBe(beforeProvenance);
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

  it("decodes a `tar` stderr error message correctly when split mid-character across two `data` events (DS-17)", async () => {
    dir = mkdtempSync(join(tmpdir(), "muse-export-utf8-"));
    const museDir = join(dir, ".muse");
    mkdirSync(museDir, { recursive: true });
    writeFileSync(join(museDir, "tasks.json"), "{}", "utf8");
    const full = Buffer.from("tar: 오류 발생 🚫", "utf8");
    const splitAt = 6; // mid-character inside a 3-byte Hangul sequence
    const spawnFn = makeFakeSpawn([full.subarray(0, splitAt), full.subarray(splitAt)], 1);
    const promise = buildMuseExport({
      museDir,
      notesDir: join(museDir, "notes"),
      outputPath: join(dir, "backup.tar.gz"),
      spawnImpl: spawnFn
    });
    await expect(promise).rejects.toThrow("tar: 오류 발생 🚫");
  });
});
