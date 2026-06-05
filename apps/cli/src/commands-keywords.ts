/**
 * `muse keywords <file>` — the key phrases (topics) of a document by RAKE.
 * Deterministic, local, no model. The phrase-level complement to `muse summarize`
 * (key sentences): use this to tag/index a note or skim what a long doc is ABOUT.
 */

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import type { Command } from "commander";

import { rakeKeyphrases } from "./keyphrase.js";
import type { ProgramIO } from "./program.js";

export function registerKeywordsCommand(program: Command, io: ProgramIO): void {
  program
    .command("keywords")
    .description("Extract the key phrases (topics) of a document — RAKE (Rose et al. 2010). Deterministic, no model. Phrase-level complement to `muse summarize`. e.g. `muse keywords report.md`")
    .argument("<file>", "Path to the text/markdown file, e.g. report.md")
    .option("--limit <n>", "How many key phrases to return (default 8, cap 50)")
    .option("--json", "Print the structured result")
    .action(async (file: string, options: { readonly limit?: string; readonly json?: boolean }) => {
      let limit = 8;
      if (options.limit !== undefined) {
        const parsed = Number(options.limit.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          io.stderr(`muse keywords: --limit must be a positive number (got '${options.limit}')\n`);
          process.exitCode = 1;
          return;
        }
        limit = Math.min(50, Math.trunc(parsed));
      }

      let text: string;
      try {
        text = await readFile(pathResolve(process.cwd(), file), "utf8");
      } catch (cause) {
        io.stderr(`muse keywords: cannot read ${file} (${cause instanceof Error ? cause.message : String(cause)})\n`);
        process.exitCode = 1;
        return;
      }

      const phrases = rakeKeyphrases(text, { limit });
      if (phrases.length === 0) {
        io.stderr(`muse keywords: no key phrases found in ${file}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify({ file, keyphrases: phrases }, null, 2)}\n`);
        return;
      }
      io.stdout(`🔑 Key phrases in ${file}:\n`);
      for (const { phrase } of phrases) {
        io.stdout(`  • ${phrase}\n`);
      }
    });
}
