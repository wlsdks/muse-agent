/**
 * `muse commitments` — surface open loops the user voiced in chat
 * ("I need to email Bob", "내일 자료 준비해야 해") that never became a
 * formal task or reminder. Read-only over `last-chat.jsonl`; the
 * detection is the deterministic, rule-only `detectUserCommitments`.
 */

import { randomUUID } from "node:crypto";

import { detectUserCommitments, type UserCommitment } from "@muse/agent-core";
import { resolveTasksFile } from "@muse/autoconfigure";
import { readTasks, writeTasks, type PersistedTask } from "@muse/stores";
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

/**
 * Build the task for `muse commitments track <number>` — the 1-based index from
 * the `scan` list (its order is deterministic, so the number is stable for a
 * scan→track in the same sitting). Pure: validates the index, skips a commitment
 * already tracked as an OPEN task (case-insensitive title match, so re-running is
 * idempotent), and otherwise returns the new open task. Never throws.
 */
export function buildTaskFromCommitment(
  commitments: readonly UserCommitment[],
  index: number,
  existingOpenTitles: readonly string[],
  idFactory: () => string,
  now: Date
): { readonly task: PersistedTask } | { readonly error: string } {
  if (!Number.isInteger(index) || index < 1 || index > commitments.length) {
    return {
      error: commitments.length === 0
        ? "no commitments detected to track — run `muse commitments scan` first"
        : `commitment ${index.toString()} doesn't exist — pick 1–${commitments.length.toString()} from \`muse commitments scan\``
    };
  }
  const text = commitments[index - 1]!.text.trim();
  const lower = text.toLowerCase();
  if (existingOpenTitles.some((title) => title.trim().toLowerCase() === lower)) {
    return { error: `already tracked as an open task: "${text}"` };
  }
  return { task: { createdAt: now.toISOString(), id: idFactory(), status: "open", title: text } };
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
      found.forEach((commitment, i) => {
        const mark = commitment.confidence === "high" ? "•" : "·";
        io.stdout(`  ${(i + 1).toString()}. ${mark} ${commitment.text}\n`);
      });
      io.stdout("\nTrack the ones that matter as tasks: `muse commitments track <number>`.\n");
    });

  commitments
    .command("track")
    .description("Turn a detected commitment into a tracked task, by its number from `scan`")
    .argument("<number>", "The commitment's number from `muse commitments scan`, e.g. 1")
    .action(async (numberArg: string) => {
      const index = Number(numberArg.trim());
      if (!Number.isInteger(index) || index < 1) {
        throw new Error("track needs a positive commitment number from `muse commitments scan`, e.g. `muse commitments track 1`");
      }
      // Re-detect with the cap so the index matches the `scan` numbering (its
      // order is deterministic, so the first N are identical to the default scan).
      const history = await readLastChatHistory().catch(() => []);
      const userTurns = history.filter((line) => line.role === "user").map((line) => line.content);
      const found = detectUserCommitments(userTurns, { maxCommitments: 50 });
      const tasksFile = resolveTasksFile(process.env as Record<string, string | undefined>);
      const existing = await readTasks(tasksFile).catch(() => []);
      const openTitles = existing.filter((task) => task.status === "open").map((task) => task.title);
      const result = buildTaskFromCommitment(found, index, openTitles, () => `task_${randomUUID()}`, new Date());
      if ("error" in result) {
        io.stderr(`${result.error}\n`);
        process.exitCode = 1;
        return;
      }
      await writeTasks(tasksFile, [...existing, result.task]);
      io.stdout(`Tracked as a task: "${result.task.title}"  (see \`muse tasks list\`)\n`);
    });
}
