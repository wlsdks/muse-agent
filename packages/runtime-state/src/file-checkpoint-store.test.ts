import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileLock } from "@muse/shared";
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { FileCheckpointStore, pruneCheckpointFilesByAge } from "./file-checkpoint-store.js";
import { checkpointV3FileName } from "./checkpoint-v3.js";

const state = (phase: string) => ({ encodedMessages: [`v1|user|${phase}`], metadata: null, model: "gemma4:12b", output: null, phase });

function tmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "muse-ckpt-")));
}

function checkpointFileName(runId: string): string {
  const prefix = runId.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 180) || "run";
  return `${prefix}-${createHash("sha256").update(runId).digest("hex")}.json`;
}

describe("FileCheckpointStore — durable local checkpoints so a crashed run can resume", () => {
  it("namespaces future v3 checkpoints by workspace and never lets an authority-less store discover them", async () => {
    const dir = tmpDir();
    try {
      const checkpointsDir = join(dir, "checkpoints");
      const workspaceA = realpathSync(mkdtempSync(join(dir, "workspace-a-")));
      const workspaceB = realpathSync(mkdtempSync(join(dir, "workspace-b-")));
      const runId = "same-run";
      const a = new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspaceA });
      const b = new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspaceB });
      await a.save({ continuityEvidence: { phase: "act", query: "A request" }, runId, state: state("from-a"), step: 1 });
      await b.save({ continuityEvidence: { phase: "act", query: "B request" }, runId, state: state("from-b"), step: 1 });

      const names = readdirSync(join(checkpointsDir, "v3")).sort();
      expect(names).toEqual([
        checkpointV3FileName(workspaceA, runId),
        checkpointV3FileName(workspaceB, runId)
      ].sort());
      expect((await a.findByRunId(runId))[0]?.state).toMatchObject({ phase: "from-a" });
      expect((await b.findByRunId(runId))[0]?.state).toMatchObject({ phase: "from-b" });
      await expect(new FileCheckpointStore(checkpointsDir).findByRunId(runId)).resolves.toEqual([]);

      const bPath = join(checkpointsDir, "v3", checkpointV3FileName(workspaceB, runId));
      const before = { bytes: readFileSync(bPath), mtimeMs: statSync(bPath).mtimeMs };
      await a.deleteByRunId(runId);
      expect(readFileSync(bPath)).toEqual(before.bytes);
      expect(statSync(bPath).mtimeMs).toBe(before.mtimeMs);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("merges v3 over v2 by step without copying legacy evidence into the v3 envelope", async () => {
    const dir = tmpDir();
    try {
      const checkpointsDir = join(dir, "checkpoints");
      const workspace = realpathSync(mkdtempSync(join(dir, "workspace-")));
      const legacy = new FileCheckpointStore(checkpointsDir);
      await legacy.save({ runId: "mixed", state: state("legacy-zero"), step: 0 });
      await legacy.save({ runId: "mixed", state: state("legacy-one"), step: 1 });
      const future = new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspace });
      await future.save({ continuityEvidence: { phase: "act", query: "continue safely" }, runId: "mixed", state: state("future-one"), step: 1 });

      const merged = await future.findByRunId("mixed");
      expect(merged.map((checkpoint) => [checkpoint.step, checkpoint.state.phase])).toEqual([[0, "legacy-zero"], [1, "future-one"]]);
      const envelope = JSON.parse(readFileSync(join(checkpointsDir, "v3", checkpointV3FileName(workspace, "mixed")), "utf8")) as { checkpoints: Array<{ step: number }> };
      expect(envelope.checkpoints.map((checkpoint) => checkpoint.step)).toEqual([1]);
      expect((await legacy.findByRunId("mixed")).map((checkpoint) => checkpoint.state.phase)).toEqual(["legacy-zero", "legacy-one"]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("global age housekeeping covers v2/v3, skips symlinks, and rechecks a locked candidate", async () => {
    const dir = tmpDir();
    try {
      const checkpointsDir = join(dir, "checkpoints");
      const workspace = realpathSync(mkdtempSync(join(dir, "workspace-")));
      const oldMs = Date.now() - 10 * 86_400_000;
      const legacy = new FileCheckpointStore(checkpointsDir);
      await legacy.save({ runId: "old-v2", state: state("old"), step: 0 });
      const future = new FileCheckpointStore(checkpointsDir, { continuityWorkspaceDir: workspace });
      await future.save({ continuityEvidence: { phase: "start", query: "old" }, runId: "old-v3", state: state("old"), step: 0 });
      const v2Path = join(checkpointsDir, "v2", checkpointFileName("old-v2"));
      const v3Path = join(checkpointsDir, "v3", checkpointV3FileName(workspace, "old-v3"));
      utimesSync(v2Path, oldMs / 1000, oldMs / 1000);
      utimesSync(v3Path, oldMs / 1000, oldMs / 1000);
      symlinkSync(v2Path, join(checkpointsDir, "linked.json"));

      const acquired = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = withFileLock(v3Path, async () => {
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      const pruning = pruneCheckpointFilesByAge(checkpointsDir, { ageDays: 5, now: Date.now() });
      await sleep(20);
      writeFileSync(v3Path, readFileSync(v3Path));
      utimesSync(v3Path, new Date(), new Date());
      release.resolve();
      const result = await pruning;
      await held;

      expect(result.droppedFiles).toContain(`v2/${checkpointFileName("old-v2")}`);
      expect(result.droppedFiles).not.toContain(`v3/${checkpointV3FileName(workspace, "old-v3")}`);
      expect(readFileSync(v3Path, "utf8")).toContain("old-v3");
      expect(lstatSync(join(checkpointsDir, "linked.json")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
  it("rejects invalid retention options instead of silently losing or retaining checkpoints", () => {
    const dir = tmpDir();
    try {
      for (const options of [
        { maxCheckpointsPerRun: 0 },
        { maxRuns: Number.POSITIVE_INFINITY },
        { pruneIntervalSaves: -1 }
      ]) {
        expect(() => new FileCheckpointStore(join(dir, "c"), options)).toThrow(RangeError);
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("persists checkpoints and a FRESH store recovers them (the cross-process resume guarantee)", async () => {
    const dir = tmpDir();
    try {
      const a = new FileCheckpointStore(join(dir, "checkpoints"));
      await a.save({ runId: "run-1", state: state("start"), step: 0 });
      await a.save({ runId: "run-1", state: state("act-1"), step: 1 });
      // A brand-new store instance (simulating a process restart) reads from disk.
      const b = new FileCheckpointStore(join(dir, "checkpoints"));
      const all = await b.findByRunId("run-1");
      expect(all.map((c) => c.step)).toEqual([0, 1]);
      const latest = await b.findLatestByRunId("run-1");
      expect((latest!.state as { phase: string }).phase).toBe("act-1"); // resume from the LAST step
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("upserts by step (a re-saved step replaces, never duplicates)", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "r", state: state("v1"), step: 2 });
      await store.save({ runId: "r", state: state("v2"), step: 2 });
      const all = await store.findByRunId("r");
      expect(all).toHaveLength(1);
      expect((all[0]!.state as { phase: string }).phase).toBe("v2");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("waits for an external process lock before appending a checkpoint", async () => {
    const dir = tmpDir();
    const checkpointsDir = join(dir, "c");
    const runId = "locked-run";
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mkdirSync(join(checkpointsDir, "v2"), { recursive: true });
    const heldLock = withFileLock(join(checkpointsDir, "v2", checkpointFileName(runId)), async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;

    let settled = false;
    const pendingSave = new FileCheckpointStore(checkpointsDir).save({ runId, state: state("start"), step: 0 }).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    release.resolve();
    await Promise.all([heldLock, pendingSave]);
    expect(await new FileCheckpointStore(checkpointsDir).findByRunId(runId)).toHaveLength(1);
    rmSync(dir, { force: true, recursive: true });
  });

  it("deleteByRunId clears a completed run's checkpoints", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "r", state: state("start"), step: 0 });
      await store.deleteByRunId("r");
      expect(await store.findByRunId("r")).toEqual([]);
      expect(await store.findLatestByRunId("r")).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("a missing run / corrupt file reads as [] (never throws into the agent loop)", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      expect(await store.findByRunId("never-saved")).toEqual([]);
      await store.save({ runId: "ok", state: state("start"), step: 0 });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "c", "v2", checkpointFileName("torn")), "{not json");
      expect(await store.findByRunId("torn")).toEqual([]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("listResumable returns only runs whose latest checkpoint is NOT complete (crashed mid-run)", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      // a crashed run: latest phase "act"
      await store.save({ runId: "crashed", state: state("start"), step: 0 });
      await store.save({ runId: "crashed", state: state("act"), step: 2 });
      // a finished run: latest phase "complete"
      await store.save({ runId: "done", state: state("start"), step: 0 });
      await store.save({ runId: "done", state: state("complete"), step: 100 });
      const resumable = await store.listResumable();
      expect(resumable.map((r) => r.runId)).toEqual(["crashed"]); // "done" excluded
      expect(resumable[0]).toMatchObject({ phase: "act", step: 2 });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("findResumableCheckpoint resumes from the latest PROGRESS step, not a terminal `failed` sentinel that shadows it", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "r", state: state("start"), step: 0 });
      await store.save({ runId: "r", state: state("act"), step: 2 }); // real progress
      await store.save({ runId: "r", state: state("failed"), step: 900 }); // sentinel w/ original msgs, high step
      const resumable = await store.findResumableCheckpoint("r");
      expect(resumable?.step).toBe(2); // the PROGRESS act step, not the shadowing 900
      expect((resumable!.state as { phase: string }).phase).toBe("act");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("findResumableCheckpoint returns undefined for a COMPLETED run (nothing to resume)", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "r", state: state("act"), step: 2 });
      await store.save({ runId: "r", state: state("complete"), step: 100 });
      expect(await store.findResumableCheckpoint("r")).toBeUndefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("bounds disk: prunes the oldest run files beyond maxRuns", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"), { maxRuns: 2, pruneIntervalSaves: 1 });
      for (const id of ["r1", "r2", "r3"]) {
        await store.save({ runId: id, state: state("s"), step: 0 });
        await sleep(5); // distinct mtimes
      }
      expect(await store.findByRunId("r1")).toEqual([]); // oldest pruned
      expect(await store.findByRunId("r3")).toHaveLength(1); // newest kept
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("waits for an active run-file lock before retention can prune that run", async () => {
    const dir = tmpDir();
    const checkpointsDir = join(dir, "c");
    try {
      const seed = new FileCheckpointStore(checkpointsDir, { maxRuns: 10, pruneIntervalSaves: 100 });
      await seed.save({ runId: "old", state: state("start"), step: 0 });
      await sleep(5);
      await seed.save({ runId: "recent", state: state("start"), step: 0 });

      const acquired = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const heldLock = withFileLock(join(checkpointsDir, "v2", checkpointFileName("old")), async () => {
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;

      let settled = false;
      const pendingSave = new FileCheckpointStore(checkpointsDir, { maxRuns: 2, pruneIntervalSaves: 1 })
        .save({ runId: "new", state: state("start"), step: 0 })
        .then(() => { settled = true; });
      await sleep(25);
      expect(settled).toBe(false);

      release.resolve();
      await Promise.all([heldLock, pendingSave]);
      const store = new FileCheckpointStore(checkpointsDir);
      expect(await store.findByRunId("old")).toEqual([]);
      expect(await store.findByRunId("recent")).toHaveLength(1);
      expect(await store.findByRunId("new")).toHaveLength(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("a runId with path separators can't escape the dir (filename is sanitized)", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "../../etc/evil", state: state("x"), step: 0 });
      // It round-trips by the SAME (sanitized) key, and stays inside the dir.
      expect(await store.findByRunId("../../etc/evil")).toHaveLength(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps distinct run IDs isolated when their legacy sanitized filenames collide", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ runId: "run/a", state: state("first"), step: 0 });
      await store.save({ runId: "run?a", state: state("second"), step: 0 });

      expect((await store.findByRunId("run/a"))[0]?.state).toMatchObject({ phase: "first" });
      expect((await store.findByRunId("run?a"))[0]?.state).toMatchObject({ phase: "second" });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("recovers and deletes a checkpoint written with the legacy sanitized filename", async () => {
    const dir = tmpDir();
    const runId = "legacy/run";
    const checkpointsDir = join(dir, "c");
    try {
      mkdirSync(checkpointsDir, { recursive: true });
      writeFileSync(join(checkpointsDir, "legacy_run.json"), JSON.stringify([{
        createdAt: "2026-07-16T00:00:00.000Z",
        id: "legacy-checkpoint",
        runId,
        state: state("act"),
        step: 1
      }]));
      const store = new FileCheckpointStore(checkpointsDir);

      await expect(store.findByRunId(runId)).resolves.toEqual([
        expect.objectContaining({ id: "legacy-checkpoint", runId, step: 1 })
      ]);
      await store.deleteByRunId(runId);
      await expect(store.findByRunId(runId)).resolves.toEqual([]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not read a colliding legacy file whose stored run ID belongs to another run", async () => {
    const dir = tmpDir();
    const checkpointsDir = join(dir, "c");
    try {
      mkdirSync(checkpointsDir, { recursive: true });
      writeFileSync(join(checkpointsDir, "run_a.json"), JSON.stringify([{
        createdAt: "2026-07-16T00:00:00.000Z",
        id: "legacy-checkpoint",
        runId: "run/a",
        state: state("act"),
        step: 1
      }]));
      const store = new FileCheckpointStore(checkpointsDir);

      await expect(store.findByRunId("run?a")).resolves.toEqual([]);
      await expect(store.findByRunId("run/a")).resolves.toHaveLength(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("falls back to a valid legacy checkpoint when the v2 file is corrupt", async () => {
    const dir = tmpDir();
    const runId = "legacy/run";
    const checkpointsDir = join(dir, "c");
    try {
      mkdirSync(join(checkpointsDir, "v2"), { recursive: true });
      writeFileSync(join(checkpointsDir, "legacy_run.json"), JSON.stringify([{
        createdAt: "2026-07-16T00:00:00.000Z",
        id: "legacy-checkpoint",
        runId,
        state: state("act"),
        step: 1
      }]));
      writeFileSync(join(checkpointsDir, "v2", checkpointFileName(runId)), "{not json");

      await expect(new FileCheckpointStore(checkpointsDir).findByRunId(runId)).resolves.toEqual([
        expect.objectContaining({ id: "legacy-checkpoint", runId, step: 1 })
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("keeps the v2 namespace separate from a legacy run whose ID equals a v2 filename", async () => {
    const dir = tmpDir();
    const checkpointsDir = join(dir, "c");
    const v2RunId = "run/a";
    const legacyRunId = checkpointFileName(v2RunId).replace(/\.json$/u, "");
    try {
      mkdirSync(checkpointsDir, { recursive: true });
      writeFileSync(join(checkpointsDir, `${legacyRunId}.json`), JSON.stringify([{
        createdAt: "2026-07-16T00:00:00.000Z",
        id: "legacy-checkpoint",
        runId: legacyRunId,
        state: state("legacy"),
        step: 1
      }]));
      const store = new FileCheckpointStore(checkpointsDir);
      await store.save({ runId: v2RunId, state: state("v2"), step: 1 });

      expect((await store.findByRunId(v2RunId))[0]?.state).toMatchObject({ phase: "v2" });
      expect((await store.findByRunId(legacyRunId))[0]?.state).toMatchObject({ phase: "legacy" });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("prunes v1/v2 aliases together as one logical run", async () => {
    const dir = tmpDir();
    const checkpointsDir = join(dir, "c");
    try {
      const store = new FileCheckpointStore(checkpointsDir, { maxRuns: 1, pruneIntervalSaves: 1 });
      await store.save({ runId: "old", state: state("old"), step: 1 });
      writeFileSync(join(checkpointsDir, "old.json"), JSON.stringify([{
        createdAt: "2026-07-16T00:00:00.000Z",
        id: "legacy-old",
        runId: "old",
        state: state("old"),
        step: 1
      }]));
      await sleep(5);
      await store.save({ runId: "new", state: state("new"), step: 1 });

      await expect(store.findByRunId("old")).resolves.toEqual([]);
      await expect(store.findByRunId("new")).resolves.toHaveLength(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("completes concurrent retention saves without cross-run lock inversion", async () => {
    const dir = tmpDir();
    try {
      const options = { maxRuns: 1, pruneIntervalSaves: 1 };
      const first = new FileCheckpointStore(join(dir, "c"), options);
      const second = new FileCheckpointStore(join(dir, "c"), options);
      await expect(Promise.race([
        Promise.all([
          first.save({ runId: "run-a", state: state("a"), step: 1 }),
          second.save({ runId: "run-b", state: state("b"), step: 1 })
        ]),
        // Windows CI performs the same fsync/rename work much more slowly under
        // the full workspace fan-out. Five seconds still catches a real lock
        // inversion far before the production lock's 30s give-up window, while
        // measuring the invariant (both saves complete), not runner speed.
        sleep(5_000).then(() => { throw new Error("concurrent retention save timed out"); })
      ])).resolves.toBeDefined();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("sanitizes a caller-provided checkpoint id before using it in the atomic temporary path", async () => {
    const dir = tmpDir();
    try {
      const store = new FileCheckpointStore(join(dir, "c"));
      await store.save({ id: "../../outside", runId: "r", state: state("start"), step: 0 });

      expect(await store.findByRunId("r")).toEqual([
        expect.objectContaining({ id: "../../outside", step: 0 })
      ]);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
