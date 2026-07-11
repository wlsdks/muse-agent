import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { quarantineCorruptStore } from "../src/store-quarantine.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muse-store-quarantine-"));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("quarantineCorruptStore", () => {
  it("renames an existing file aside to <file>.corrupt-<ts>, leaving the original path gone", async () => {
    const file = join(dir, "store.json");
    await writeFile(file, "not json{{{", "utf8");
    await quarantineCorruptStore(file);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.startsWith("store.json.corrupt-")).toBe(true);
    await expect(readdir(dir).then((e) => e.includes("store.json"))).resolves.toBe(false);
  });

  it("is a silent no-op when the file does not exist (missing file is not corruption)", async () => {
    const file = join(dir, "missing.json");
    await expect(quarantineCorruptStore(file)).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("is a silent no-op when the rename target is unwritable (e.g. parent replaced by a file)", async () => {
    // Force the rename to fail: pointing at a path inside a non-existent nested
    // directory means fs.rename throws ENOENT — the function must swallow it.
    const nested = join(dir, "gone", "store.json");
    await expect(quarantineCorruptStore(nested)).resolves.toBeUndefined();
  });

  it("quarantines a directory too (rename doesn't care about file type)", async () => {
    const dirAsStore = join(dir, "store-dir");
    await mkdir(dirAsStore);
    await quarantineCorruptStore(dirAsStore);
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.startsWith("store-dir.corrupt-")).toBe(true);
  });
});
