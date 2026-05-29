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

import {
  computeTrustScore,
  readTrustLedger,
  recordOutcome,
  type ProactiveOutcome,
  type TrustLedgerEntry
} from "@muse/mcp";
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
  if (score.precision === null) {
    lines.push("  No proactive notices yet — nothing surfaced, nothing to score.");
    lines.push("  Once Muse surfaces a due item, it's logged here and you can keep or veto it.");
    return lines.join("\n");
  }
  const pct = Math.round(score.precision * 100);
  lines.push(`  Surfaced: ${score.surfaced.toString()}   Kept: ${score.kept.toString()}   Acted: ${score.acted.toString()}   Vetoed: ${score.vetoed.toString()}`);
  lines.push(`  Precision: ${pct.toString()}% — of what Muse said unasked, you didn't reject ${pct.toString()}%.\n`);
  lines.push("Recent (most recent first):");
  const recent = [...entries].sort((a, b) => b.surfacedAtMs - a.surfacedAtMs).slice(0, limit);
  for (const e of recent) {
    const mark = OUTCOME_MARK[e.outcome ?? "none"].padEnd(9);
    lines.push(`  ${mark} ${e.sourceKey.padEnd(22)} ${fmtTime(e.surfacedAtMs)}  ${e.title}`);
  }
  lines.push("\nSilence a source you don't want:  muse proactive veto <source>");
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
      .command(`${verb} <source>`)
      .description(blurb)
      .action(async (source: string) => {
        const key = source.trim();
        if (key.length === 0) {
          io.stderr("Provide a source key, e.g. `muse proactive veto calendar:evt-42` (see `muse proactive scoreboard`).\n");
          process.exitCode = 1;
          return;
        }
        const res = await recordOutcome(trustLedgerFile(), key, outcome, Date.now());
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
