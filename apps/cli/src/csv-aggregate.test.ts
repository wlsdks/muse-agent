import { describe, expect, it } from "vitest";

import { aggregate, formatCsvAggregate, parseCsv, parseWhere, resolveColumn, toNumber } from "./csv-aggregate.js";

describe("parseCsv", () => {
  it("parses headers + rows, honouring quoted commas, escaped quotes, and CRLF", () => {
    const csv = 'name,note,amount\r\n"Smith, J.","said ""hi""",10\nBob,plain,20\n';
    const parsed = parseCsv(csv);
    expect(parsed.headers).toEqual(["name", "note", "amount"]);
    expect(parsed.rows).toEqual([
      ["Smith, J.", 'said "hi"', "10"],
      ["Bob", "plain", "20"]
    ]);
  });

  it("drops fully-blank lines and trims headers", () => {
    expect(parseCsv(" a , b \n1,2\n\n3,4\n").rows).toEqual([["1", "2"], ["3", "4"]]);
    expect(parseCsv(" a , b \n1,2\n").headers).toEqual(["a", "b"]);
  });

  it("returns empty for an empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});

describe("resolveColumn / parseWhere / toNumber", () => {
  it("resolves a column case-insensitively, undefined when unknown", () => {
    expect(resolveColumn(["Category", "Amount"], "amount")).toBe(1);
    expect(resolveColumn(["Category", "Amount"], "missing")).toBeUndefined();
  });
  it("parses a col=value filter, undefined without an =", () => {
    expect(parseWhere("category = food")).toEqual({ column: "category", value: "food" });
    expect(parseWhere("noequals")).toBeUndefined();
    expect(parseWhere("=orphan")).toBeUndefined();
  });
  it("parses numbers tolerating currency + thousands commas, undefined for non-numeric", () => {
    expect(toNumber(" $1,234.50 ")).toBe(1234.5);
    expect(toNumber("30")).toBe(30);
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("n/a")).toBeUndefined();
  });
});

describe("aggregate", () => {
  const parsed = parseCsv("category,amount\nfood,12.50\nfood,7.25\ntransport,30\nfood,n/a\n");

  it("sums a column, skipping non-numeric cells", () => {
    const r = aggregate(parsed, "sum", "amount");
    expect(r.value).toBe(49.75);
    expect(r.counted).toBe(3);
    expect(r.skipped).toBe(1);
  });

  it("applies a --where filter before aggregating", () => {
    expect(aggregate(parsed, "sum", "amount", { column: "category", value: "food" }).value).toBe(19.75);
    expect(aggregate(parsed, "count", undefined, { column: "category", value: "food" }).value).toBe(3);
  });

  it("computes avg / min / max", () => {
    expect(aggregate(parsed, "avg", "amount").value).toBeCloseTo(16.5833, 3);
    expect(aggregate(parsed, "min", "amount").value).toBe(7.25);
    expect(aggregate(parsed, "max", "amount").value).toBe(30);
  });

  it("counts rows (all, then filtered)", () => {
    expect(aggregate(parsed, "count").value).toBe(4);
  });

  it("returns an error for an unknown column (aggregate or where), not a wrong number", () => {
    expect(aggregate(parsed, "sum", "nope").error).toContain("unknown column");
    expect(aggregate(parsed, "count", undefined, { column: "nope", value: "x" }).error).toContain("unknown column");
    expect(aggregate(parseCsv("category,amount\nfood,n/a\n"), "sum", "amount").error).toContain("no numeric values");
  });
});

describe("formatCsvAggregate", () => {
  it("renders a count and a sum with the skipped note + where clause", () => {
    expect(formatCsvAggregate({ matched: 4, op: "count", value: 4 })).toBe("4 row(s)\n");
    const sum = formatCsvAggregate(
      { column: "amount", counted: 2, matched: 3, op: "sum", skipped: 1, value: 19.75 },
      { column: "category", value: "food" }
    );
    expect(sum).toContain("sum of amount where category=food = 19.75");
    expect(sum).toContain("1 non-numeric skipped");
  });
});
