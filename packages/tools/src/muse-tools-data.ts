import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * Data / encoding tools — math, hash, csv, base64. The arithmetic
 * evaluator and CSV parser are local to this file because they only
 * serve their own builders. Same pattern as `muse-tools-time.ts` and
 * `muse-tools-text.ts` — co-locate helpers with the only call site.
 */

const MATH_EXPRESSION = /^[\s\d+\-*/().,%]+$/u;
const MATH_WHITESPACE = /\s/u;

export function createMathEvalTool(): MuseTool {
  return {
    definition: {
      description:
        "Evaluates a numeric arithmetic expression composed of digits, decimal points, parentheses, and the operators + - * / %. Rejects any expression containing other characters; never invokes JavaScript `eval`.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          expression: { description: "Arithmetic expression (e.g. '2 * (3 + 4) / 5').", type: "string" }
        },
        required: ["expression"],
        type: "object"
      },
      domain: "core",
      keywords: ["math", "calculate", "arithmetic"],
      name: "math_eval",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const expression = typeof args["expression"] === "string" ? (args["expression"] as string).trim() : "";
      if (expression.length === 0) {
        return { error: "expression is required" };
      }
      if (expression.length > 256) {
        return { error: "expression exceeds 256 character limit" };
      }
      if (!MATH_EXPRESSION.test(expression)) {
        return { error: "expression may only contain digits, parentheses, '.', ',' and + - * / %" };
      }
      try {
        const result = evaluateArithmetic(expression);
        if (!Number.isFinite(result)) {
          return { error: "expression evaluated to a non-finite number" };
        }
        return { expression, result } satisfies JsonObject;
      } catch (error) {
        return { error: error instanceof Error ? error.message : "expression evaluation failed" };
      }
    }
  };
}

const HASH_TEXT_ALGORITHMS = new Set(["sha256", "sha1", "md5"]);

export function createHashTextTool(): MuseTool {
  return {
    definition: {
      description:
        "Computes a hex digest of `text` using `algorithm` (sha256 default; also accepts sha1, md5). " +
        "Useful for deduplicating notes, generating deterministic IDs from user content, fingerprinting attached payloads, or comparing two strings without leaking the original. " +
        "Hashes the UTF-8 bytes of the input.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          algorithm: {
            description: "Hash algorithm (sha256, sha1, md5). Defaults to sha256.",
            type: "string"
          },
          text: { description: "Source text.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      domain: "core",
      keywords: ["hash", "fingerprint", "dedupe", "sha256"],
      name: "hash_text",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const algorithmInput = typeof args["algorithm"] === "string"
        ? (args["algorithm"] as string).trim().toLowerCase()
        : "sha256";
      const algorithm = algorithmInput.length === 0 ? "sha256" : algorithmInput;
      if (!HASH_TEXT_ALGORITHMS.has(algorithm)) {
        return { error: `algorithm must be one of: sha256, sha1, md5 (got '${algorithm}')` };
      }
      const digest = createHash(algorithm).update(text, "utf8").digest("hex");
      return { algorithm, digest } satisfies JsonObject;
    }
  };
}

const CSV_PARSE_MAX_ROWS = 1_000;
const CSV_PARSE_MAX_TEXT_LENGTH = 200_000;

