import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import {
  createBase64Tool,
  createCsvParseTool,
  createHashTextTool,
  createMathEvalTool
} from "../src/muse-tools-data.js";

// Direct OUTPUT-correctness coverage for the built-in data/encoding tools
// (untested module). eval:tools proves the model SELECTS them; this proves the
// handler returns the RIGHT answer. All deterministic known-answer. The
// arithmetic evaluator is also a SECURITY surface — it must compute precedence
// itself and never reach for JS eval — so its parser edges are pinned here.

const run = (tool: { execute: (a: JsonObject) => JsonObject }, args: JsonObject): JsonObject => tool.execute(args);

describe("math_eval", () => {
  const math = createMathEvalTool();
  it("honors operator precedence, parentheses, unary sign, and modulo", () => {
    expect(run(math, { expression: "2 + 3 * 4" })).toEqual({ expression: "2 + 3 * 4", result: 14 });
    expect(run(math, { expression: "(2 + 3) * 4" })).toEqual({ expression: "(2 + 3) * 4", result: 20 });
    expect(run(math, { expression: "-5 + 3" })).toEqual({ expression: "-5 + 3", result: -2 });
    expect(run(math, { expression: "10 % 3" })).toEqual({ expression: "10 % 3", result: 1 });
  });

  it("strips thousands separators (commas) before evaluating", () => {
    expect(run(math, { expression: "1,000 + 5" })).toEqual({ expression: "1,000 + 5", result: 1005 });
  });

  it("rejects division and modulo by zero (not a silent Infinity/NaN)", () => {
    expect(run(math, { expression: "5/0" })).toEqual({ error: "division by zero" });
    expect(run(math, { expression: "5%0" })).toEqual({ error: "modulo by zero" });
  });

  it("rejects a multi-dot literal instead of truncating it (Number, not parseFloat)", () => {
    expect(run(math, { expression: "1.2.3" })).toEqual({ error: "invalid number literal: 1.2.3" });
  });

  it("rejects disallowed characters, empty input, unbalanced parens, trailing tokens, and over-length", () => {
    expect(run(math, { expression: "2 + a" })).toEqual({ error: "expression may only contain digits, parentheses, '.', ',' and + - * / %" });
    expect(run(math, { expression: "   " })).toEqual({ error: "expression is required" });
    expect(run(math, { expression: "(2+3" })).toEqual({ error: "unbalanced parentheses" });
    expect(run(math, { expression: "2 3" })).toEqual({ error: "trailing characters after expression" });
    expect(run(math, { expression: `${"1+".repeat(200)}1` })).toEqual({ error: "expression exceeds 256 character limit" });
  });
});

describe("hash_text", () => {
  const hash = createHashTextTool();
  it("defaults to sha256 and returns the known hex digest of the UTF-8 bytes", () => {
    expect(run(hash, { text: "hello" })).toEqual({
      algorithm: "sha256",
      digest: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
  });

  it("accepts sha1/md5 case-insensitively and rejects an unsupported algorithm", () => {
    expect(run(hash, { algorithm: "MD5", text: "hello" })).toEqual({ algorithm: "md5", digest: "5d41402abc4b2a76b9719d911017c592" });
    expect(run(hash, { algorithm: "sha512", text: "x" })).toEqual({ error: "algorithm must be one of: sha256, sha1, md5 (got 'sha512')" });
  });
});

describe("csv_parse", () => {
  const csv = createCsvParseTool();
  it("with header (default) keys each row object by the first record's columns", () => {
    expect(run(csv, { text: "a,b\n1,2\n3,4" })).toEqual({ headers: ["a", "b"], rows: [{ a: "1", b: "2" }, { a: "3", b: "4" }] });
  });

  it("with header:false returns each record as an array of strings", () => {
    expect(run(csv, { header: false, text: "1,2\n3,4" })).toEqual({ rows: [["1", "2"], ["3", "4"]] });
  });

  it("handles quoted fields with embedded commas and escaped quotes", () => {
    expect(run(csv, { text: 'name,note\n"Smith, J","say ""hi"""' }))
      .toEqual({ headers: ["name", "note"], rows: [{ name: "Smith, J", note: 'say "hi"' }] });
  });

  it("handles CRLF line endings and returns [] for empty text", () => {
    expect(run(csv, { text: "a,b\r\n1,2" })).toEqual({ headers: ["a", "b"], rows: [{ a: "1", b: "2" }] });
    expect(run(csv, { text: "" })).toEqual({ rows: [] });
  });

  it("rejects text over the 200k character bound (DoS guard) — mutation-surfaced gap", () => {
    expect(run(csv, { text: "a,".repeat(120_000) })).toEqual({ error: "text must be ≤ 200000 characters" });
  });
});

describe("base64", () => {
  const b64 = createBase64Tool();
  it("encodes and decodes standard base64 (UTF-8)", () => {
    expect(run(b64, { mode: "encode", text: "hello" })).toEqual({ encoded: "aGVsbG8=" });
    expect(run(b64, { mode: "decode", text: "aGVsbG8=" })).toEqual({ decoded: "hello" });
  });

  it("round-trips URL-safe base64 ('-'/'_' alphabet, no padding)", () => {
    const encoded = run(b64, { mode: "encode", text: "<<??>>", urlSafe: true });
    expect(encoded).toEqual({ encoded: "PDw_Pz4-" }); // standard would be "PDw/Pz4+"
    expect(run(b64, { mode: "decode", text: "PDw_Pz4-", urlSafe: true })).toEqual({ decoded: "<<??>>" });
  });

  it("rejects an unknown mode and non-base64 input", () => {
    expect(run(b64, { mode: "x", text: "y" })).toEqual({ error: "mode must be 'encode' or 'decode'" });
    expect(run(b64, { mode: "decode", text: "!!!!" })).toEqual({ error: "input is not valid base64" });
  });

  it("round-trips a URL-safe value that needs padding restored on decode (exercises padBase64) — mutation-surfaced gap", () => {
    // "hi" → standard "aGk=" → url-safe "aGk" (padding stripped). Decoding must
    // re-pad (length % 4 === 3 → add one "=") before Buffer can parse it.
    expect(run(b64, { mode: "encode", text: "hi", urlSafe: true })).toEqual({ encoded: "aGk" });
    expect(run(b64, { mode: "decode", text: "aGk", urlSafe: true })).toEqual({ decoded: "hi" });
  });

  it("rejects text over the 500k character bound (DoS guard) — mutation-surfaced gap", () => {
    expect(run(b64, { mode: "encode", text: "x".repeat(500_001) })).toEqual({ error: "text must be ≤ 500000 characters" });
  });
});
