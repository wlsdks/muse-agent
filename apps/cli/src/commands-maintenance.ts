/**
 * `muse maintenance compact` rotates the rotated archive
 * sidecars (`proactive-history.json.1`, `.2`, …) into
 * `~/.muse/archive/<basename>.<n>.<iso>.json.gz` so disk usage
 * stays bounded over time without losing audit data.
 *
 * Scope:
 *   - Walks the `~/.muse/` directory for `*.json.<n>` siblings
 *     of well-known stores (`proactive-history`; extensible by
 *     env).
 *   - Optional `--keep-days N` filter — only files older than
 *     N days are compacted (default: compact every numbered
 *     archive, regardless of age).
 *   - Writes the gz archive under `~/.muse/archive/`, then
 *     unlinks the source. Atomic: a partial-write doesn't
 *     leave both copies behind because we gz to a `.tmp`
 *     sibling and rename on success.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { Command } from "commander";
import { isRecord } from "@muse/shared";

import { parseBoundedInt } from "./parse-bounded-int.js";
import { activityPath } from "./commands-routine.js";
import type { ProgramIO } from "./program.js";

/**
 * Store basenames whose `<name>.json.<n>` rotations the compaction
 * sweep recognizes. Starts narrow so the sweep doesn't accidentally
 * consume unrelated files an operator dropped in `~/.muse/`. New
 * rotating sidecars append here.
 *
 * Exported for direct test coverage.
 */
export const COMPACTABLE_STORE_BASENAMES: readonly string[] = [
  "proactive-history.json",
  "reminder-history.json"
];

interface MaintenanceCompactOptions {
  readonly keepDays?: string;
  readonly museDir?: string;
  readonly archiveDir?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface CompactPlanEntry {
  readonly source: string;
  readonly destination: string;
  readonly mtimeMs: number;
}

/**
 * Pure planner — given the `~/.muse/` contents + a keep-days
 * filter, return the list of archive files to compact and where
 * each lands. Exported for direct unit testing so the gz
 * pipeline doesn't have to fire in the test path.
 */
export async function planActivityLogCompaction(args: {
  readonly museDir: string;
  readonly archiveDir: string;
  readonly nowMs: number;
  readonly keepDays?: number;
}): Promise<readonly CompactPlanEntry[]> {
  const entries: CompactPlanEntry[] = [];
  let dirContents: readonly string[];
  try {
    dirContents = await readdir(args.museDir);
  } catch {
    return entries;
  }
  const cutoffMs = typeof args.keepDays === "number" && args.keepDays > 0
    ? args.nowMs - args.keepDays * 24 * 60 * 60 * 1000
    : undefined;
  for (const name of dirContents) {
    // Match `<baseStore>.<n>` where baseStore is on the allow-list
    // and n is a positive integer. Anything else (regular JSON
    // files, temp scratch, unrelated sidecars) is skipped.
    if (!/^[A-Za-z0-9._-]+\.json\.\d+$/u.test(name)) continue;
    const baseStore = name.replace(/\.\d+$/u, "");
    if (!COMPACTABLE_STORE_BASENAMES.includes(baseStore)) continue;
    const source = join(args.museDir, name);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(source);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (cutoffMs !== undefined && st.mtimeMs > cutoffMs) continue;
    const stamp = new Date(st.mtimeMs).toISOString().replace(/[:.]/g, "-");
    const destination = join(args.archiveDir, `${name}.${stamp}.gz`);
    entries.push({ source, destination, mtimeMs: st.mtimeMs });
  }
  return entries;
}

async function gzCompact(source: string, destination: string): Promise<void> {
  const tmp = `${destination}.tmp`;
  await pipeline(createReadStream(source), createGzip(), createWriteStream(tmp, { mode: 0o600 }));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, destination);
}

export interface ActivityPrunePlan {
  readonly keptLines: readonly string[];
  readonly kept: number;
  readonly dropped: number;
}

