/**
 * Korean relative-time phrase resolution ("내일 오후 3시", "다음 주 월요일",
 * "3일 뒤", "이번 달 말") — the Korean half of the reminder/calendar date
 * parser, split out of loopback-relative-time.ts. The English resolver
 * (resolveRelativeTimePhrase) delegates here first, falling through to its own
 * patterns when this returns undefined.
 */

import { addCalendarMonths, DEFAULT_HOUR, DEFAULT_MINUTE, startOfDay } from "./loopback-relative-time-base.js";

const KOREAN_DAY_OFFSET: Record<string, number> = {
  "오늘": 0,
  "내일": 1,
  "모레": 2,
  "글피": 3
};

/**
 * Korean day + time, or a duration offset. Forms:
 *   "내일"                  → tomorrow 09:00
 *   "내일 오후 3시"          → tomorrow 15:00
 *   "오늘 오전 9시 30분"     → today 09:30
 *   "내일 오후 3시 반"       → tomorrow 15:30 (반 = half past)
 *   "모레 정오" / "내일 자정" → +2d 12:00 / tomorrow 00:00
 *   "오늘 15시"             → today 15:00 (bare 24h hour)
 *   "30분 후" / "3일 뒤"     → reference + offset
 *   "2시간 후" / "3개월 후"  → +N hours / calendar-month offset
 *   "다음 주 월요일 오후 3시" → next ISO-week's Monday 15:00
 * Returns undefined when the phrase isn't a recognised Korean
 * shape so the caller falls through to the English patterns.
 */
