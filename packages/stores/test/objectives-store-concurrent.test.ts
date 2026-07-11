import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addObjective, patchObjective, readObjectives, writeObjectives, type StandingObjective } from "../src/personal-objectives-store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-objectives-concurrent-")); file = join(dir, "objectives.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const objective = (id: string): StandingObjective => ({
  createdAt: "2026-01-01T00:00:00Z",
  id,
  kind: "watch",
  spec: `watch thing ${id}`,
  status: "active",
  userId: "u"
});

// DS-3: addObjective / patchObjective moved off the in-process-only mutation
// queue onto the cross-process file lock (personal-tasks-store's mutateTasks
// pattern) — the daemon's re-evaluation tick and a manual CLI registration are
// SEPARATE processes; a lost standing objective is a watch/until/notify the
// daemon never acts on again.
describe("addObjective — cross-process file lock", () => {
  it("blocks its write while an externally-held (cross-process) lock is present", async () => {
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    let resolved = false;
    const pending = addObjective(file, objective("o1")).then(() => { resolved = true; });

    // Without the lock wrapper this assertion goes RED — the write proceeds
    // immediately regardless of the externally-held lock file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resolved).toBe(false);
    expect(await readObjectives(file)).toHaveLength(0);

    await unlink(lockPath);
    await pending;
    expect(resolved).toBe(true);
    expect(await readObjectives(file)).toHaveLength(1);
  }, 10_000);

  it("keeps every concurrently-registered objective (no lost objective over 50 parallel writers)", { timeout: 60_000 }, async () => {
    await Promise.all(Array.from({ length: 50 }, (_unused, i) => addObjective(file, objective(`o${i.toString()}`))));
    const all = await readObjectives(file);
    expect(all).toHaveLength(50);
    expect(new Set(all.map((o) => o.id)).size).toBe(50);
  }, 30_000);
});

describe("patchObjective — cross-process file lock", () => {
  it("applies every concurrent status-flip patch (no lost update over 50 parallel patches)", { timeout: 60_000 }, async () => {
    await writeObjectives(file, Array.from({ length: 50 }, (_unused, i) => objective(`o${i.toString()}`)));
    await Promise.all(Array.from({ length: 50 }, (_unused, i) => patchObjective(file, `o${i.toString()}`, { status: "done" })));
    const all = await readObjectives(file);
    expect(all).toHaveLength(50);
    expect(all.every((o) => o.status === "done")).toBe(true);
  }, 30_000);
});