/**
 * Generic retention planner for a timestamped append-only log: keep
 * lines whose extracted timestamp parses AND falls within the last
 * `keepDays`; drop older lines plus undateable ones (a line we can't
 * date can't be justified as in-window, and consumers already skip
 * malformed input — keeping it would just bloat the file the prune
 * exists to bound). `extractTsMs` returns the line's epoch-ms or
 * `NaN`. Pure over the raw lines so the rewrite is testable.
 */
export function planTimestampedLinePrune(
  lines: readonly string[],
  nowMs: number,
  keepDays: number,
  extractTsMs: (line: string) => number
): ActivityPrunePlan {
  const cutoffMs = nowMs - Math.max(0, keepDays) * 24 * 60 * 60 * 1000;
  const keptLines: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const ts = extractTsMs(line);
    if (Number.isFinite(ts) && ts >= cutoffMs) {
      keptLines.push(line);
    } else {
      dropped += 1;
    }
  }
  return { dropped, kept: keptLines.length, keptLines };
}

/**
 * `activity.jsonl` retention — each line is a JSON object carrying a
 * `tsIso`. Thin wrapper over {@link planTimestampedLinePrune}.
 * Exported for direct coverage.
 */
export function planActivityPrune(lines: readonly string[], nowMs: number, keepDays: number): ActivityPrunePlan {
  return planTimestampedLinePrune(lines, nowMs, keepDays, (line) => {
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed) && typeof parsed.tsIso === "string") {
        return Date.parse(parsed.tsIso);
      }
    } catch { /* malformed → undateable */ }
    return Number.NaN;
  });
}

/**
 * `notifications.log` retention — each line is `[<ISO>] (<dest>)
 * <text>`; extract the leading bracketed ISO. Exported for coverage.
 */
export function planNotificationLogPrune(lines: readonly string[], nowMs: number, keepDays: number): ActivityPrunePlan {
  return planTimestampedLinePrune(lines, nowMs, keepDays, (line) => {
    const match = /^\[([^\]]+)\]/u.exec(line);
    return match ? Date.parse(match[1]!) : Number.NaN;
  });
}

