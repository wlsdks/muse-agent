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
  detectLapsedPatterns,
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  predictUpcomingNeeds,
  type PatternMatch
} from "@muse/memory";
import { dismissPattern, readPatternsFired, writePatternsFired, type PatternFiredRecord } from "@muse/stores";
import { resolvePatternsFiredFile } from "@muse/autoconfigure";
import { dailyCounts, detectChangePoint, type ChangePoint, type DayCount } from "@muse/agent-core";
import type { Command } from "commander";

import { gatherActivityTimestamps } from "./commands-anomaly.js";
import { formatLocalDateTime as shortDateTime } from "./human-formatters.js";
import type { ProgramIO } from "./program.js";

interface SharedOptions {
  readonly json?: boolean;
}

/** Render the routine-shift readout. Pure. */
export function formatShift(shift: ChangePoint | null, days: readonly DayCount[]): string {
  if (days.length < 8) {
    return "🔀 Not enough history yet to spot a routine shift — keep using Muse for a couple of weeks.\n";
  }
  if (!shift) {
    return `🔀 No clear routine shift across your ${days.length.toString()}-day history — your rhythm's been steady.\n`;
  }
  const onDate = days[shift.index]?.date ?? "?";
  const verb = shift.direction === "up" ? "picked up" : "dropped off";
  return (
    `🔀 Your activity ${verb} around ${onDate} — from about ${shift.beforeMean.toFixed(1)}/day to ${shift.afterMean.toFixed(1)}/day ` +
    `(${shift.magnitude.toFixed(1)}σ shift).\n`
  );
}

