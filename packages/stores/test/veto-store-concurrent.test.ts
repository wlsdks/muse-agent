import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readVetoes, recordVeto, removeVeto, type ActionVeto } from "../src/personal-veto-store.js";

let dir: string;
let file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-veto-concurrent-")); file = join(dir, "vetoes.json"); });
afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

const veto = (id: string): ActionVeto => ({
  id,
  objectiveId: "o1",
  scope: "github:issues:write",
  userId: "u",
  vetoedAt: "2026-01-01T00:00:00Z"
});

// DS-3: recordVeto / removeVeto moved off the in-process-only mutation queue
// onto the cross-process file lock (personal-tasks-store's mutateTasks
// pattern) — the daemon and a manual CLI veto are SEPARATE processes; a lost
// veto is a learned-avoidance the agent forgets, so it re-attempts an action
// the user already refused.
describe("recordVeto — cross-process file lock", () => {
  it("blocks its write while an externally-held (cross-process) lock is present", async () => {
    const lockPath = `${file}.lock`;
    await writeFile(lockPath, "external-holder", "utf8");

    let resolved = false;
    const pending = recordVeto(file, veto("v1")).then(() => { resolved = true; });

    // Without the lock wrapper this assertion goes RED — the write proceeds
    // immediately regardless of the externally-held lock file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resolved).toBe(false);
    expect(await readVetoes(file)).toHaveLength(0);

    await unlink(lockPath);
    await pending;
    expect(resolved).toBe(true);
    expect(await readVetoes(file)).toHaveLength(1);
  }, 10_000);

  it("keeps every concurrently-recorded veto (no lost veto over 50 parallel writers)", { timeout: 60_000 }, async () => {
    await Promise.all(Array.from({ length: 50 }, (_unused, i) => recordVeto(file, veto(`v${i.toString()}`))));
    const all = await readVetoes(file);
    expect(all).toHaveLength(50);
    expect(new Set(all.map((v) => v.id)).size).toBe(50);
  }, 30_000);

  it("applies every concurrent remove exactly, leaving the untouched vetoes (no lost remove)", { timeout: 60_000 }, async () => {
    await Promise.all(Array.from({ length: 50 }, (_unused, i) => recordVeto(file, veto(`v${i.toString()}`))));
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => removeVeto(file, `v${i.toString()}`)));
    expect(await readVetoes(file)).toHaveLength(30);
  }, 30_000);
});
