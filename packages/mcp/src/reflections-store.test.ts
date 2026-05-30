import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addReflections, listReflections, readReflections } from "./reflections-store.js";

describe("reflections-store", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-refl-"));
    file = join(dir, "reflections.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("adds reflections and reads them back", async () => {
    const n = await addReflections(file, [
      { createdAtMs: 1_000, id: "r1", insight: "You keep wrestling with home networking", sourceIds: ["e1", "e2"], supportCount: 2 }
    ]);
    expect(n).toBe(1);
    const read = await readReflections(file);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ id: "r1", sourceIds: ["e1", "e2"], supportCount: 2 });
  });

  it("dedupes on the normalised insight across passes", async () => {
    await addReflections(file, [{ createdAtMs: 1, id: "r1", insight: "You prefer concise answers", sourceIds: ["e1", "e2"], supportCount: 2 }]);
    const added = await addReflections(file, [
      { createdAtMs: 2, id: "r2", insight: "  You   PREFER concise   answers ", sourceIds: ["e3", "e4"], supportCount: 2 }, // same → skip
      { createdAtMs: 2, id: "r3", insight: "You travel often for work", sourceIds: ["e5", "e6"], supportCount: 2 } // new
    ]);
    expect(added).toBe(1);
    expect(await readReflections(file)).toHaveLength(2);
  });

  it("listReflections returns newest first", async () => {
    await addReflections(file, [
      { createdAtMs: 1_000, id: "r1", insight: "A", sourceIds: ["e1", "e2"], supportCount: 2 },
      { createdAtMs: 3_000, id: "r2", insight: "B", sourceIds: ["e3", "e4"], supportCount: 2 },
      { createdAtMs: 2_000, id: "r3", insight: "C", sourceIds: ["e5", "e6"], supportCount: 2 }
    ]);
    expect(listReflections(await readReflections(file)).map((r) => r.id)).toEqual(["r2", "r3", "r1"]);
  });

  it("tolerant reads: missing / corrupt / wrong-shape / corrupt-row", async () => {
    expect(await readReflections(file)).toEqual([]);
    await writeFile(file, "{ not json", "utf8");
    expect(await readReflections(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ reflections: [
      { createdAtMs: 1, id: "ok", insight: "x", sourceIds: ["e1"], supportCount: 1 },
      { id: "bad" },
      99
    ] }), "utf8");
    const read = await readReflections(file);
    expect(read).toHaveLength(1);
    expect(read[0]!.id).toBe("ok");
  });
});
