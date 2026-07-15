/**
 * DS-13 — idempotent, interval-gated age-based retention pruner for Muse's
 * unbounded append-only LOCAL state. Four targets, each with its own shape:
 *
 *   - `.muse/runs/*.jsonl`        workspace-local run-log traces, one file
 *                                 per run (read by `muse trace` / `readLocalRuns`).
 *   - `.muse/checkpoints/*.json`  per-run checkpoint file (`FileCheckpointStore`,
 *                                 which already caps by COUNT — this adds an
 *                                 AGE cap on top, since a low-volume workspace
 *                                 never hits the count cap but old checkpoints
 *                                 should still retire).
 *   - `~/.muse/action-log.json`   the tamper-evident action-log audit trail
 *                                 (`@muse/stores` — pruned by whole-file
 *                                 archival rotation, never deletion; see
 *                                 `pruneActionLogByAge`'s doc comment for why).
 *   - `~/.muse/learn-queue.jsonl` the self-learning correction queue
 *                                 (`@muse/stores` — defensive cap in case the
 *                                 idle distiller never drains it).
 *
 * `maybeAutoPrune()` is the orchestrator: gated by a persisted "last pruned
 * at" marker (`~/.muse/prune-meta.json` by default) so repeated calls across
 * process restarts stay a cheap no-op inside the window (default 24h).
 * NEVER throws — each target prunes independently behind its own try/catch
 * so one bad target (a locked file, a permissions error, a malformed store)
 * can't block the other three.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MuseEnvironment } from "@muse/autoconfigure";
import { resolveActionLogFile, resolveCheckpointsDir } from "@muse/autoconfigure";
import { pruneActionLogByAge, pruneByAge, pruneLearnQueueByAge, resolveLearnQueueFile, type ActionLogPruneResult } from "@muse/stores";
import { isRecord } from "@muse/shared";
import { withBestEffort } from "./async-promises.js";

export interface RetentionWindows {
  /** `.muse/runs/*.jsonl` — default 90 days (mirrors the checkpoints window; a trace's diagnostic value fades fast). */
  readonly runsAgeDays: number;
  /** `.muse/checkpoints/*.json` — default 90 days (resume-from-crash only matters for a recent run). */
  readonly checkpointsAgeDays: number;
  /** `~/.muse/action-log.json` — default 365 days: a longer window since it's the lighter, structured accountability trail, not a bulky trace. */
  readonly actionLogAgeDays: number;
  /** `~/.muse/learn-queue.jsonl` — default 30 days: a stale unconsumed correction is no longer a useful learning signal. */
  readonly learnQueueAgeDays: number;
}

export const DEFAULT_RETENTION_WINDOWS: RetentionWindows = {
  actionLogAgeDays: 365,
  checkpointsAgeDays: 90,
  learnQueueAgeDays: 30,
  runsAgeDays: 90
};

/** Re-running within this window is a no-op — the gate `maybeAutoPrune` enforces via the persisted marker. */
export const DEFAULT_MIN_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function resolvePruneMetaFile(env: NodeJS.ProcessEnv): string {
  const override = env.MUSE_PRUNE_META_FILE?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".muse", "prune-meta.json");
}

interface PruneMeta {
  readonly lastPrunedAtMs?: number;
}

async function readPruneMeta(file: string): Promise<PruneMeta> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as PruneMeta).lastPrunedAtMs === "number") {
      return parsed as PruneMeta;
    }
  } catch {
    /* missing / corrupt marker reads as "never pruned" — the safe default (prunes now) */
  }
  return {};
}

async function writePruneMeta(file: string, meta: PruneMeta): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export interface FilePruneResult {
  readonly kept: number;
  readonly dropped: number;
  readonly droppedFiles: readonly string[];
}

/** Parse the last event's `recordedAt` out of a run-log JSONL file (mirrors `readLocalRuns`'s "last event wins" contract). Falls back to the file's mtime when the content is missing/unparseable so a legacy or partially-written trace still ages out. */
async function runFileTimestampMs(path: string, fallbackMtimeMs: number): Promise<number> {
    try {
      const raw = await readFile(path, "utf8");
      const lines = raw.trim().split("\n").filter((l) => l.trim().length > 0);
      const last = lines[lines.length - 1];
      if (last) {
      const event = JSON.parse(last);
      const ms = isRecord(event) && typeof event.recordedAt === "string" ? Date.parse(event.recordedAt) : NaN;
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    /* fall through to mtime */
  }
  return fallbackMtimeMs;
}

/** Delete `.muse/runs/*.jsonl` files whose last-recorded event is older than `ageDays`. Missing dir ⇒ no-op. */
export async function pruneRunsByAge(runsDir: string, options: { readonly ageDays: number; readonly now?: number }): Promise<FilePruneResult> {
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return { dropped: 0, droppedFiles: [], kept: 0 };
  }
  const withTimestamps = await Promise.all(names.map(async (name) => {
    const full = join(runsDir, name);
    const mtimeMs = await withBestEffort(stat(full).then((s) => s.mtimeMs), now);
    return { name, ts: await runFileTimestampMs(full, mtimeMs) };
  }));
  const { kept, dropped } = pruneByAge(withTimestamps, { ageDays: options.ageDays, now, timestampOf: (e) => e.ts });
  await Promise.all(dropped.map((e) => withBestEffort(rm(join(runsDir, e.name), { force: true }), undefined)));
  return { dropped: dropped.length, droppedFiles: dropped.map((e) => e.name), kept: kept.length };
}

