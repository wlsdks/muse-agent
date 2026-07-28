import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_USER_MEMORY_UNDO_TTL_MS,
  FileUserMemoryStore,
  MAX_USER_MEMORY_UNDO_TTL_MS,
  UserMemoryOwnerControlError
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("FileUserMemoryStore.previewOwnerMemoryForget", () => {
  it("projects exact affected stores, retention, and undo boundaries without changing either store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-forget-preview-"));
    directories.push(directory);
    const memoryFile = join(directory, "user-memory.json");
    const provenanceFile = join(directory, "belief-provenance.json");
    const memory = new FileUserMemoryStore({ file: memoryFile });
    await memory.upsertFact("owner", "home_city", "Seoul");
    await writeFile(provenanceFile, `${JSON.stringify({
      entries: [{
        key: "home_city",
        kind: "fact",
        learnedAt: "2026-07-30T12:00:00.000Z",
        source: "user",
        userId: "owner",
        value: "Seoul"
      }]
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const beforeMemory = await readFile(memoryFile, "utf8");
    const beforeProvenance = await readFile(provenanceFile, "utf8");

    const first = await memory.previewOwnerMemoryForget("owner", target.exactId);
    const second = await memory.previewOwnerMemoryForget("owner", target.exactId);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      affectedStores: [
        {
          change: "delete-exact-entry",
          store: "user-memory",
          undoCoverage: "covered",
          writeOrder: "authoritative-first"
        },
        {
          change: "append-forget-retraction",
          store: "belief-provenance",
          undoCoverage: "not-covered",
          writeOrder: "best-effort-after-user-memory"
        }
      ],
      irreversibleBoundaries: [
        {
          boundary: "undo-window-expires",
          consequence: "exact-entry-restore-no-longer-authorized",
          store: "user-memory"
        },
        {
          boundary: "retraction-appended",
          consequence: "memory-undo-does-not-remove-retraction-later-explicit-set-may-supersede",
          store: "belief-provenance"
        }
      ],
      operation: "forget",
      retention: {
        currentEntry: "retained-until-confirmed-forget",
        mutationReceipt: "undo-authority-expires-after-ttl",
        provenance: "append-only-bounded-history"
      },
      target,
      undo: {
        excludes: ["belief-provenance-retraction"],
        maxTtlMs: MAX_USER_MEMORY_UNDO_TTL_MS,
        scope: "exact-memory-entry-only",
        ttlMs: DEFAULT_USER_MEMORY_UNDO_TTL_MS
      }
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.target)).toBe(true);
    expect(Object.isFrozen(first.affectedStores)).toBe(true);
    expect(Object.isFrozen(first.irreversibleBoundaries)).toBe(true);
    expect(Object.isFrozen(first.undo)).toBe(true);
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeProvenance);
  });

  it("fails closed for fuzzy IDs and invalid undo windows without creating a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-forget-preview-invalid-"));
    directories.push(directory);
    const memoryFile = join(directory, "user-memory.json");
    const memory = new FileUserMemoryStore({ file: memoryFile });
    await memory.upsertFact("owner", "home_city", "Seoul");
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const beforeMemory = await readFile(memoryFile, "utf8");

    await expect(memory.previewOwnerMemoryForget("owner", "home_city"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof UserMemoryOwnerControlError && error.code === "exact-id-required"
      );
    await expect(memory.previewOwnerMemoryForget("owner", target.exactId, { undoTtlMs: 0 }))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof UserMemoryOwnerControlError && error.code === "invalid-request"
      );
    await expect(memory.previewOwnerMemoryForget("owner", target.exactId, {
      undoTtlMs: MAX_USER_MEMORY_UNDO_TTL_MS + 1
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "invalid-request"
    );
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
  });
});
