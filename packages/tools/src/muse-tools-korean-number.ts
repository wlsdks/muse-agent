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

export function createKoreanNumberTool(): MuseTool {
  return {
    definition: {
      description:
        "Formats a whole number into Korean myriad-unit grouping — 만 (10,000), 억 (100,000,000), 조 (10¹²) — e.g. 12345678 → '1234만 5678', 120000000 → '1억 2000만', 54000000 → '5400만'. The local model groups by Western 3-digit commas and mis-places the 만/억 boundary, so this is the exact grounded reading. USE WHEN the user has a numeric amount and wants it read/written in Korean units ('12345678원은 한국식으로?', '이 금액 몇 만원이야?', 'write 50000000 in Korean number units'). Do NOT use to turn Korean number WORDS back into digits (not supported here), nor for arithmetic (use math_eval) or physical-unit conversion (use unit_convert).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          value: { description: "The whole number to format, e.g. 12345678.", type: "integer" }
        },
        required: ["value"],
        type: "object"
      },
      keywords: ["만", "억", "조", "한국식", "한국 숫자", "korean number", "만원", "억원", "단위"],
      name: "korean_number",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const raw = args["value"];
      const value =
        typeof raw === "number" ? raw : typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : Number.NaN;
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { error: "korean_number expects a whole number, e.g. 12345678" };
      }
      const korean = toKoreanNumber(value);
      if (korean === undefined) return { error: "number is out of range (beyond 경, 10¹⁶)" };
      return { korean, value };
    }
  };
}
