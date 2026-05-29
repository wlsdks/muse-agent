/**
 * `muse commitments` — surface open loops the user voiced in chat
 * ("I need to email Bob", "내일 자료 준비해야 해") that never became a
 * formal task or reminder. Read-only over `last-chat.jsonl`; the
 * detection is the deterministic, rule-only `detectUserCommitments`.
 */

import { detectUserCommitments } from "@muse/agent-core";
import type { Command } from "commander";

import { readLastChatHistory } from "./chat-history.js";
import type { ProgramIO } from "./program.js";

export function clampScanLimit(raw: string | undefined, fallback: number, cap: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit must be a positive number (got '${raw}')`);
  }
  return Math.min(cap, Math.trunc(parsed));
}

export function registerCommitmentsCommands(program: Command, io: ProgramIO): void {
  const commitments = program
    .command("commitments")
    .description("Open loops you voiced in chat that never became a task or reminder");

  commitments
    .command("scan")
    .description("Scan recent chat for things you said you'd do (\"I need to …\", \"~해야 해\")")
    .option("--limit <n>", "Max commitments to show (default 10, cap 50)")
    .option("--json", "Print the raw payload instead of the formatted list")
    .action(async (options: { readonly limit?: string; readonly json?: boolean }) => {
      const limit = clampScanLimit(options.limit, 10, 50);
      const history = await readLastChatHistory().catch(() => []);
      const userTurns = history.filter((line) => line.role === "user").map((line) => line.content);
      const found = detectUserCommitments(userTurns, { maxCommitments: limit });
      if (options.json) {
        io.stdout(`${JSON.stringify({ commitments: found, total: found.length }, null, 2)}\n`);
        return;
      }
      if (found.length === 0) {
        io.stdout("No open commitments detected in recent chat.\n");
        return;
      }
      io.stdout(`Open commitments you mentioned (${found.length.toString()}):\n`);
      for (const commitment of found) {
        const mark = commitment.confidence === "high" ? "•" : "·";
        io.stdout(`  ${mark} ${commitment.text}\n`);
      }
      io.stdout("\nThese aren't tracked yet — add the ones that matter as tasks or reminders.\n");
    });
}
