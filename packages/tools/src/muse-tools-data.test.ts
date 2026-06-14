import { createHash } from "node:crypto";

import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import { createBase64Tool, createCsvParseTool, createHashTextTool, createMathEvalTool } from "./muse-tools-data.js";

const ctx = { runId: "test" } as const;
const math = (args: JsonObject) => createMathEvalTool().execute(args, ctx) as Record<string, unknown>;
const hash = (args: JsonObject) => createHashTextTool().execute(args, ctx) as Record<string, unknown>;
const csv = (args: JsonObject) => createCsvParseTool().execute(args, ctx) as Record<string, unknown>;
const base64 = (args: JsonObject) => createBase64Tool().execute(args, ctx) as Record<string, unknown>;

describe("math_eval", () => {
  it("respects operator precedence and parentheses", () => {
    expect(math({ expression: "2 * (3 + 4) / 5" })).toEqual({ expression: "2 * (3 + 4) / 5", result: 2.8 });
    expect(math({ expression: "2 + 3 * 4" })).toMatchObject({ result: 14 });
    expect(math({ expression: "10 % 3 + 1" })).toMatchObject({ result: 2 });
  });

  it("handles unary signs and nested parentheses", () => {
    expect(math({ expression: "2 * -3" })).toMatchObject({ result: -6 });
    expect(math({ expression: "-(2 + 3)" })).toMatchObject({ result: -5 });
    expect(math({ expression: "2--3" })).toMatchObject({ result: 5 });
  });

  it("treats commas as ignorable thousands separators", () => {
    expect(math({ expression: "1,000 + 1" })).toMatchObject({ result: 1001 });
  });

  it("rejects division and modulo by zero", () => {
    expect(math({ expression: "1 / 0" })).toMatchObject({ error: "division by zero" });
    expect(math({ expression: "5 % 0" })).toMatchObject({ error: "modulo by zero" });
  });

  it("rejects an empty expression and the unsupported '**' operator", () => {
    expect(math({ expression: "   " })).toMatchObject({ error: "expression is required" });
    expect(math({ expression: "2 ** 3" }).error).toBeTruthy();
  });

  it("rejects non-numeric content and malformed literals", () => {
    expect(math({ expression: "2 + x" }).error).toContain("may only contain");
    expect(math({ expression: "1.2.3" }).error).toContain("invalid number literal");
    expect(math({ expression: "2 +" }).error).toBeTruthy();
    expect(math({ expression: "(1 + 2" }).error).toContain("unbalanced");
  });

  it("rejects an expression exceeding the 256-char limit", () => {
    expect(math({ expression: `1${"+1".repeat(200)}` }).error).toContain("256");
  });
});

describe("hash_text", () => {
  it("defaults to sha256 and matches node's digest", () => {
    const out = hash({ text: "hello" });
    expect(out).toEqual({ algorithm: "sha256", digest: createHash("sha256").update("hello", "utf8").digest("hex") });
  });

  it("supports sha1 and md5, case/space-insensitive on the algorithm", () => {
    expect(hash({ algorithm: "  SHA1 ", text: "x" }).digest).toBe(createHash("sha1").update("x").digest("hex"));
    expect(hash({ algorithm: "md5", text: "x" }).digest).toBe(createHash("md5").update("x").digest("hex"));
  });

  it("rejects an unknown algorithm", () => {
    expect(hash({ algorithm: "sha999", text: "x" }).error).toContain("must be one of");
  });

  it("hashes empty text rather than erroring", () => {
    expect(hash({ text: "" }).digest).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("csv_parse", () => {
  it("parses with a header row into keyed objects (default)", () => {
    const out = csv({ text: "name,age\nAlice,30\nBob,25" });
    expect(out).toEqual({
      headers: ["name", "age"],
      rows: [
        { age: "30", name: "Alice" },
        { age: "25", name: "Bob" }
      ]
    });
  });

  it("returns arrays when header is false", () => {
    expect(csv({ header: false, text: "a,b\nc,d" })).toEqual({ rows: [["a", "b"], ["c", "d"]] });
  });

  it("handles quoted fields, escaped quotes, embedded commas/newlines, and CRLF", () => {
    const out = csv({ header: false, text: 'x,"a,b","he said ""hi"""\r\n"line\nbreak",2,3' });
    expect(out).toEqual({ rows: [["x", "a,b", 'he said "hi"'], ["line\nbreak", "2", "3"]] });
  });

  it("returns empty rows for empty text", () => {
    expect(csv({ text: "" })).toEqual({ rows: [] });
  });

  it("pads short data rows against the header width", () => {
    expect(csv({ text: "a,b,c\n1,2" })).toEqual({ headers: ["a", "b", "c"], rows: [{ a: "1", b: "2", c: "" }] });
  });

  it("preserves data-row cells beyond the header width under _extra (never silently dropped)", () => {
    const out = csv({ text: "name,age\nAlice,30,extra1,extra2\nBob,25" });
    expect(out).toEqual({
      headers: ["name", "age"],
      rows: [
        { age: "30", name: "Alice", _extra: ["extra1", "extra2"] },
        { age: "25", name: "Bob" }
      ]
    });
  });

  it("picks a non-colliding overflow key when a column is literally named _extra", () => {
    const out = csv({ text: "_extra,b\nkept,y,overflow" }) as { rows: Record<string, unknown>[] };
    // The real "_extra" column value must survive; the overflow lands elsewhere.
    expect(out.rows[0]?.["_extra"]).toBe("kept");
    expect(out.rows[0]?.["_extra_"]).toEqual(["overflow"]);
  });

  it("rejects text over the 200k character bound (DoS guard)", () => {
    expect(csv({ text: "a,".repeat(120_000) })).toEqual({ error: "text must be ≤ 200000 characters" });
  });
});

describe("base64", () => {
  it("round-trips encode → decode for unicode text", () => {
    const encoded = base64({ mode: "encode", text: "héllo 世界" }).encoded as string;
    expect(base64({ mode: "decode", text: encoded })).toEqual({ decoded: "héllo 世界" });
  });

  it("produces url-safe output and decodes it back", () => {
    const text = "subjects?ids=1&2//3";
    const encoded = base64({ mode: "encode", text, urlSafe: true }).encoded as string;
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64({ mode: "decode", text: encoded, urlSafe: true })).toEqual({ decoded: text });
  });

  it("rejects an invalid mode and non-base64 input", () => {
    expect(base64({ mode: "frobnicate", text: "x" }).error).toContain("mode must be");
    expect(base64({ mode: "decode", text: "not base64!!" }).error).toContain("not valid base64");
  });

  it("rejects standard-alphabet input when url-safe decode is requested", () => {
    expect(base64({ mode: "decode", text: "a+b/c", urlSafe: true }).error).toContain("url-safe");
  });

  it("round-trips a URL-safe value that needs padding restored on decode (length % 4 === 3 → add one '=')", () => {
    // "hi" → standard "aGk=" → url-safe "aGk" (padding stripped); decode must re-pad.
    expect(base64({ mode: "encode", text: "hi", urlSafe: true })).toEqual({ encoded: "aGk" });
    expect(base64({ mode: "decode", text: "aGk", urlSafe: true })).toEqual({ decoded: "hi" });
  });

  it("rejects text over the 500k character bound (DoS guard)", () => {
    expect(base64({ mode: "encode", text: "x".repeat(500_001) })).toEqual({ error: "text must be ≤ 500000 characters" });
  });
});