export function resolveKoreanRelativePhrase(phrase: string, reference: Date): Date | undefined {
  const offset = resolveKoreanDurationOffset(phrase, reference);
  if (offset) {
    return offset;
  }
  const weekday = resolveKoreanWeekdayPhrase(phrase, reference);
  if (weekday) {
    return weekday;
  }
  // "다음 주" / "다음 달" / "내년" (bare period, no 요일) — parity with the
  // English "next week/month/year". The weekday resolver above already took
  // "다음 주 월요일"; this is the bare period the user also says naturally.
  const koreanPeriod = /^(다음\s*주|담주|다음\s*달|다음\s*월|내년|다음\s*해)(?:\s+(.+))?$/u.exec(phrase.trim());
  if (koreanPeriod) {
    const kpTime = parseKoreanTimeOfDay(koreanPeriod[2]);
    if (kpTime === "invalid") {
      return undefined;
    }
    const kpHead = (koreanPeriod[1] ?? "").replace(/\s+/gu, "");
    const kpTarget = kpHead === "다음주" || kpHead === "담주"
      ? startOfDay(new Date(reference.getTime() + 7 * 86_400_000))
      : kpHead === "내년" || kpHead === "다음해"
        ? startOfDay(addCalendarMonths(reference, 12))
        : startOfDay(addCalendarMonths(reference, 1));
    kpTarget.setHours(kpTime.hour, kpTime.minute, 0, 0);
    return kpTarget;
  }
  // "이번 주말" / "다음 주말" → Saturday (this/next ISO week) 09:00.
  const koWeekend = /^(이번\s*주말|다음\s*주말)(?:\s+(.+))?$/u.exec(phrase.trim());
  if (koWeekend) {
    const koWeekendTime = parseKoreanTimeOfDay(koWeekend[2]);
    if (koWeekendTime === "invalid") {
      return undefined;
    }
    const base = startOfDay(reference);
    let delta = (6 - base.getDay() + 7) % 7;
    if ((koWeekend[1] ?? "").replace(/\s+/gu, "") === "다음주말") {
      delta += 7;
    }
    const target = new Date(base.getTime() + delta * 86_400_000);
    target.setHours(koWeekendTime.hour, koWeekendTime.minute, 0, 0);
    return target;
  }
  // "월말" / "이달 말" / "이번 달 말" → last calendar day 09:00.
  const koMonthEnd = /^(월말|이달\s*말|이번\s*달\s*말)(?:\s+(.+))?$/u.exec(phrase.trim());
  if (koMonthEnd) {
    const koMonthEndTime = parseKoreanTimeOfDay(koMonthEnd[2]);
    if (koMonthEndTime === "invalid") {
      return undefined;
    }
    const lastDay = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
    lastDay.setHours(koMonthEndTime.hour, koMonthEndTime.minute, 0, 0);
    return lastDay;
  }
  // A Korean ABSOLUTE date — "8월 15일", "2026년 8월 20일 오전 9시" — optionally
  // with a time (the time grammar above already handles "오후 3시"). A bare date
  // defaults to 09:00 like the other heads; a year-less month-day that already
  // passed this year rolls to next year (parity with the English "March 1").
  const koAbsDate = /^(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s+(.+))?$/u.exec(phrase.trim());
  if (koAbsDate) {
    const koAbsTime = parseKoreanTimeOfDay(koAbsDate[4]);
    if (koAbsTime === "invalid") {
      return undefined;
    }
    const koAbsMonth = Number(koAbsDate[2]);
    const koAbsDay = Number(koAbsDate[3]);
    if (koAbsMonth < 1 || koAbsMonth > 12 || koAbsDay < 1 || koAbsDay > 31) {
      return undefined;
    }
    const koAbsYear = koAbsDate[1] ? Number(koAbsDate[1]) : reference.getFullYear();
    let koAbsTarget = new Date(koAbsYear, koAbsMonth - 1, koAbsDay);
    // Reject an impossible day (2월 30일) — `new Date` would roll it over silently.
    if (koAbsTarget.getMonth() !== koAbsMonth - 1) {
      return undefined;
    }
    if (!koAbsDate[1] && koAbsTarget.getTime() < startOfDay(reference).getTime()) {
      // Same overflow as the EN path: "2월 29일" rolled into a non-leap next
      // year becomes March 1 silently. Re-check; fail safe to undefined.
      const koRolled = new Date(koAbsYear + 1, koAbsMonth - 1, koAbsDay);
      if (koRolled.getMonth() !== koAbsMonth - 1) {
        return undefined;
      }
      koAbsTarget = koRolled;
    }
    koAbsTarget.setHours(koAbsTime.hour, koAbsTime.minute, 0, 0);
    return koAbsTarget;
  }
  const match = /^(오늘|내일|모레|글피)(?:\s+(.+))?$/u.exec(phrase);
  if (!match) {
    // Bare Korean time with no day word ("오후 5시", "정오",
    // "자정", "17시") → today at that time — the Korean
    // counterpart of the English bare-time branch, so "오후 5시"
    // resolves as readily as "5pm".
    const bare = parseKoreanTimeOfDay(phrase.trim());
    if (bare !== "invalid") {
      const day = startOfDay(reference);
      day.setHours(bare.hour, bare.minute, 0, 0);
      return day;
    }
    return undefined;
  }
  const offsetDays = KOREAN_DAY_OFFSET[match[1] ?? ""];
  if (offsetDays === undefined) {
    return undefined;
  }
  const time = parseKoreanTimeOfDay(match[2]);
  if (time === "invalid") {
    return undefined;
  }
  const target = startOfDay(new Date(reference.getTime() + offsetDays * 86_400_000));
  target.setHours(time.hour, time.minute, 0, 0);
  return target;
}

const KOREAN_WEEKDAY_ISO: Record<string, number> = {
  "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6, "일": 7
};

/**
 * Korean weekday: "[다음 주|이번 주] <요일>요일 [time]".
 *   "월요일"            → next occurrence (always future, like
 *                          the English bare-weekday semantics)
 *   "이번 주 금요일"     → this ISO-week's Friday (may be today/past)
 *   "다음 주 월요일 오후 3시" → next ISO-week's Monday 15:00
 * Week starts Monday (ISO / Korean convention).
 */