function localPatternsFiredFile(): string {
  return resolvePatternsFiredFile(process.env);
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
    .command("shifts")
    .description("Detect WHEN your routine changed regime — the onset of a new normal in your activity (local, draft-first)")
    .option("--json", "Print the raw change-point")
    .action(async (options: SharedOptions) => {
      const days = dailyCounts(await gatherActivityTimestamps(process.env));
      const shift = days.length >= 8 ? detectChangePoint(days.map((day) => day.count)) : null;
      if (options.json) {
        io.stdout(`${JSON.stringify({ days: days.length, shift, shiftDate: shift ? days[shift.index]?.date : undefined }, null, 2)}\n`);
        return;
      }
      io.stdout(formatShift(shift, days));
    });

  pattern
    .command("upcoming")
    .description("Anticipate your RECURRING needs BEFORE they arrive — patterns whose next occurrence lands within a lead window, soonest first (allostatic prediction). `pattern list` shows every cluster; this shows what's COMING UP.")
    .option("--within <hours>", "Lead window in hours (default 48)")
    .option("--min-confidence <n>", "Drop predictions below this confidence (default 0.6)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly within?: string; readonly minConfidence?: string } & SharedOptions) => {
      const withinHours = options.within !== undefined && Number.isFinite(Number(options.within)) && Number(options.within) > 0 ? Number(options.within) : 48;
      const minConfidence = parseConfidence(options.minConfidence, 0.6);
      const signals = await aggregateActivitySignals();
      const predicted = predictUpcomingNeeds(new Date(), signals, { leadWindowMs: withinHours * 3_600_000, minConfidence });
      if (options.json) {
        io.stdout(`${JSON.stringify({ predicted: predicted.map((need) => ({ ...need, predictedAtIso: new Date(need.predictedAtMs).toISOString() })), total: predicted.length }, null, 2)}\n`);
        return;
      }
      if (predicted.length === 0) {
        io.stdout(`Nothing recurring coming up in the next ${withinHours.toString()}h. (Patterns build as you use Muse; see all clusters with \`muse pattern list\`.)\n`);
        return;
      }
      io.stdout(`Coming up (recurring, next ${withinHours.toString()}h):\n`);
      for (const need of predicted) {
        const when = new Date(need.predictedAtMs).toLocaleString("en-US", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short", weekday: "short" });
        io.stdout(`  🔮 ${need.label}  — ${when} (confidence ${(need.confidence * 100).toFixed(0)}%)\n`);
      }
    });

  pattern
    .command("lapsed")
    .description("Notice a recurring habit you've STOPPED — an established weekly pattern with a sustained run of missed occurrences (CUSUM change-point detection), the mirror of `pattern upcoming`. Read-only.")
    .option("--missed <n>", "Minimum consecutive missed weekly cycles to flag a lapse (default 2)")
    .option("--min-confidence <n>", "Drop patterns below this confidence (default 0.5)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly missed?: string; readonly minConfidence?: string } & SharedOptions) => {
      const minCyclesMissed = options.missed !== undefined && Number.isFinite(Number(options.missed)) && Number(options.missed) >= 1 ? Math.trunc(Number(options.missed)) : 2;
      const minConfidence = parseConfidence(options.minConfidence, 0.5);
      const signals = await aggregateActivitySignals();
      const lapsed = detectLapsedPatterns(new Date(), signals, { minConfidence, minCyclesMissed });
      if (options.json) {
        io.stdout(`${JSON.stringify({ lapsed: lapsed.map((entry) => ({ ...entry, lastSeenIso: new Date(entry.lastSeenMs).toISOString() })), total: lapsed.length }, null, 2)}\n`);
        return;
      }
      if (lapsed.length === 0) {
        io.stdout("No lapsed habits — your recurring patterns are on track. (See active ones with `muse pattern list` / `muse pattern upcoming`.)\n");
        return;
      }
      io.stdout("Habits you may have lapsed:\n");
      for (const entry of lapsed) {
        const last = new Date(entry.lastSeenMs).toLocaleDateString("en-US", { day: "numeric", month: "short", weekday: "short" });
        io.stdout(`  💤 ${entry.label}  — last seen ${last}, ${entry.cyclesMissed.toString()} cycle(s) ago\n`);
      }
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
      // Preserve dismissals — they're learned avoidance ("stop suggesting
      // this"), not a time-bounded cooldown, so a cooldown reset must not
      // resurrect a pattern the user explicitly silenced.
      const kept = before.filter((record) => record.dismissed === true);
      await writePatternsFired(file, kept);
      if (options.json) {
        io.stdout(`${JSON.stringify({ cleared: true, keptDismissals: kept.length, removed: before.length - kept.length }, null, 2)}\n`);
        return;
      }
      io.stdout(`Cleared ${(before.length - kept.length).toString()} cooldown record(s)${kept.length > 0 ? `, kept ${kept.length.toString()} dismissal(s)` : ""}\n`);
    });

  pattern
    .command("dismiss")
    .description("Stop Muse from suggesting a pattern again (learned avoidance — survives `reset`)")
    .argument("<id>", "Pattern id from `muse pattern list` / `fired`")
    .option("--json", "Print { dismissed, id } on success")
    .action(async (id: string, options: SharedOptions) => {
      const trimmed = id.trim();
      if (trimmed.length === 0) {
        throw new Error("dismiss needs a pattern id (see `muse pattern list`)");
      }
      await dismissPattern(localPatternsFiredFile(), trimmed, Date.now());
      if (options.json) {
        io.stdout(`${JSON.stringify({ dismissed: true, id: trimmed }, null, 2)}\n`);
        return;
      }
      io.stdout(`Dismissed pattern ${trimmed} — Muse won't suggest it again.\n`);
    });

  pattern
    .command("dismissed")
    .description("List patterns you've dismissed (Muse won't suggest these)")
    .option("--json", "Print the raw payload")
    .action(async (options: SharedOptions) => {
      const records = await readPatternsFired(localPatternsFiredFile());
      const dismissed = records.filter((record) => record.dismissed === true);
      if (options.json) {
        io.stdout(`${JSON.stringify({ dismissed, total: dismissed.length }, null, 2)}\n`);
        return;
      }
      if (dismissed.length === 0) {
        io.stdout("No dismissed patterns.\n");
        return;
      }
      io.stdout(`Dismissed patterns (${dismissed.length.toString()}):\n`);
      for (const record of dismissed) io.stdout(`  • ${record.patternId}\n`);
    });
}

// Absent flag → fallback. An explicitly-provided bad value
// rejects (per the strict-numeric line)
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
