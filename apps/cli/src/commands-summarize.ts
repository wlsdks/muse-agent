import { errorMessage } from "@muse/shared";
/**
 * `muse summarize <file>` — an EXTRACTIVE summary of a document: the file's own
 * top sentences, picked by Luhn's significant-word density. Deterministic, local,
 * no model — so it CANNOT fabricate or drift (every line is verbatim from the
 * source). Distinct from `muse ask --file "summarize this"` (the model's
 * abstractive, reworded summary); reach for this when you want the gist with a
 * guarantee that nothing was invented.
 */

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import type { Command } from "commander";

import { summarizeExtractive } from "./extractive-summary.js";
import type { ProgramIO } from "./program.js";

interface SummarizeOptions {
  readonly sentences?: string;
  readonly json?: boolean;
}

export function registerSummarizeCommand(program: Command, io: ProgramIO): void {
  program
    .command("summarize")
    .description("Extractive summary of a document — its OWN top sentences by significant-word density (Luhn 1958). Deterministic, no model, cannot fabricate. Use for a verbatim gist; for a reworded answer use `muse ask --file`.")
    .argument("<file>", "Path to the text/markdown file to summarize, e.g. report.md")
    .option("--sentences <n>", "How many sentences to extract (default 3, cap 20)")
    .option("--json", "Print the structured result")
    .action(async (file: string, options: SummarizeOptions) => {
      let maxSentences = 3;
      if (options.sentences !== undefined) {
        const trimmed = options.sentences.trim();
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          io.stderr(`muse summarize: --sentences must be a positive number (got '${options.sentences}')\n`);
          process.exitCode = 1;
          return;
        }
        maxSentences = Math.min(20, Math.trunc(parsed));
      }

      let text: string;
      try {
        text = await readFile(pathResolve(process.cwd(), file), "utf8");
      } catch (cause) {
        io.stderr(`muse summarize: cannot read ${file} (${errorMessage(cause)})\n`);
        process.exitCode = 1;
        return;
      }

      const summary = summarizeExtractive(text, { maxSentences });
      if (summary.length === 0) {
        io.stderr(`muse summarize: ${file} has no sentences to summarize\n`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        io.stdout(`${JSON.stringify({ file, sentences: summary }, null, 2)}\n`);
        return;
      }

      io.stdout(`📄 Extractive summary of ${file} (${summary.length.toString()} sentence${summary.length === 1 ? "" : "s"}, verbatim — nothing reworded):\n\n`);
      for (const sentence of summary) {
        io.stdout(`  • ${sentence}\n`);
      }
    });
}

