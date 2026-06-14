import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `korean_age` — Korean age from a birthdate. Korea has THREE age reckonings and
 * the local model conflates them: 만 나이 (international, the legal standard since
 * June 2023 — full years lived, minus one if this year's birthday hasn't passed),
 * 세는 나이 (the traditional counting age = birth-year diff + 1), and 연 나이. The
 * birthday-not-yet-passed adjustment is exactly what the 12B drops. A deterministic
 * computation grounds it. (Same user-specific grounding class as `lunar_date` /
 * `korean_number` / unit_convert's 평.)
 */

export interface KoreanAgeResult {
  /** 만 나이 — international age (the legal standard since June 2023). */
  readonly international: number;
  /** 세는 나이 — traditional counting age (birth-year diff + 1). */
  readonly counting: number;
}

export function koreanAge(birthIso: string, now: Date): KoreanAgeResult | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(birthIso.trim());
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const birth = new Date(year, month - 1, day);
  // Reject an impossible date (Feb 30 etc.) — `new Date` would silently roll it.
  if (birth.getFullYear() !== year || birth.getMonth() !== month - 1 || birth.getDate() !== day) return undefined;
  if (birth.getTime() > now.getTime()) return undefined; // a birthdate in the future has no age
  const nowYear = now.getFullYear();
  const hadBirthday = now.getMonth() + 1 > month || (now.getMonth() + 1 === month && now.getDate() >= day);
  return {
    counting: nowYear - year + 1,
    international: nowYear - year - (hadBirthday ? 0 : 1)
  };
}

export function createKoreanAgeTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Computes Korean age from a birthdate: 만 나이 (international age — the legal standard since June 2023, the full years lived) AND 세는 나이 (the traditional counting age, birth-year difference + 1). The local model conflates the three Korean age systems and drops the 'birthday hasn't happened yet this year' subtraction, so this is the exact grounded answer. USE WHEN the user asks their or someone's Korean age from a birth date ('1990년 3월 15일생인데 만 나이가 몇이야?', 'how old in Korean age if born 2000-06-15?'). Do NOT use for the number of days between two dates (use the date-difference path) or plain arithmetic (use math_eval).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          birthdate: { description: "Birth date in YYYY-MM-DD form, e.g. '1990-03-15'.", type: "string" }
        },
        required: ["birthdate"],
        type: "object"
      },
      keywords: ["나이", "만 나이", "만나이", "세는 나이", "korean age", "age", "생일", "몇 살", "몇살"],
      name: "korean_age",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const birthdate = typeof args["birthdate"] === "string" ? args["birthdate"].trim() : "";
      if (birthdate.length === 0) return { error: "korean_age needs a birthdate (YYYY-MM-DD)" };
      const age = koreanAge(birthdate, now());
      if (!age) return { error: `'${birthdate}' is not a valid past birthdate (YYYY-MM-DD)` };
      return { birthdate, countingAge: age.counting, internationalAge: age.international };
    }
  };
}
