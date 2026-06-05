/**
 * `muse benford <file> <column>` — flag unnatural patterns in a numeric CSV
 * column via Benford's Law (forensic accounting). Deterministic, local, no
 * model. Use on naturally-occurring multi-magnitude numbers (expenses, amounts,
 * counts); not on bounded fields (ages, scores). Distinct from `muse csv` (exact
 * aggregates) — this checks the SHAPE of the leading-digit distribution.
 */

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import type { Command } from "commander";

import { analyzeBenford, formatBenford } from "./benford.js";
import { parseCsv, resolveColumn, toNumber } from "./csv-aggregate.js";
import type { ProgramIO } from "./program.js";

export function registerBenfordCommand(program: Command, io: ProgramIO): void {
  program
    .command("benford")
    .description("Benford's-Law check on a numeric CSV column — flags data-entry errors / unnatural patterns in naturally-occurring amounts (expenses, transactions). Deterministic, no model. e.g. `muse benford expenses.csv amount`")
    .argument("<file>", "Path to the .csv file, e.g. expenses.csv")
    .argument("<column>", "Numeric column to check, e.g. amount")
    .option("--json", "Print the structured result")
    .action(async (file: string, column: string, options: { readonly json?: boolean }) => {
      let text: string;
      try {
        text = await readFile(pathResolve(process.cwd(), file), "utf8");
      } catch (cause) {
        io.stderr(`muse benford: cannot read ${file} (${cause instanceof Error ? cause.message : String(cause)})\n`);
        process.exitCode = 1;
        return;
      }

      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        io.stderr(`muse benford: ${file} has no rows\n`);
        process.exitCode = 1;
        return;
      }
      const columnIndex = resolveColumn(parsed.headers, column);
      if (columnIndex === undefined) {
        io.stderr(`muse benford: no column '${column}' (have: ${parsed.headers.join(", ")})\n`);
        process.exitCode = 1;
        return;
      }

      const values = parsed.rows
        .map((row) => toNumber(row[columnIndex] ?? ""))
        .filter((n): n is number => n !== undefined);
      const result = analyzeBenford(values);

      if (options.json) {
        io.stdout(`${JSON.stringify({ column, ...result }, null, 2)}\n`);
        return;
      }
      io.stdout(formatBenford(result, column));
    });
}
