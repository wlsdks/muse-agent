/**
 * `muse on-this-day` — resurface notes you wrote on today's calendar date in
 * earlier years (date-cued autobiographical recall). Read-only, deterministic,
 * no model. Uses the explicit YYYY-MM-DD in a note's path (journaling
 * convention), never the file mtime.
 */

import { resolveNotesDir, type MuseEnvironment } from "@muse/autoconfigure";
import type { Command } from "commander";

import { collectDatedNotes, formatOnThisDay, selectOnThisDay } from "./on-this-day.js";
import type { ProgramIO } from "./program.js";

function environment(): MuseEnvironment {
  return process.env;
}

export function registerOnThisDayCommand(program: Command, io: ProgramIO): void {
  program
    .command("on-this-day")
    .description("Resurface notes you wrote on TODAY's date in earlier years — date-cued recall. Read-only, deterministic, no model. Uses the YYYY-MM-DD in a note's path (e.g. journal/2025-06-06.md).")
    .option("--window <days>", "Also include notes within this many days of today's date (default 0 = exact day)")
    .option("--json", "Emit a structured payload")
    .action(async (options: { readonly window?: string; readonly json?: boolean }) => {
      let windowDays = 0;
      if (options.window !== undefined) {
        const parsed = Number(options.window.trim());
        if (!Number.isInteger(parsed) || parsed < 0) {
          io.stderr(`muse on-this-day: --window must be a non-negative integer (got '${options.window}')\n`);
          process.exitCode = 1;
          return;
        }
        windowDays = parsed;
      }

      const dir = resolveNotesDir(environment());
      const dated = await collectDatedNotes(dir);

      const now = new Date();
      const hits = selectOnThisDay(dated, now, { windowDays });
      if (options.json) {
        io.stdout(`${JSON.stringify({ hits: hits.map((h) => ({ date: h.date.toISOString().slice(0, 10), id: h.id, yearsAgo: h.yearsAgo })) }, null, 2)}\n`);
        return;
      }
      if (hits.length === 0) {
        const day = now.toLocaleDateString("en-US", { day: "numeric", month: "long" });
        io.stdout(`Nothing from ${day} in earlier years yet — keep dating your journal notes (e.g. journal/${now.toISOString().slice(0, 10)}.md) and this fills in over time.\n`);
        return;
      }
      io.stdout(formatOnThisDay(hits, now));
    });
}
