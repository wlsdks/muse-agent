/**
 * `muse proactive scoreboard | veto | keep | acted` — the proactivity trust
 * scoreboard (Phase 2 of docs/strategy/identity.md). Distinct from `muse trust`
 * (per-user TOOL trust): this measures whether Muse's UNASKED notices earn
 * their place. It shows precision (how much of what Muse surfaced you kept vs.
 * rejected), lists recent surfaces, and lets you veto a source with one command
 * so it's silenced forever (learned avoidance). Proactivity earns its place by
 * being measurable + muteable, not by hoping it isn't annoying.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { computeTrustScore, readTrustLedger, recordLatestOutcome, recordOutcome, type ProactiveOutcome, type TrustLedgerEntry } from "@muse/stores";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

function trustLedgerFile(): string {
  return process.env.MUSE_PROACTIVE_TRUST_FILE?.trim() || join(homedir(), ".muse", "proactive-trust.json");
}

function fmtTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

const OUTCOME_MARK: Record<ProactiveOutcome | "none", string> = {
  acted: "✓ acted",
  kept: "✓ kept",
  none: "·",
  vetoed: "✗ vetoed"
};

export function renderTrustScoreboard(entries: readonly TrustLedgerEntry[], limit = 12): string {
  const score = computeTrustScore(entries);
  const lines = ["Muse — proactive trust scoreboard\n"];
  const mutedAhead = entries.filter((e) => e.recordedWithoutSurface === true && e.outcome === "vetoed");
  if (score.precision === null) {
    lines.push("  No proactive notices yet — nothing surfaced, nothing to score.");
    lines.push("  Once Muse surfaces a due item, rate it without copying a key: muse proactive keep latest.");
    if (mutedAhead.length > 0) {
      lines.push(`\n  Muted ahead of time (never surfaced): ${mutedAhead.map((e) => e.sourceKey).join(", ")}`);
    }
    return lines.join("\n");
  }
  const pct = Math.round(score.precision * 100);
  lines.push(`  Surfaced: ${score.surfaced.toString()}   Kept: ${score.kept.toString()}   Acted: ${score.acted.toString()}   Vetoed: ${score.vetoed.toString()}`);
  lines.push(`  Precision: ${pct.toString()}% — of what Muse said unasked, you didn't reject ${pct.toString()}%.\n`);
  lines.push("Recent (most recent first):");
  const surfaces = entries.filter((e) => e.recordedWithoutSurface !== true);
  const recent = [...surfaces].sort((a, b) => b.surfacedAtMs - a.surfacedAtMs).slice(0, limit);
  for (const e of recent) {
    const mark = OUTCOME_MARK[e.outcome ?? "none"].padEnd(9);
    lines.push(`  ${mark} ${e.sourceKey.padEnd(22)} ${fmtTime(e.surfacedAtMs)}  ${e.title}`);
  }
  // Pre-emptively muted sources never surfaced — shown separately so they
  // don't masquerade as surfaced notices in the precision view.
  if (mutedAhead.length > 0) {
    lines.push(`\nMuted ahead of time (never surfaced): ${mutedAhead.map((e) => e.sourceKey).join(", ")}`);
  }
  lines.push("\nRate the latest unrated surface:  muse proactive acted|keep|veto latest");
  lines.push("Silence a source you don't want:  muse proactive veto <source>");
  lines.push("Mark one useful:                  muse proactive keep <source>");
  return lines.join("\n");
}

export function registerProactiveTrustSubcommands(proactive: Command, io: ProgramIO): void {
  proactive
    .command("scoreboard")
    .description("Trust scoreboard — what Muse surfaced unasked, and your kept/vetoed precision")
    .option("--json", "Print the raw ledger + score")
    .action(async (options: { readonly json?: boolean }) => {
      const entries = await readTrustLedger(trustLedgerFile());
      if (options.json) {
        io.stdout(`${JSON.stringify({ entries, score: computeTrustScore(entries) }, null, 2)}\n`);
        return;
      }
      io.stdout(`${renderTrustScoreboard(entries)}\n`);
    });

  const rate = (verb: string, outcome: ProactiveOutcome, blurb: string): void => {
    proactive
      .command(`${verb} <source|latest>`)
      .description(`${blurb}; use 'latest' for the latest unrated surface`)
      .action(async (source: string) => {
        const requestedSource = source.trim();
        if (requestedSource.length === 0) {
          io.stderr("Provide a source key, e.g. `muse proactive veto calendar:evt-42` (see `muse proactive scoreboard`).\n");
          process.exitCode = 1;
          return;
        }
        const ledgerFile = trustLedgerFile();
        const latestResult = requestedSource === "latest"
          ? await recordLatestOutcome(ledgerFile, outcome, Date.now())
          : undefined;
        if (requestedSource === "latest" && latestResult === undefined) {
          io.stderr("No unrated proactive surface is available (see `muse proactive scoreboard`).\n");
          process.exitCode = 1;
          return;
        }
        const key = latestResult?.sourceKey ?? requestedSource;
        const res = latestResult === undefined
          ? await recordOutcome(ledgerFile, key, outcome, Date.now())
          : { matched: true, title: latestResult.title };
        const note = outcome === "vetoed"
          ? `🔕 Silenced ${key} — Muse won't surface "${res.title}" again.`
          : `👍 Marked ${key} as ${outcome} ("${res.title}").`;
        io.stdout(`${note}${res.matched ? "" : " (no prior surface on record — remembered anyway)"}\n`);
      });
  };
  rate("veto", "vetoed", "Silence a proactive source forever (learned avoidance)");
  rate("keep", "kept", "Mark a surfaced notice as one you wanted");
  rate("acted", "acted", "Mark a surfaced notice as one you acted on");
}
