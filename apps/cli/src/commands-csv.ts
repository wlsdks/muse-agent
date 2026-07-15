import { errorMessage } from "@muse/shared";
/**
 * `muse csv <file> --sum amount` — exact, deterministic aggregates over a CSV.
 * The local model is unreliable at arithmetic across rows; this computes the
 * answer in code. Distinct from `muse ask --file data.csv` (free-text questions
 * grounded on the file's TEXT) — this is the precise-number path.
 */

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";

import type { Command } from "commander";

import { aggregate, formatCsvAggregate, formatGroupAggregate, groupAggregate, parseCsv, parseWhere, type AggregateOp, type WhereClause } from "./csv-aggregate.js";
import type { ProgramIO } from "./program.js";

interface CsvOptions {
  readonly sum?: string;
  readonly avg?: string;
  readonly min?: string;
  readonly max?: string;
  readonly count?: boolean;
  readonly where?: string;
  readonly groupBy?: string;
  readonly json?: boolean;
}

export function registerCsvCommand(program: Command, io: ProgramIO): void {
  program
    .command("csv")
    .description("Exact aggregates over a CSV — sum / avg / min / max a column or count rows, with an optional row filter. Deterministic (no model). Use when you need a precise total/count over tabular data; for free-text questions use `muse ask --file`.")
    .argument("<file>", "Path to the .csv file, e.g. expenses.csv")
    .option("--sum <column>", "Sum a numeric column, e.g. --sum amount")
    .option("--avg <column>", "Average a numeric column")
    .option("--min <column>", "Minimum of a numeric column")
    .option("--max <column>", "Maximum of a numeric column")
    .option("--count", "Count rows (after any --where filter)")
    .option("--where <col=value>", "Only rows where a column exactly equals a value (case-insensitive), e.g. --where category=food")
    .option("--group-by <column>", "Aggregate PER GROUP, e.g. --sum amount --group-by category for spend per category")
    .option("--json", "Print the structured result")
    .action(async (file: string, options: CsvOptions) => {
      const ops: { readonly op: AggregateOp; readonly column?: string }[] = [];
      if (options.sum !== undefined) ops.push({ column: options.sum, op: "sum" });
      if (options.avg !== undefined) ops.push({ column: options.avg, op: "avg" });
      if (options.min !== undefined) ops.push({ column: options.min, op: "min" });
      if (options.max !== undefined) ops.push({ column: options.max, op: "max" });
      if (options.count) ops.push({ op: "count" });
      if (ops.length === 0) {
        io.stderr("muse csv: choose one of --sum/--avg/--min/--max <column> or --count\n");
        process.exitCode = 1;
        return;
      }
      if (ops.length > 1) {
        io.stderr("muse csv: choose only ONE aggregate (--sum/--avg/--min/--max/--count) per run\n");
        process.exitCode = 1;
        return;
      }

      let where: WhereClause | undefined;
      if (options.where !== undefined) {
        where = parseWhere(options.where);
        if (!where) {
          io.stderr(`muse csv: --where must be 'column=value' (got '${options.where}')\n`);
          process.exitCode = 1;
          return;
        }
      }

      let text: string;
      try {
        text = await readFile(pathResolve(process.cwd(), file), "utf8");
      } catch (cause) {
        io.stderr(`muse csv: cannot read ${file} (${errorMessage(cause)})\n`);
        process.exitCode = 1;
        return;
      }

      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        io.stderr(`muse csv: ${file} has no rows\n`);
        process.exitCode = 1;
        return;
      }

      const { op, column } = ops[0]!;

      if (options.groupBy !== undefined) {
        const grouped = groupAggregate(parsed, op, column, options.groupBy, where);
        if (grouped.error !== undefined) {
          io.stderr(`muse csv: ${grouped.error}\n`);
          process.exitCode = 1;
          return;
        }
        io.stdout(options.json ? `${JSON.stringify(grouped, null, 2)}\n` : formatGroupAggregate(grouped, where));
        return;
      }

      const result = aggregate(parsed, op, column, where);
      if (result.error !== undefined) {
        io.stderr(`muse csv: ${result.error}\n`);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      io.stdout(formatCsvAggregate(result, where));
    });
}

