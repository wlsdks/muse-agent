import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { FileCheckpointStore } from "./file-checkpoint-store.js";

const state = (phase: string) => ({ encodedMessages: [`v1|user|${phase}`], metadata: null, model: "gemma4:12b", output: null, phase });

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "muse-ckpt-"));
}

describe("FileCheckpointStore — durable local checkpoints so a crashed run can resume", () => {
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
      writeFileSync(join(dir, "c", "torn.json"), "{not json");
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
});