/** Delete `.muse/checkpoints/*.json` files whose mtime is older than `ageDays`. Complements `FileCheckpointStore`'s own COUNT-based cap with an AGE-based one. Missing dir ⇒ no-op. */
export async function pruneCheckpointsByAge(checkpointsDir: string, options: { readonly ageDays: number; readonly now?: number }): Promise<FilePruneResult> {
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = (await readdir(checkpointsDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return { dropped: 0, droppedFiles: [], kept: 0 };
  }
  const withTimestamps = await Promise.all(names.map(async (name) => {
    const mtimeMs = await withBestEffort(stat(join(checkpointsDir, name)).then((s) => s.mtimeMs), now);
    return { mtimeMs, name };
  }));
  const { kept, dropped } = pruneByAge(withTimestamps, { ageDays: options.ageDays, now, timestampOf: (e) => e.mtimeMs });
  await Promise.all(dropped.map((e) => withBestEffort(rm(join(checkpointsDir, e.name), { force: true }), undefined)));
  return { dropped: dropped.length, droppedFiles: dropped.map((e) => e.name), kept: kept.length };
}

async function safePrune<T>(fn: () => Promise<T>): Promise<T | { readonly error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface MaybeAutoPruneOptions {
  /** Workspace root for the `.muse/runs` target; defaults to `process.cwd()`. */
  readonly workspaceDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Fixed "now" for deterministic tests; defaults to `Date.now()`. */
  readonly now?: number;
  /** Override the 24h re-run gate (tests use a small value). */
  readonly minIntervalMs?: number;
  readonly windows?: Partial<RetentionWindows>;
  /** Override the persisted gate marker path (tests use a tempdir file). */
  readonly metaFile?: string;
}

export interface MaybeAutoPruneSummary {
  readonly ran: boolean;
  readonly reason: string;
  readonly runs?: FilePruneResult | { readonly error: string };
  readonly checkpoints?: FilePruneResult | { readonly error: string };
  readonly actionLog?: ActionLogPruneResult | { readonly error: string };
  readonly learnQueue?: { readonly kept: number; readonly dropped: number } | { readonly error: string };
}

/**
 * The orchestrator: skip entirely if pruned within `minIntervalMs` (default
 * 24h), else run all four target prunes — each independently guarded so a
 * single failing target never blocks the others or throws into the caller
 * (this runs unattended on a daemon tick). Updates the persisted marker only
 * after the attempt, so a fully-failed run (all four targets errored) still
 * retries next time rather than being silently gated out for 24h.
 */
export async function maybeAutoPrune(options: MaybeAutoPruneOptions = {}): Promise<MaybeAutoPruneSummary> {
  try {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_PRUNE_INTERVAL_MS;
    const metaFile = options.metaFile ?? resolvePruneMetaFile(env);

    const meta = await readPruneMeta(metaFile);
    if (meta.lastPrunedAtMs !== undefined && now - meta.lastPrunedAtMs < minIntervalMs) {
      const hoursAgo = ((now - meta.lastPrunedAtMs) / 3_600_000).toFixed(1);
      const windowHours = (minIntervalMs / 3_600_000).toFixed(0);
      return { ran: false, reason: `gated — last pruned ${hoursAgo}h ago, window is ${windowHours}h` };
    }

    const windows: RetentionWindows = { ...DEFAULT_RETENTION_WINDOWS, ...options.windows };
    const workspaceDir = options.workspaceDir ?? process.cwd();

    const runs = await safePrune(() => pruneRunsByAge(join(workspaceDir, ".muse", "runs"), { ageDays: windows.runsAgeDays, now }));
    const checkpoints = await safePrune(() => pruneCheckpointsByAge(resolveCheckpointsDir(env), { ageDays: windows.checkpointsAgeDays, now }));
    const actionLog = await safePrune(() => pruneActionLogByAge(resolveActionLogFile(env), { ageDays: windows.actionLogAgeDays, now }, env));
    const learnQueue = await safePrune(() => pruneLearnQueueByAge(resolveLearnQueueFile(env), { ageDays: windows.learnQueueAgeDays, now }));

    try {
      await writePruneMeta(metaFile, { lastPrunedAtMs: now });
    } catch {
      /* marker write failed — next tick just retries a bit early; never blocks the prune result */
    }

    return { actionLog, checkpoints, learnQueue, ran: true, reason: "retention window elapsed — pruned all targets", runs };
  } catch (err) {
    // Final backstop: even a bug in the gate/meta logic itself (not just an
    // individual target) must never throw into the caller.
    return { ran: false, reason: `prune orchestrator error (ignored): ${err instanceof Error ? err.message : String(err)}` };
  }
}