export function registerMaintenanceCommand(program: Command, io: ProgramIO): void {
  const maintenance = program.command("maintenance").description("Housekeeping for ~/.muse archives");

  maintenance
    .command("compact")
    .description("Rotate numbered archive sidecars (proactive-history.json.<n>, …) into ~/.muse/archive/*.gz")
    .option("--keep-days <n>", "Only compact archives older than N days (default: compact every numbered archive)")
    .option("--dry-run", "Print the plan without touching disk")
    .option("--json", "Emit a structured summary instead of a formatted list")
    .action(async (options: MaintenanceCompactOptions) => {
      const museDir = options.museDir ?? join(homedir(), ".muse");
      const archiveDir = options.archiveDir ?? join(museDir, "archive");
      // strict Number() so a "7d" unit-slip rejects instead of
      // silently becoming 7.
      const keepDays = options.keepDays !== undefined
        ? Number(options.keepDays.trim())
        : undefined;
      if (keepDays !== undefined && (!Number.isFinite(keepDays) || keepDays < 0)) {
        io.stderr(`--keep-days must be a non-negative number (got '${options.keepDays ?? ""}')\n`);
        process.exitCode = 1;
        return;
      }
      const plan = await planActivityLogCompaction({
        museDir,
        archiveDir,
        nowMs: Date.now(),
        ...(keepDays !== undefined ? { keepDays } : {})
      });
      if (plan.length === 0) {
        if (options.json) {
          io.stdout(`${JSON.stringify({ compacted: 0, plan: [] }, null, 2)}\n`);
        } else {
          io.stdout("(no archive sidecars match the compaction criteria)\n");
        }
        return;
      }
      if (options.dryRun) {
        if (options.json) {
          io.stdout(`${JSON.stringify({ dryRun: true, plan }, null, 2)}\n`);
          return;
        }
        for (const entry of plan) {
          io.stdout(`would compact ${basename(entry.source)} → ${entry.destination}\n`);
        }
        return;
      }
      await mkdir(archiveDir, { recursive: true });
      let compacted = 0;
      for (const entry of plan) {
        try {
          await gzCompact(entry.source, entry.destination);
          await unlink(entry.source);
          compacted += 1;
        } catch (cause) {
          io.stderr(`failed to compact ${entry.source}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        }
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ compacted, plan }, null, 2)}\n`);
      } else {
        io.stdout(`Compacted ${compacted.toString()} / ${plan.length.toString()} archive(s) into ${archiveDir}\n`);
      }
    });

  // Shared read → plan → atomic-rewrite for the by-date line-retention
  // prunes (activity.jsonl / notifications.log): identical flow, only
  // the path + per-line timestamp extractor differ. Atomic
  // tmp+rename, 0o600 (matching the writers).
  const runFilePrune = async (
    file: string,
    keepDays: number,
    planner: (lines: readonly string[], nowMs: number, keepDays: number) => ActivityPrunePlan,
    options: { readonly dryRun?: boolean; readonly json?: boolean },
    missingLine: string
  ): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        io.stdout(options.json ? `${JSON.stringify({ dropped: 0, file, kept: 0 }, null, 2)}\n` : `${missingLine}\n`);
        return;
      }
      throw cause;
    }
    const plan = planner(raw.split("\n"), Date.now(), keepDays);
    const total = plan.kept + plan.dropped;
    if (options.dryRun) {
      io.stdout(options.json
        ? `${JSON.stringify({ dropped: plan.dropped, dryRun: true, keepDays, kept: plan.kept }, null, 2)}\n`
        : `would drop ${plan.dropped.toString()} of ${total.toString()} line(s), keep ${plan.kept.toString()} (last ${keepDays.toString()}d)\n`);
      return;
    }
    if (plan.dropped === 0) {
      io.stdout(options.json
        ? `${JSON.stringify({ dropped: 0, keepDays, kept: plan.kept }, null, 2)}\n`
        : `Nothing to prune — all ${plan.kept.toString()} line(s) are within ${keepDays.toString()}d.\n`);
      return;
    }
    const tmp = `${file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    const body = plan.keptLines.length > 0 ? `${plan.keptLines.join("\n")}\n` : "";
    await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
    io.stdout(options.json
      ? `${JSON.stringify({ dropped: plan.dropped, keepDays, kept: plan.kept }, null, 2)}\n`
      : `Pruned ${plan.dropped.toString()} line(s); kept ${plan.kept.toString()} (last ${keepDays.toString()}d) in ${file}\n`);
  };

  maintenance
    .command("prune-activity")
    .description("Trim ~/.muse/activity.jsonl to the last N days — it's append-only (one line per chat/ask/status) and otherwise grows unbounded")
    .option("--keep-days <n>", "Retention window in days (default 365 — matches `muse routine`'s max lookback)", "365")
    .option("--dry-run", "Report how many lines would be dropped without rewriting the file")
    .option("--json", "Emit a structured summary instead of a formatted line")
    .action(async (options: { readonly keepDays?: string; readonly dryRun?: boolean; readonly json?: boolean }) => {
      const keepDays = parseBoundedInt(options.keepDays, "--keep-days", 1, 3650, 365);
      await runFilePrune(activityPath(), keepDays, planActivityPrune, options, `(no activity log at ${activityPath()} yet)`);
    });

  maintenance
    .command("prune-log")
    .description("Trim ~/.muse/notifications.log to the last N days — the `log` messaging sink (default for token-less proactive delivery) is append-only and otherwise grows unbounded")
    .option("--keep-days <n>", "Retention window in days (default 90)", "90")
    .option("--dry-run", "Report how many lines would be dropped without rewriting the file")
    .option("--json", "Emit a structured summary instead of a formatted line")
    .action(async (options: { readonly keepDays?: string; readonly dryRun?: boolean; readonly json?: boolean }) => {
      const keepDays = parseBoundedInt(options.keepDays, "--keep-days", 1, 3650, 90);
      const file = notificationLogPath();
      await runFilePrune(file, keepDays, planNotificationLogPrune, options, `(no notification log at ${file} yet)`);
    });
}

function notificationLogPath(): string {
  const raw = process.env.MUSE_MESSAGING_LOG_FILE?.trim();
  return raw && raw.length > 0 ? raw : join(homedir(), ".muse", "notifications.log");
}
