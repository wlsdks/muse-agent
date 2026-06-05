/**
 * Deterministic aggregation over a CSV — sum / avg / min / max / count, with an
 * optional exact-match row filter. The local 8B is unreliable at arithmetic
 * across many rows (the same failure the date/percentage fast-paths exist for),
 * so `muse csv` computes the exact answer in code instead of trusting the model
 * to add a column. Pure: no IO, no model.
 */

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * RFC4180-ish parse: quoted fields may contain commas and newlines, `""` is an
 * escaped quote, `\r\n` and `\n` both end a row. The first row is the header.
 * Fully-blank lines are dropped.
 */
export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => { row.push(field); field = ""; };
  const pushRow = (): void => { pushField(); records.push(row); row = []; };
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ",") { pushField(); i += 1; continue; }
    if (c === "\r") { i += 1; continue; }
    if (c === "\n") { pushRow(); i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  const nonBlank = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonBlank.length === 0) return { headers: [], rows: [] };
  return { headers: nonBlank[0]!.map((h) => h.trim()), rows: nonBlank.slice(1) };
}

/** Resolve a column name to its index (case-insensitive, trimmed). undefined if unknown. */
export function resolveColumn(headers: readonly string[], name: string): number | undefined {
  const want = name.trim().toLowerCase();
  const index = headers.findIndex((h) => h.trim().toLowerCase() === want);
  return index >= 0 ? index : undefined;
}

export interface WhereClause {
  readonly column: string;
  readonly value: string;
}

/** Parse a `col=value` filter; undefined if there is no `=` or an empty column. */
export function parseWhere(expr: string): WhereClause | undefined {
  const eq = expr.indexOf("=");
  if (eq <= 0) return undefined;
  return { column: expr.slice(0, eq).trim(), value: expr.slice(eq + 1).trim() };
}

/** Parse a cell as a number, tolerating a leading currency symbol and thousands commas. undefined if not numeric. */
export function toNumber(cell: string): number | undefined {
  const trimmed = cell.trim().replace(/^[$£€₩]\s?/u, "").replace(/,/gu, "");
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export type AggregateOp = "sum" | "avg" | "min" | "max" | "count";

export interface AggregateResult {
  readonly op: AggregateOp;
  readonly column?: string;
  /** undefined when there are no numeric values to aggregate (or an error). */
  readonly value?: number;
  /** Rows considered after the optional --where filter. */
  readonly matched: number;
  /** Numeric cells that went into a sum/avg/min/max. */
  readonly counted?: number;
  /** Non-numeric cells skipped by a sum/avg/min/max. */
  readonly skipped?: number;
  readonly error?: string;
}

/**
 * Compute one aggregate over the parsed CSV. `count` needs no column; the others
 * parse the named column's numeric cells (non-numeric cells are skipped and
 * counted). An unknown column (in the aggregate OR the where clause) returns an
 * `error` rather than a wrong number.
 */
export function aggregate(
  parsed: ParsedCsv,
  op: AggregateOp,
  columnName?: string,
  where?: WhereClause
): AggregateResult {
  let rows = parsed.rows;
  if (where) {
    const wi = resolveColumn(parsed.headers, where.column);
    if (wi === undefined) return { error: `unknown column '${where.column}'`, matched: 0, op };
    const want = where.value.toLowerCase();
    rows = rows.filter((r) => (r[wi] ?? "").trim().toLowerCase() === want);
  }
  if (op === "count") return { matched: rows.length, op, value: rows.length };

  if (!columnName) return { error: `${op} needs a column (e.g. --${op} amount)`, matched: rows.length, op };
  const ci = resolveColumn(parsed.headers, columnName);
  if (ci === undefined) return { error: `unknown column '${columnName}'`, matched: rows.length, op };
  const column = parsed.headers[ci]!;
  const nums: number[] = [];
  let skipped = 0;
  for (const r of rows) {
    const n = toNumber(r[ci] ?? "");
    if (n === undefined) skipped += 1;
    else nums.push(n);
  }
  if (nums.length === 0) {
    return { column, counted: 0, error: `no numeric values in column '${column}'`, matched: rows.length, op, skipped };
  }
  const value =
    op === "sum" ? nums.reduce((a, b) => a + b, 0)
    : op === "avg" ? nums.reduce((a, b) => a + b, 0) / nums.length
    : op === "min" ? Math.min(...nums)
    : Math.max(...nums);
  return { column, counted: nums.length, matched: rows.length, op, skipped, value };
}

const roundIfNeeded = (n: number): string => (Number.isInteger(n) ? n.toString() : (Math.round(n * 1e6) / 1e6).toString());

/** Render an aggregate result for the terminal (the command handles the `error` case separately). */
export function formatCsvAggregate(result: AggregateResult, where?: WhereClause): string {
  const whereNote = where ? ` where ${where.column}=${where.value}` : "";
  if (result.op === "count") {
    return `${(result.value ?? 0).toString()} row(s)${whereNote}\n`;
  }
  const skippedNote = result.skipped && result.skipped > 0 ? `, ${result.skipped.toString()} non-numeric skipped` : "";
  return `${result.op} of ${result.column ?? ""}${whereNote} = ${roundIfNeeded(result.value ?? 0)} (over ${(result.counted ?? 0).toString()} value(s)${skippedNote})\n`;
}
