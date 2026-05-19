/**
 * `muse pattern` command group — visibility + control over the
 * pattern-detection track's outputs.
 *
 *   - `muse pattern list`   — run aggregator + both detectors NOW,
 *     show every cluster (audit mode; ignores cooldown, ignores
 *     `currentSlotOnly`). Useful for "what does Muse think it
 *     knows about my routine?".
 *   - `muse pattern fired`  — list the cooldown sidecar
 *     (`~/.muse/patterns-fired.json`), most-recent first. Lets
 *     the user audit "what did the daemon actually send me?".
 *   - `muse pattern reset`  — wipe the cooldown sidecar. After
 *     this, every detected pattern can re-fire on the next tick.
 *     Destructive — requires `--yes`.
 *
 * Detection runs are local (no network); writes are local + atomic.
 * No REST surface yet — same single-user contract as
 * `muse episode` / `muse followup`.
 */

import {
  aggregateActivitySignals,
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  type PatternMatch
} from "@muse/memory";
import {
  readPatternsFired,
  writePatternsFired,
  type PatternFiredRecord
} from "@muse/mcp";
import { resolvePatternsFiredFile } from "@muse/autoconfigure";
import type { Command } from "commander";

import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

interface SharedOptions {
  readonly json?: boolean;
}

function localPatternsFiredFile(): string {
  return resolvePatternsFiredFile(process.env as Record<string, string | undefined>);
}

export function registerPatternCommands(program: Command, io: ProgramIO): void {
  const pattern = program
    .command("pattern")
    .description("Pattern-detection audit + cooldown management");

  pattern
    .command("list")
    .description("Show every cluster the detectors find right now (ignores cooldown / current-slot)")
    .option("--limit <n>", "Max entries (default 20, cap 200)")
    .option("--min-confidence <n>", "Drop matches below this confidence (default 0 — show every cluster)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly limit?: string; readonly minConfidence?: string } & SharedOptions) => {
      const limit = parseLimit(options.limit, 20, 200);
      const minConfidence = parseConfidence(options.minConfidence, 0);
      const signals = await aggregateActivitySignals();
      const now = new Date();
      const tod = detectTimeOfDayPatterns(now, signals);
      const weekly = detectWeeklyTaskPatterns(now, signals);
      const all: PatternMatch[] = [...tod, ...weekly]
        .filter((m) => m.confidence >= minConfidence)
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, limit);
      const payload = {
        capturedAtMs: signals.capturedAtMs,
        patterns: all.map(serializePatternMatch),
        total: all.length
      };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(formatPatternList(all));
    });

  pattern
    .command("fired")
    .description("List the cooldown sidecar (~/.muse/patterns-fired.json), most-recent first")
    .option("--limit <n>", "Max entries (default 20, cap 200)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly limit?: string } & SharedOptions) => {
      const limit = parseLimit(options.limit, 20, 200);
      const records = await readPatternsFired(localPatternsFiredFile());
      const sorted = [...records]
        .sort((left, right) => right.firedAtMs - left.firedAtMs)
        .slice(0, limit);
      const payload = { fired: sorted, total: sorted.length };
      if (options.json) {
        io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      io.stdout(formatFiredList(sorted));
    });

  pattern
    .command("reset")
    .description("Wipe the cooldown sidecar — every pattern becomes eligible to re-fire on the next tick")
    .option("--yes", "Confirm destructive intent. Without this flag the command refuses.")
    .option("--json", "Print { cleared, removed } on success")
    .action(async (options: { readonly yes?: boolean } & SharedOptions) => {
      if (!options.yes) {
        throw new Error("Refusing to reset without --yes (next tick may re-fire patterns immediately — pass --yes to confirm)");
      }
      const file = localPatternsFiredFile();
      const before = await readPatternsFired(file);
      await writePatternsFired(file, []);
      if (options.json) {
        io.stdout(`${JSON.stringify({ cleared: true, removed: before.length }, null, 2)}\n`);
        return;
      }
      io.stdout(`Cleared ${before.length.toString()} cooldown record(s)\n`);
    });
}

// Absent flag → fallback. An explicitly-provided bad value
// rejects (per the strict-numeric line, goals 143/144/155)
// instead of silently masking the user's intent with the
// default.
export function parseLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(cap, Math.trunc(parsed));
}

export function parseConfidence(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`--min-confidence must be a number in [0, 1] (got '${raw}')`);
  }
  return parsed;
}

function serializePatternMatch(match: PatternMatch): Record<string, unknown> {
  // Keep both the diagnostic bucket and the user-facing fields; the
  // bucket shape differs per category so we leave it as the
  // discriminated union TypeScript already produced.
  return {
    category: match.category,
    confidence: match.confidence,
    id: match.id,
    suggestion: match.suggestion,
    ...(match.category === "time-of-day-action"
      ? { bucket: match.bucket, relatedPaths: match.relatedPaths }
      : { bucket: match.bucket, missingThisWeek: match.missingThisWeek, relatedTitles: match.relatedTitles })
  };
}

function formatPatternList(matches: readonly PatternMatch[]): string {
  if (matches.length === 0) {
    return "No patterns detected yet — keep using Muse and the detectors will find your routines.\n";
  }
  const lines = matches.map((match) => {
    const conf = match.confidence.toFixed(2);
    const id = match.id.slice(0, 12);
    return `[${id}] ${match.category} (conf=${conf}): ${match.suggestion}`;
  });
  return `${lines.join("\n")}\n`;
}

export function formatFiredList(records: readonly PatternFiredRecord[]): string {
  if (records.length === 0) {
    return "No patterns have fired yet.\n";
  }
  const lines = records.map((record) => {
    // A corrupt / partially-written firedAtMs (NaN, missing,
    // out-of-range) would make `.toISOString()` throw RangeError
    // and crash the whole listing — one bad record must not hide
    // every other fired pattern.
    const d = new Date(record.firedAtMs);
    const when = Number.isNaN(d.getTime()) ? "(unknown time)" : shortDateTime(d.toISOString());
    return `[${record.patternId.slice(0, 12)}] ${when}`;
  });
  return `${lines.join("\n")}\n`;
}
