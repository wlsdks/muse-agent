import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `leap_year` — whether a given year is a leap year under the GREGORIAN rule:
 * divisible by 4, EXCEPT a century year (÷100) which is leap only if ÷400. The
 * local model reliably gets the ÷4 part but trips on the century exception
 * (1900/2100/2200 are NOT leap; 2000/1600 ARE) — exactly where a deterministic
 * check is the grounded answer.
 */
export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function createLeapYearTool(): MuseTool {
  return {
    definition: {
      description:
        "Returns whether a given year is a leap year (February has 29 days). USE WHEN the user asks 'is 2024 a leap year?' or needs February's length. Do NOT use for date arithmetic (use time_add) or unit conversion (use unit_convert).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          year: { description: "The year to check, e.g. 2024.", type: "integer" }
        },
        required: ["year"],
        type: "object"
      },
      keywords: ["leap", "leap year", "february", "29 days", "윤년", "윤달"],
      name: "leap_year",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const raw = args["year"];
      const year = typeof raw === "number" ? Math.trunc(raw) : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isInteger(year)) return { error: "leap_year needs a whole year, e.g. 2024" };
      return { leap: isLeapYear(year), year };
    }
  };
}
