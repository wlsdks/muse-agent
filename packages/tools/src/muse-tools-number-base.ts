import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `number_base` — convert an integer between binary, octal, decimal, and hex.
 * Developers read hex/binary out of dumps, bitmasks, color codes, and addresses,
 * and the local model mis-computes multi-digit radix conversions (digit-by-digit
 * arithmetic, the class it fails at). BigInt makes it EXACT past Number precision
 * (a 16-hex-digit value would silently round as a float) — the grounded answer.
 */

const BASES: Record<string, number> = { binary: 2, decimal: 10, hex: 16, octal: 8 };
const PREFIXES = ["0x", "0b", "0o"];

export interface NumberBaseResult {
  readonly result: string;
  readonly decimal: string;
}

/**
 * Parse `value` (in base `from`) and re-render it in base `to`, plus its decimal
 * form. `from`/`to` are 'binary' | 'octal' | 'decimal' | 'hex'. A leading 0x/0b/0o
 * and a `-` sign are accepted. Returns `undefined` for an unknown base or a digit
 * not valid in the source base.
 */
export function convertNumberBase(value: string, from: string, to: string): NumberBaseResult | undefined {
  const fromBase = BASES[from];
  const toBase = BASES[to];
  if (fromBase === undefined || toBase === undefined) return undefined;
  let s = value.trim().toLowerCase();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  for (const prefix of PREFIXES) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  if (s.length === 0) return undefined;
  let parsed = 0n;
  const radix = BigInt(fromBase);
  for (const ch of s) {
    const digit = Number.parseInt(ch, 36);
    if (Number.isNaN(digit) || digit >= fromBase) return undefined;
    parsed = parsed * radix + BigInt(digit);
  }
  if (negative) parsed = -parsed;
  return { decimal: parsed.toString(10), result: parsed.toString(toBase) };
}

export function createNumberBaseTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts a whole number between number bases — binary (base 2), octal (base 8), decimal (base 10), and hexadecimal (base 16) — exactly, even for large values. E.g. 255 decimal → 'ff' hex, '1010' binary → 10 decimal, 'deadbeef' hex → 3735928559. A leading 0x/0b/0o prefix and a '-' sign are accepted. Returns the target-base text plus the decimal value. USE WHEN the user wants a number in a different base ('255 in hex?', 'what is 0xFF in decimal?', 'convert 1010 binary to decimal'). Do NOT use for arithmetic (use math_eval) or physical-unit conversion (use unit_convert).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          from: { description: "The base `value` is written in.", enum: ["binary", "octal", "decimal", "hex"], type: "string" },
          to: { description: "The base to convert into.", enum: ["binary", "octal", "decimal", "hex"], type: "string" },
          value: { description: "The number as text, e.g. '255', 'ff', '0xff', '1010'.", type: "string" }
        },
        required: ["value", "from", "to"],
        type: "object"
      },
      keywords: ["hex", "hexadecimal", "binary", "octal", "decimal", "base", "radix", "0x", "진법", "16진수", "2진수"],
      name: "number_base",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const value = typeof args["value"] === "string" ? args["value"] : typeof args["value"] === "number" ? String(args["value"]) : "";
      const from = typeof args["from"] === "string" ? args["from"] : "";
      const to = typeof args["to"] === "string" ? args["to"] : "";
      if (value.trim().length === 0) return { error: "number_base needs a `value` to convert" };
      const converted = convertNumberBase(value, from, to);
      if (!converted) return { error: `couldn't convert '${value}' from '${from}' to '${to}' (unknown base, or a digit invalid in base ${from})` };
      return { decimal: converted.decimal, result: converted.result };
    }
  };
}