export function createCsvParseTool(): MuseTool {
  return {
    definition: {
      description:
        "Parses CSV `text` into structured rows. With `header: true` (default), the first non-empty record becomes the column names and each remaining record returns as an object keyed by those names; `headers` is included on the response. With `header: false`, every record returns as an array of strings under `rows`. " +
        "Handles quoted fields, escaped quotes (`\"\"` → `\"`), CRLF/LF line endings, and trailing empty fields. A row with more cells than headers keeps the surplus under an `_extra` array (never dropped); a short row pads missing columns with empty strings. Bounded inputs: text ≤ 200k characters, ≤ 1000 records.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          header: {
            description: "When true (default), parse the first row as headers and return objects.",
            type: "boolean"
          },
          text: { description: "CSV-formatted text.", type: "string" }
        },
        required: ["text"],
        type: "object"
      },
      domain: "core",
      keywords: ["csv", "parse", "spreadsheet", "table"],
      name: "csv_parse",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      if (text.length === 0) {
        return { rows: [] } satisfies JsonObject;
      }
      if (text.length > CSV_PARSE_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${CSV_PARSE_MAX_TEXT_LENGTH} characters` };
      }
      const useHeader = args["header"] === false ? false : true;
      const records = parseCsvRecords(text);
      if (useHeader) {
        if (records.length === 0) {
          return { headers: [], rows: [] } satisfies JsonObject;
        }
        const headers = records[0] ?? [];
        // A reserved key for cells beyond the named columns. Without it a
        // ragged-long row's extra cells vanish silently — losing user data
        // the answer then presents as the complete row. Suffix until it
        // can't collide with a real column literally named "_extra".
        let overflowKey = "_extra";
        while (headers.includes(overflowKey)) overflowKey += "_";
        const dataRecords = records.slice(1, 1 + CSV_PARSE_MAX_ROWS);
        const rows = dataRecords.map((record) => {
          const row: Record<string, string | string[]> = {};
          for (let index = 0; index < headers.length; index += 1) {
            row[headers[index] ?? ""] = record[index] ?? "";
          }
          if (record.length > headers.length) {
            row[overflowKey] = record.slice(headers.length);
          }
          return row;
        });
        return { headers, rows } satisfies JsonObject;
      }
      return { rows: records.slice(0, CSV_PARSE_MAX_ROWS) } satisfies JsonObject;
    }
  };
}

const BASE64_MAX_TEXT_LENGTH = 500_000;

export function createBase64Tool(): MuseTool {
  return {
    definition: {
      description:
        "Encodes UTF-8 `text` to base64 (`mode: 'encode'`) or decodes base64 `text` back to UTF-8 (`mode: 'decode'`). " +
        "With `urlSafe: true`, encodes to URL-safe base64 (replaces '+' / '/' with '-' / '_' and drops '=' padding) and accepts URL-safe input on decode. " +
        "Useful for inspecting JWT segments, building basic-auth headers, decoding opaque tokens, and round-tripping notes through ASCII-only transports. Bounded inputs: text ≤ 500k characters.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          mode: { description: "'encode' or 'decode'.", type: "string" },
          text: { description: "UTF-8 source for encode; base64 source for decode.", type: "string" },
          urlSafe: { description: "Use URL-safe alphabet ('-' and '_', no padding). Defaults to false.", type: "boolean" }
        },
        required: ["mode", "text"],
        type: "object"
      },
      domain: "core",
      keywords: ["base64", "encode", "decode", "jwt", "transport"],
      name: "base64",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const mode = typeof args["mode"] === "string" ? (args["mode"] as string).trim().toLowerCase() : "";
      const text = typeof args["text"] === "string" ? (args["text"] as string) : "";
      const urlSafe = args["urlSafe"] === true;

      if (mode !== "encode" && mode !== "decode") {
        return { error: "mode must be 'encode' or 'decode'" };
      }

      if (text.length > BASE64_MAX_TEXT_LENGTH) {
        return { error: `text must be ≤ ${BASE64_MAX_TEXT_LENGTH} characters` };
      }

      if (mode === "encode") {
        const standard = Buffer.from(text, "utf8").toString("base64");
        const encoded = urlSafe
          ? standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
          : standard;
        return { encoded } satisfies JsonObject;
      }

      const trimmed = text.trim();
      const expectedAlphabet = urlSafe ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
      if (!expectedAlphabet.test(trimmed)) {
        return { error: urlSafe ? "input is not valid url-safe base64" : "input is not valid base64" };
      }
      const standardised = urlSafe
        ? padBase64(trimmed.replace(/-/g, "+").replace(/_/g, "/"))
        : trimmed;
      const buffer = Buffer.from(standardised, "base64");
      const reEncoded = buffer.toString("base64").replace(/=+$/, "");
      if (reEncoded !== standardised.replace(/=+$/, "")) {
        return { error: "input is not valid base64" };
      }
      return { decoded: buffer.toString("utf8") } satisfies JsonObject;
    }
  };
}

function padBase64(input: string): string {
  const remainder = input.length % 4;
  return remainder === 0 ? input : input + "=".repeat(4 - remainder);
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (character === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    if (character === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

/**
 * Recursive-descent arithmetic evaluator for the constrained character set enforced upstream.
 * Implements operator precedence (* / % before + -), supports parentheses, and rejects empty
 * subexpressions. Avoids `eval` / `Function` for safety.
 */
function evaluateArithmetic(expression: string): number {
  let cursor = 0;
  const stripped = expression.replace(/,/gu, "");

  function parseExpression(): number {
    let value = parseTerm();
    while (cursor < stripped.length) {
      skipWhitespace();
      const char = stripped[cursor];
      if (char === "+" || char === "-") {
        cursor += 1;
        const right = parseTerm();
        value = char === "+" ? value + right : value - right;
      } else {
        break;
      }
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (cursor < stripped.length) {
      skipWhitespace();
      const char = stripped[cursor];
      if (char === "*" || char === "/" || char === "%") {
        cursor += 1;
        const right = parseFactor();
        if (char === "*") {
          value *= right;
        } else if (char === "/") {
          if (right === 0) {
            throw new Error("division by zero");
          }
          value /= right;
        } else {
          if (right === 0) {
            throw new Error("modulo by zero");
          }
          value %= right;
        }
      } else {
        break;
      }
    }
    return value;
  }

  function parseFactor(): number {
    skipWhitespace();
    const char = stripped[cursor];
    if (char === "+" || char === "-") {
      cursor += 1;
      const inner = parseFactor();
      return char === "+" ? inner : -inner;
    }
    if (char === "(") {
      cursor += 1;
      const value = parseExpression();
      skipWhitespace();
      if (stripped[cursor] !== ")") {
        throw new Error("unbalanced parentheses");
      }
      cursor += 1;
      return value;
    }
    return parseNumber();
  }

  function parseNumber(): number {
    skipWhitespace();
    const start = cursor;
    while (cursor < stripped.length) {
      const char = stripped[cursor] ?? "";
      if ((char >= "0" && char <= "9") || char === ".") {
        cursor += 1;
      } else {
        break;
      }
    }
    if (cursor === start) {
      throw new Error("expected number");
    }
    const literal = stripped.slice(start, cursor);
    // `Number`, not `parseFloat`: parseFloat leniently truncates a
    // multi-dot literal ("1.2.3" -> 1.2) and would return a
    // confidently wrong result; `Number("1.2.3")` is NaN and is
    // rejected below.
    const value = Number(literal);
    if (Number.isNaN(value)) {
      throw new Error(`invalid number literal: ${literal}`);
    }
    return value;
  }

  function skipWhitespace(): void {
    // Skip the same \s class MATH_EXPRESSION admits: a tab/newline
    // accepted by the validator must not then break the parser.
    while (cursor < stripped.length && MATH_WHITESPACE.test(stripped[cursor] ?? "")) {
      cursor += 1;
    }
  }

  const value = parseExpression();
  skipWhitespace();
  if (cursor !== stripped.length) {
    throw new Error("trailing characters after expression");
  }
  return value;
}
