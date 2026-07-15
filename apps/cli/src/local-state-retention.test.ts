import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_RETENTION_WINDOWS, maybeAutoPrune, pruneCheckpointsByAge, pruneRunsByAge } from "./local-state-retention.js";

const DAY_MS = 86_400_000;
const runEvent = (recordedAt: string) => JSON.stringify({ message: "hi", recordedAt, response: {}, success: true });

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setMtime(path: string, ms: number): void {
  const d = new Date(ms);
  utimesSync(path, d, d);
}

describe("pruneRunsByAge — .muse/runs/*.jsonl", () => {
  it("drops run files whose last-recorded event is older than the window and keeps recent ones", async () => {
    const dir = mkTmp("muse-runs-prune-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      writeFileSync(join(dir, "old.jsonl"), runEvent(new Date(now - 200 * DAY_MS).toISOString()));
      writeFileSync(join(dir, "recent.jsonl"), runEvent(new Date(now - 1 * DAY_MS).toISOString()));

      const result = await pruneRunsByAge(dir, { ageDays: 90, now });
      expect(result).toEqual({ dropped: 1, droppedFiles: ["old.jsonl"], kept: 1 });

      const remaining = await readFile(join(dir, "recent.jsonl"), "utf8").catch(() => undefined);
      expect(remaining).toBeDefined();
      await expect(readFile(join(dir, "old.jsonl"), "utf8")).rejects.toThrow();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("falls back to file mtime when the content is unparseable, so a corrupt trace still ages out", async () => {
    const dir = mkTmp("muse-runs-prune-corrupt-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const path = join(dir, "corrupt.jsonl");
      writeFileSync(path, "{not json");
      setMtime(path, now - 200 * DAY_MS);

      const result = await pruneRunsByAge(dir, { ageDays: 90, now });
      expect(result.dropped).toBe(1);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("a missing dir is a safe no-op", async () => {
    expect(await pruneRunsByAge("/no/such/muse-runs-dir", { ageDays: 90, now: Date.now() })).toEqual({ dropped: 0, droppedFiles: [], kept: 0 });
  });

  it("idempotent: a second run with nothing left to drop changes nothing", async () => {
    const dir = mkTmp("muse-runs-prune-idem-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      writeFileSync(join(dir, "recent.jsonl"), runEvent(new Date(now - 1 * DAY_MS).toISOString()));
      const first = await pruneRunsByAge(dir, { ageDays: 90, now });
      const second = await pruneRunsByAge(dir, { ageDays: 90, now });
      expect(first).toEqual({ dropped: 0, droppedFiles: [], kept: 1 });
      expect(second).toEqual({ dropped: 0, droppedFiles: [], kept: 1 });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("pruneCheckpointsByAge — .muse/checkpoints/*.json", () => {
  it("drops checkpoint files older (by mtime) than the window and keeps recent ones", async () => {
    const dir = mkTmp("muse-ckpt-prune-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const oldPath = join(dir, "run-old.json");
      const recentPath = join(dir, "run-recent.json");
      writeFileSync(oldPath, "[]");
      writeFileSync(recentPath, "[]");
      setMtime(oldPath, now - 200 * DAY_MS);
      setMtime(recentPath, now - 1 * DAY_MS);

      const result = await pruneCheckpointsByAge(dir, { ageDays: 90, now });
      expect(result).toEqual({ dropped: 1, droppedFiles: ["run-old.json"], kept: 1 });
      await expect(readFile(oldPath, "utf8")).rejects.toThrow();
      await expect(readFile(recentPath, "utf8")).resolves.toBe("[]");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("a missing dir is a safe no-op", async () => {
    expect(await pruneCheckpointsByAge("/no/such/muse-checkpoints-dir", { ageDays: 90, now: Date.now() })).toEqual({ dropped: 0, droppedFiles: [], kept: 0 });
  });
});

describe("maybeAutoPrune — interval-gated orchestrator (DS-13)", () => {
  function setupHome(): { home: string; env: NodeJS.ProcessEnv; metaFile: string } {
    const home = mkTmp("muse-home-");
    mkdirSync(join(home, ".muse"), { recursive: true });
    const metaFile = join(home, ".muse", "prune-meta.json");
    const env: NodeJS.ProcessEnv = {
      MUSE_ACTION_LOG_FILE: join(home, ".muse", "action-log.json"),
      MUSE_CHECKPOINTS_DIR: join(home, ".muse", "checkpoints"),
      MUSE_LEARN_QUEUE_FILE: join(home, ".muse", "learn-queue.jsonl"),
      MUSE_PRUNE_META_FILE: metaFile
    };
    return { env, home, metaFile };
  }

  it("runs on a fresh marker, prunes all four targets, then gates a second call inside the 24h window", async () => {
    const { env, home } = setupHome();
    const workspaceDir = mkTmp("muse-workspace-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const first = await maybeAutoPrune({ env, now, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(first.ran).toBe(true);
      expect(first.runs).toBeDefined();
      expect(first.checkpoints).toBeDefined();
      expect(first.actionLog).toBeDefined();
      expect(first.learnQueue).toBeDefined();

      // Same 24h window, a little later — gated, no-op.
      const second = await maybeAutoPrune({ env, now: now + 3 * 60 * 60 * 1000, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(second.ran).toBe(false);
      expect(second.reason).toContain("gated");

      // Past the 24h window — runs again.
      const third = await maybeAutoPrune({ env, now: now + 25 * 60 * 60 * 1000, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(third.ran).toBe(true);
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });

  it("a failing target (bad runs dir permissions simulated via a FILE instead of a dir) never blocks the other three", async () => {
    const { env, home } = setupHome();
    // Put a plain FILE at the runs-dir path — readdir on it throws ENOTDIR,
    // which pruneRunsByAge's own try/catch already tolerates by returning
    // an empty result. To actually exercise the orchestrator's per-target
    // isolation, point checkpoints at a path that collides similarly.
    const workspaceDir = mkTmp("muse-workspace-badtarget-");
    const runsDirCollision = join(workspaceDir, ".muse", "runs");
    mkdirSync(join(workspaceDir, ".muse"), { recursive: true });
    writeFileSync(runsDirCollision, "not a directory"); // readdir(this) throws ENOTDIR — exercised inside pruneRunsByAge already, but the ORCHESTRATOR must still complete
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const result = await maybeAutoPrune({ env, now, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(result.ran).toBe(true);
      // runs target degrades gracefully (readdir throws inside pruneRunsByAge's own catch → empty result), the other three still ran.
      expect(result.runs).toEqual({ dropped: 0, droppedFiles: [], kept: 0 });
      expect(result.checkpoints).toBeDefined();
      expect(result.actionLog).toBeDefined();
      expect(result.learnQueue).toBeDefined();
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });

  it("a target that genuinely throws (rotate collision) is caught+reported without blocking the other three", async () => {
    const { env, home } = setupHome();
    const workspaceDir = mkTmp("muse-workspace-realfail-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const actionLogFile = env.MUSE_ACTION_LOG_FILE!;
      mkdirSync(dirname(actionLogFile), { recursive: true });
      writeFileSync(actionLogFile, JSON.stringify({
        entries: [{ id: "a0", result: "performed", userId: "u", what: "x", when: new Date(now - 400 * DAY_MS).toISOString(), why: "y" }]
      }, null, 2));
      // Pre-occupy the archive rotation target as a DIRECTORY so `fs.rename(file, archivePath)`
      // inside pruneActionLogByAge throws for real (EISDIR/ENOTEMPTY), exercising the
      // orchestrator's safePrune catch rather than an internal graceful-degrade path.
      mkdirSync(`${actionLogFile}.archive-${now.toString()}.json`, { recursive: true });

      const result = await maybeAutoPrune({ env, now, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(result.ran).toBe(true);
      expect(result.actionLog).toHaveProperty("error");
      expect(result.runs).toBeDefined();
      expect(result.checkpoints).toBeDefined();
      expect(result.learnQueue).toBeDefined();
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });

  it("NEVER throws even when every target is pointed at an impossible path", async () => {
    const home = mkTmp("muse-home-allbad-");
    const metaFile = join(home, "nonexistent-parent", "deep", "prune-meta.json");
    const env: NodeJS.ProcessEnv = {
      MUSE_ACTION_LOG_FILE: "/dev/null/impossible/action-log.json",
      MUSE_CHECKPOINTS_DIR: "/dev/null/impossible/checkpoints",
      MUSE_LEARN_QUEUE_FILE: "/dev/null/impossible/learn-queue.jsonl",
      MUSE_PRUNE_META_FILE: metaFile
    };
    try {
      await expect(maybeAutoPrune({ env, now: Date.now(), workspaceDir: "/dev/null/impossible/workspace" })).resolves.toBeDefined();
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it("idempotent: running twice back-to-back past the gate with nothing new to prune is a safe no-op", async () => {
    const { env, home } = setupHome();
    const workspaceDir = mkTmp("muse-workspace-idem-");
    try {
      const now = Date.parse("2026-07-02T00:00:00Z");
      const first = await maybeAutoPrune({ env, minIntervalMs: 0, now, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      const second = await maybeAutoPrune({ env, minIntervalMs: 0, now: now + 1000, windows: DEFAULT_RETENTION_WINDOWS, workspaceDir });
      expect(first.ran).toBe(true);
      expect(second.ran).toBe(true);
      expect(second.runs).toEqual({ dropped: 0, droppedFiles: [], kept: 0 });
      expect(second.checkpoints).toEqual({ dropped: 0, droppedFiles: [], kept: 0 });
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(workspaceDir, { force: true, recursive: true });
    }
  });
});