function resolveKoreanWeekdayPhrase(phrase: string, reference: Date): Date | undefined {
  const m = /^(다음\s*주|다음주|담주|이번\s*주|이번주)?\s*([월화수목금토일])요일(?:\s+(.+))?$/u.exec(phrase);
  if (!m) {
    return undefined;
  }
  const targetIso = KOREAN_WEEKDAY_ISO[m[2] ?? ""];
  if (targetIso === undefined) {
    return undefined;
  }
  const time = parseKoreanTimeOfDay(m[3]);
  if (time === "invalid") {
    return undefined;
  }
  const referenceDay = startOfDay(reference);
  const jsDay = referenceDay.getDay();
  const isoDow = jsDay === 0 ? 7 : jsDay;
  const prefix = (m[1] ?? "").replace(/\s+/gu, "");

  let deltaDays: number;
  if (prefix === "이번주") {
    deltaDays = targetIso - isoDow;
  } else if (prefix === "다음주" || prefix === "담주") {
    deltaDays = targetIso - isoDow + 7;
  } else {
    deltaDays = ((targetIso - isoDow + 7) % 7) || 7;
  }
  const target = new Date(referenceDay.getTime() + deltaDays * 86_400_000);
  target.setHours(time.hour, time.minute, 0, 0);
  return target;
}

/**
 * Korean duration offset: "<N><unit> 후|뒤" ("30분 후", "3일 뒤").
 * Mirrors the English "in N units" branch — 개월/달 use
 * calendar-month semantics; the rest are flat ms offsets.
 */
function resolveKoreanDurationOffset(phrase: string, reference: Date): Date | undefined {
  const m = /^(\d+)\s*(분|시간|일|주|개월|달)\s*(?:후|뒤)$/u.exec(phrase);
  if (!m) {
    return undefined;
  }
  const amount = Number.parseInt(m[1] ?? "0", 10);
  const unit = m[2];
  if (unit === "개월" || unit === "달") {
    return addCalendarMonths(reference, amount);
  }
  const offsetMs = unit === "분" ? amount * 60_000
    : unit === "시간" ? amount * 3_600_000
    : unit === "일" ? amount * 86_400_000
    : unit === "주" ? amount * 7 * 86_400_000
    : 0;
  return new Date(reference.getTime() + offsetMs);
}

function parseKoreanTimeOfDay(spec: string | undefined): { hour: number; minute: number } | "invalid" {
  if (spec === undefined) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }
  const cleaned = spec.trim();
  if (cleaned === "정오" || cleaned === "점심") {
    return { hour: 12, minute: 0 };
  }
  if (cleaned === "자정") {
    return { hour: 0, minute: 0 };
  }
  // The meridiem accepts the colloquial time-of-day words a Korean user
  // actually types, not just the formal 오전/오후: 새벽/아침 read as AM,
  // 오후/저녁/밤 as PM. So "내일 아침 8시" and "오늘 저녁 7시" resolve as
  // readily as "내일 오후 3시" did.
  const m = /^(새벽|아침|오전|오후|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(?:(\d{1,2})\s*분|(반)))?$/u.exec(cleaned);
  if (!m) {
    return "invalid";
  }
  const meridiem = m[1];
  const rawHour = Number.parseInt(m[2] ?? "0", 10);
  // "반" = half past → :30 ("3시 반" → 03:30, "오후 3시 반" → 15:30).
  const minute = m[4] ? 30 : Number.parseInt(m[3] ?? "0", 10);
  if (minute < 0 || minute > 59) {
    return "invalid";
  }
  const isAm = meridiem === "새벽" || meridiem === "아침" || meridiem === "오전";
  const isPm = meridiem === "오후" || meridiem === "저녁" || meridiem === "밤";
  if (isAm) {
    if (rawHour < 1 || rawHour > 12) return "invalid";
    return { hour: rawHour === 12 ? 0 : rawHour, minute };
  }
  if (isPm) {
    if (rawHour < 1 || rawHour > 12) return "invalid";
    // 밤 12시 = midnight (00:00); 오후/저녁 12시 = noon (12:00).
    if (meridiem === "밤" && rawHour === 12) return { hour: 0, minute };
    return { hour: rawHour === 12 ? 12 : rawHour + 12, minute };
  }
  // No meridiem marker → treat as a 24-hour clock ("15시").
  if (rawHour < 0 || rawHour > 23) {
    return "invalid";
  }
  return { hour: rawHour, minute };
}
