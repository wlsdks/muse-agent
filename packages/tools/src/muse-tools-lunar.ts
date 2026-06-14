import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `lunar_date` — the Korean LUNAR (음력) calendar date for a solar date. Korean
 * users carry lunar birthdays and holidays (설날 = 음 1/1, 추석 = 음 8/15), and the
 * local model cannot compute the lunar calendar reliably. ICU's `dangi` calendar
 * IS the authority, so this is the exact grounded answer — including leap months
 * (윤달). Computed in the Korea timezone (Asia/Seoul), where the lunar calendar's
 * day boundary is defined.
 */

export interface LunarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly leap: boolean;
}

export function solarToLunar(date: Date): LunarDate {
  const parts = new Intl.DateTimeFormat("en-u-ca-dangi", {
    day: "numeric",
    month: "numeric",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const monthRaw = get("month"); // "8" or, for a leap month, "6bis"
  return {
    day: Number.parseInt(get("day"), 10),
    leap: monthRaw.endsWith("bis"),
    month: Number.parseInt(monthRaw, 10),
    year: Number.parseInt(get("relatedYear") || get("year"), 10)
  };
}

/**
 * Inverse of `solarToLunar`: find the solar date for a Korean lunar date by
 * scanning forward from solar Jan 1 and matching the ICU dangi value. Returns the
 * solar ISO date (YYYY-MM-DD) or `undefined` for a lunar date that doesn't occur
 * (e.g. day 30 of a short month, or a leap month that isn't intercalated that
 * year). Deterministic — `solarToLunar` is ICU.
 *
 * The 460-day bound (not 366): a late lunar month — e.g. 음 12/30 of a leap year —
 * falls in FEBRUARY of the year AFTER `year`, ~414 days past solar Jan 1. A bound
 * of ~400 silently turns those real dates into a false "no such date" (a grounded
 * lie). 460 round-trips every real lunar date 2000–2100 with zero misses.
 */
export function lunarToSolar(year: number, month: number, day: number, leap: boolean): string | undefined {
  const start = Date.UTC(year, 0, 1);
  for (let i = 0; i < 460; i += 1) {
    const candidate = new Date(start + i * 86_400_000);
    const l = solarToLunar(candidate);
    if (l.year === year && l.month === month && l.day === day && l.leap === leap) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

export function createLunarToSolarTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Converts a Korean LUNAR (음력) date to the SOLAR (양력) calendar date — the inverse of lunar_date. Answers a LUNAR BIRTHDAY or holiday in this year's solar date: '내 음력 생일 5월 5일이 올해 양력으로 며칠?' / '음력 8월 15일은 양력으로?'. The local model can't compute this; ICU's dangi calendar gives the exact date. `year` defaults to the current year; set `leap` for a 윤달 date. Do NOT use to get a solar date's LUNAR date (use lunar_date — this is the reverse).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          day: { description: "Lunar day of month (1–30), e.g. 5.", maximum: 30, minimum: 1, type: "integer" },
          leap: { description: "true if this is a leap month (윤달). Defaults to false.", type: "boolean" },
          month: { description: "Lunar month (1–12), e.g. 5.", maximum: 12, minimum: 1, type: "integer" },
          year: { description: "Lunar year (≈ solar year), e.g. 2026. Omit for the current year.", type: "integer" }
        },
        required: ["month", "day"],
        type: "object"
      },
      keywords: ["음력", "양력", "lunar", "음력 생일", "음력 날짜", "양력으로", "lunar birthday", "lunar to solar"],
      name: "lunar_to_solar",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const month = typeof args["month"] === "number" ? Math.trunc(args["month"]) : Number.NaN;
      const day = typeof args["day"] === "number" ? Math.trunc(args["day"]) : Number.NaN;
      const year = typeof args["year"] === "number" ? Math.trunc(args["year"]) : now().getFullYear();
      const leap = args["leap"] === true;
      if (!Number.isInteger(month) || month < 1 || month > 12) return { error: "month must be a lunar month 1–12" };
      if (!Number.isInteger(day) || day < 1 || day > 30) return { error: "day must be a lunar day 1–30" };
      const solar = lunarToSolar(year, month, day, leap);
      if (!solar) return { error: `no such lunar date: ${leap ? "윤" : ""}${month.toString()}월 ${day.toString()}일 in lunar year ${year.toString()}` };
      const monthLabel = leap ? `윤${month.toString()}월` : `${month.toString()}월`;
      return {
        lunar: `음력 ${year.toString()}년 ${monthLabel} ${day.toString()}일`,
        solar,
        weekday: new Date(`${solar}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" })
      };
    }
  };
}

export function createLunarDateTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Returns the Korean LUNAR (음력) calendar date for a solar (양력) date — defaults to TODAY. Answers '오늘 음력 며칠이야?' / \"what's today's lunar date?\" / '2026-09-25는 음력으로 며칠?'. The local model can't compute the lunar calendar reliably; this is the exact answer (ICU dangi calendar, Korea timezone), and it marks a leap month (윤달). Do NOT use for the current solar clock time/date (use time_now) or to convert a LUNAR date BACK to solar (not supported here).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          date: { description: "Optional solar date (ISO-8601, e.g. '2026-09-25'). Omit for today.", type: "string" }
        },
        required: [],
        type: "object"
      },
      keywords: ["음력", "양력", "lunar", "설날", "추석", "lunar date", "lunar calendar", "음력 날짜", "음력 생일"],
      name: "lunar_date",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const raw = typeof args["date"] === "string" ? args["date"].trim() : "";
      let date: Date;
      if (raw.length > 0) {
        date = new Date(raw);
        if (Number.isNaN(date.getTime())) return { error: `invalid solar date: '${raw}'` };
      } else {
        date = now();
      }
      const lunar = solarToLunar(date);
      const monthLabel = lunar.leap ? `윤${lunar.month.toString()}월` : `${lunar.month.toString()}월`;
      return {
        isLeapMonth: lunar.leap,
        lunar: `음력 ${lunar.year.toString()}년 ${monthLabel} ${lunar.day.toString()}일`,
        lunarDay: lunar.day,
        lunarMonth: lunar.month,
        lunarYear: lunar.year,
        solar: date.toISOString().slice(0, 10)
      };
    }
  };
}
