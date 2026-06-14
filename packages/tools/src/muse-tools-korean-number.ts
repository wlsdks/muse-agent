import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `korean_number` — render an integer in Korean myriad-unit grouping. Korean
 * groups large numbers by 만 (10⁴), 억 (10⁸), 조 (10¹²) — NOT the Western
 * 3-digit comma — so 12345678 reads "1234만 5678" and 120000000 is "1억 2000만".
 * The local model regroups by the 3-digit pattern it was mostly trained on and
 * mis-places the 만/억 boundary, so this deterministic transform is the grounded
 * answer (same class as `unit_convert`'s exact factors). Digits → Korean only;
 * the reverse (Korean words → digits) is not handled here.
 */

const UNITS = ["", "만", "억", "조", "경"] as const;

/**
 * Arabic integer → Korean myriad grouping ("1234만 5678"), or `undefined` for a
 * non-integer or a magnitude beyond 경 (10¹⁶, past JS safe-integer range anyway).
 * Zero chunks are omitted (100000005 → "1억 5", not "1억 0000만 5").
 */
export function toKoreanNumber(value: number): string | undefined {
  if (!Number.isInteger(value)) return undefined;
  if (value === 0) return "0";
  const negative = value < 0;
  let remaining = Math.abs(value);
  const parts: string[] = [];
  let idx = 0;
  while (remaining > 0 && idx < UNITS.length) {
    const chunk = remaining % 10000;
    if (chunk > 0) parts.unshift(`${chunk}${UNITS[idx]}`);
    remaining = Math.floor(remaining / 10000);
    idx += 1;
  }
  if (remaining > 0) return undefined; // beyond 경 — out of range
  return (negative ? "-" : "") + parts.join(" ");
}

const BIG_UNITS: Record<string, number> = { "조": 1e12, "억": 1e8, "만": 1e4 };
const SMALL_UNITS: Record<string, number> = { "천": 1000, "백": 100, "십": 10 };

/**
 * Korean myriad expression → integer ("1억 2천만" → 120000000), or `undefined`
 * when the text isn't a Korean number. Handles digit chunks ("1234만 5678"),
 * 천/백/십 sub-units and their compounds ("천만" = 10⁷), and a trailing 원 /
 * grouping commas. Requires at least one unit word — a bare number ("12345")
 * returns undefined (that is `toKoreanNumber`'s input, not this direction).
 */
export function fromKoreanNumber(text: string): number | undefined {
  const s = text.replace(/[\s,]/gu, "").replace(/원$/u, "");
  if (s.length === 0 || !/^[0-9조억만천백십]+$/u.test(s)) return undefined;
  let total = 0;
  let section = 0;
  let current = 0;
  let sawUnit = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j += 1;
      current = Number(s.slice(i, j));
      i = j - 1;
      continue;
    }
    if (ch in SMALL_UNITS) {
      section += (current || 1) * SMALL_UNITS[ch]!;
      current = 0;
      sawUnit = true;
      continue;
    }
    // a BIG unit (만/억/조) closes the current 4-digit section
    section += current;
    current = 0;
    total += (section || 1) * BIG_UNITS[ch]!;
    section = 0;
    sawUnit = true;
  }
  return sawUnit ? total + section + current : undefined;
}

export function createKoreanNumberTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts between a plain integer and Korean myriad-unit grouping — 만 (10,000), 억 (100,000,000), 조 (10¹²) — in EITHER direction, returning BOTH forms. A number → its Korean reading (12345678 → '1234만 5678', 120000000 → '1억 2000만'); a Korean amount → the integer ('1억 2천만' → 120000000, '5400만원' → 54000000). The local model groups by Western 3-digit commas and mis-places the 만/억 boundary either way, so this is the exact grounded answer. USE WHEN the user has an amount in one form and wants the other ('12345678원은 한국식으로?', '1억 2천만이 숫자로 얼마야?', '이 금액 몇 만원이야?'). Do NOT use for arithmetic (use math_eval) or physical-unit conversion (use unit_convert).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          value: { description: "The amount as text — either a whole number (e.g. '12345678') or a Korean amount expression (e.g. '1억 2천만', '5400만원').", type: "string" }
        },
        required: ["value"],
        type: "object"
      },
      keywords: ["만", "억", "조", "한국식", "한국 숫자", "korean number", "만원", "억원", "단위", "천만", "숫자로"],
      name: "korean_number",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const raw = args["value"];
      // Reverse direction: a string carrying a Korean unit word → parse to an integer.
      if (typeof raw === "string" && /[조억만천백십]/u.test(raw)) {
        const parsed = fromKoreanNumber(raw);
        if (parsed === undefined) return { error: `couldn't parse '${raw}' as a Korean number` };
        const korean = toKoreanNumber(parsed);
        return korean === undefined ? { error: "number is out of range (beyond 경, 10¹⁶)" } : { korean, value: parsed };
      }
      // Forward direction: a number (or numeric string) → its Korean reading.
      const value =
        typeof raw === "number" ? raw : typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { error: "korean_number expects a whole number (12345678) or a Korean amount ('1억 2천만')" };
      }
      const korean = toKoreanNumber(value);
      if (korean === undefined) return { error: "number is out of range (beyond 경, 10¹⁶)" };
      return { korean, value };
    }
  };
}
