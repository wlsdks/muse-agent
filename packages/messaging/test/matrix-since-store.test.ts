import { mkdtempSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readMatrixSince, writeMatrixSince } from "../src/matrix-since-store.js";

describe("matrix-since-store", () => {
  it("returns undefined for a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-since-"));
    expect(await readMatrixSince(join(dir, "absent.json"))).toBeUndefined();
  });

  it("round-trips a since token and creates parent directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-since-"));
    const file = join(dir, "nested", "matrix-since.json");
    await writeMatrixSince(file, "s72594_4483_1934");
    expect(await readMatrixSince(file)).toBe("s72594_4483_1934");
  });

  it("returns undefined on malformed JSON or a non-string token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-since-"));
    const garbled = join(dir, "garbled.json");
    await fs.writeFile(garbled, "{not json", "utf8");
    expect(await readMatrixSince(garbled)).toBeUndefined();

    const wrongType = join(dir, "wrong.json");
    await fs.writeFile(wrongType, JSON.stringify({ since: 42, version: 1 }), "utf8");
    expect(await readMatrixSince(wrongType)).toBeUndefined();
  });

  it("rejects an empty token and writes user-only file mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-mx-since-"));
    const file = join(dir, "matrix-since.json");
    await expect(writeMatrixSince(file, "")).rejects.toThrow(/non-empty/u);
    await writeMatrixSince(file, "s1");
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
