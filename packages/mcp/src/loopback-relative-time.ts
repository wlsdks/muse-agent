/**
 * Relative-time phrase resolver shared by `muse.tasks.add` (dueAt)
 * and `muse.calendar.add` (startsAtIso / endsAtIso).
 *
 * The LLM tool-composition path (call `time_now` → `time_add`)
 * works on capable models but Gemini-flash and similar small
 * models sometimes skip `time_now` and hallucinate a base ISO.
 * This resolver runs server-side so the relative-phrase semantic
 * is robust regardless of which model dispatched the tool call.
 *
 * Supported shapes (case-insensitive):
 *   "tomorrow"                                   → next day at 09:00 local
 *   "tomorrow at 6pm" / "tomorrow 6pm" / "...14:30" → next day at the given time
 *   "today" / "today 6pm" / "today at 6pm"       → today at 09:00 (or given time)
 *   "in 3 hours" / "in 30 minutes" / "in 2 days" → reference + offset
 *   "in 1 week" / "in 2 weeks"                   → reference + 7N days
 *   "in 1 month" / "in 3 months"                 → calendar-month offset (goal 110)
 *   "next monday" / "next mon"                   → next Monday at 09:00
 *   "next monday at 6pm" / "next monday 6pm"     → next Monday at 18:00
 *
 * The `at` keyword is optional: "<day> <time>" works the same as
 * "<day> at <time>" — a personal assistant should understand
 * "tomorrow 9am", not just "tomorrow at 9am".
 *   "noon" / "midnight" (suffix to a day phrase) → 12:00 / 00:00
 *
 * Korean (the user's native input):
 *   "내일"                  → tomorrow 09:00
 *   "내일 오후 3시"          → tomorrow 15:00
 *   "오늘 오전 9시 30분"     → today 09:30
 *   "내일 오후 3시 반"       → tomorrow 15:30 (반 = half past)
 *   "모레 정오" / "내일 자정" → +2d 12:00 / tomorrow 00:00
 *   "오늘 15시"             → today 15:00 (bare 24h hour)
 *   "30분 후" / "3일 뒤"     → reference + offset
 *   "2시간 후" / "3개월 후"  → +N hours / calendar-month offset
 *   "월요일"                → next occurrence (always future)
 *   "이번 주 금요일"         → this ISO-week's Friday
 *   "다음 주 월요일 오후 3시" → next ISO-week's Monday 15:00
 *
 * All resolved times use the local timezone for the wall-clock
 * computation, then return an ISO-8601 UTC (`Z`) string. So
 * "tomorrow at 6pm" in Asia/Seoul becomes the corresponding UTC
 * ISO. Personal-use semantics: the user thinks in local time, the
 * persisted ISO is unambiguous UTC.
 *
 * Returns the resolved `Date` on success, or `undefined` when the
 * phrase doesn't match any supported shape — caller decides whether
 * to fall back to ISO parsing or surface an error.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;

// A huge offset ("in 9999999999 days", "99999999999일 후") or a
// month overflow pushes the Date past ±8.64e15 ms → an Invalid
// Date (NaN time). Returning that lets the caller's
// `relative.toISOString()` throw an unhandled RangeError; an
// out-of-range phrase must degrade to the same "not recognized"
// path every other bad input takes.
function finiteDate(date: Date | undefined): Date | undefined {
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

export function resolveRelativeTimePhrase(phrase: string, now: () => Date): Date | undefined {
  const trimmed = phrase.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  const reference = now();

  // Korean is the user's native input language; "내일 오후 3시"
  // must resolve as readily as "tomorrow 3pm". Tried before the
  // English patterns since Korean phrases never collide with them.
  const korean = finiteDate(resolveKoreanRelativePhrase(phrase.trim(), reference));
  if (korean) {
    return korean;
  }

  const inMatch = /^in\s+(\d+)\s+(minute|hour|day|week|month)s?$/u.exec(trimmed);
  if (inMatch) {
    const amount = Number.parseInt(inMatch[1] ?? "0", 10);
    const unit = inMatch[2];
    // Month uses Date.setMonth for calendar semantics (Jan 15 +
    // 1mo → Feb 15, not +30d). Other units use a flat ms offset.
    if (unit === "month") {
      const next = new Date(reference);
      next.setMonth(next.getMonth() + amount);
      return finiteDate(next);
    }
    const offsetMs = unit === "minute" ? amount * 60_000
      : unit === "hour" ? amount * 3_600_000
      : unit === "day" ? amount * 86_400_000
      : unit === "week" ? amount * 7 * 86_400_000
      : 0;
    return finiteDate(new Date(reference.getTime() + offsetMs));
  }

  const dayPattern = /^(today|tomorrow|next\s+([a-z]+)|([a-z]+))(?:\s+(?:at\s+)?(.+))?$/u;
  const dayMatch = dayPattern.exec(trimmed);
  if (!dayMatch) {
    return undefined;
  }
  const head = dayMatch[1] ?? "";
  const explicitWeekday = dayMatch[2] ?? dayMatch[3];
  const timeSpec = dayMatch[4];

  let targetDay: Date;
  if (head === "today") {
    targetDay = startOfDay(reference);
  } else if (head === "tomorrow") {
    targetDay = startOfDay(new Date(reference.getTime() + 86_400_000));
  } else if (explicitWeekday !== undefined) {
    const targetIndex = WEEKDAY_INDEX[explicitWeekday];
    if (targetIndex === undefined) {
      return undefined;
    }
    const referenceDay = startOfDay(reference);
    let delta = (targetIndex - referenceDay.getDay() + 7) % 7;
    if (delta === 0) {
      delta = 7;
    }
    targetDay = new Date(referenceDay.getTime() + delta * 86_400_000);
  } else {
    return undefined;
  }

  const timeOfDay = parseTimeOfDay(timeSpec);
  if (timeOfDay === "invalid") {
    return undefined;
  }
  targetDay.setHours(timeOfDay.hour, timeOfDay.minute, 0, 0);
  return finiteDate(targetDay);
}

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function parseTimeOfDay(spec: string | undefined): { hour: number; minute: number } | "invalid" {
  if (spec === undefined) {
    return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
  }
  const cleaned = spec.trim().toLowerCase();
  if (cleaned === "noon") {
    return { hour: 12, minute: 0 };
  }
  if (cleaned === "midnight") {
    return { hour: 0, minute: 0 };
  }
  const ampmMatch = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/u.exec(cleaned);
  if (ampmMatch) {
    const rawHour = Number.parseInt(ampmMatch[1] ?? "0", 10);
    const minute = Number.parseInt(ampmMatch[2] ?? "0", 10);
    const ampm = ampmMatch[3];
    if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) {
      return "invalid";
    }
    const hour = ampm === "pm"
      ? (rawHour === 12 ? 12 : rawHour + 12)
      : (rawHour === 12 ? 0 : rawHour);
    return { hour, minute };
  }
  const hhmmMatch = /^(\d{1,2}):(\d{2})$/u.exec(cleaned);
  if (hhmmMatch) {
    const hour = Number.parseInt(hhmmMatch[1] ?? "0", 10);
    const minute = Number.parseInt(hhmmMatch[2] ?? "0", 10);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return "invalid";
    }
    return { hour, minute };
  }
  return "invalid";
}

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
function resolveKoreanRelativePhrase(phrase: string, reference: Date): Date | undefined {
  const offset = resolveKoreanDurationOffset(phrase, reference);
  if (offset) {
    return offset;
  }
  const weekday = resolveKoreanWeekdayPhrase(phrase, reference);
  if (weekday) {
    return weekday;
  }
  const match = /^(오늘|내일|모레|글피)(?:\s+(.+))?$/u.exec(phrase);
  if (!match) {
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
    const next = new Date(reference);
    next.setMonth(next.getMonth() + amount);
    return next;
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
  if (cleaned === "정오") {
    return { hour: 12, minute: 0 };
  }
  if (cleaned === "자정") {
    return { hour: 0, minute: 0 };
  }
  const m = /^(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(?:(\d{1,2})\s*분|(반)))?$/u.exec(cleaned);
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
  if (meridiem === "오후") {
    if (rawHour < 1 || rawHour > 12) return "invalid";
    return { hour: rawHour === 12 ? 12 : rawHour + 12, minute };
  }
  if (meridiem === "오전") {
    if (rawHour < 1 || rawHour > 12) return "invalid";
    return { hour: rawHour === 12 ? 0 : rawHour, minute };
  }
  // No 오전/오후 marker → treat as a 24-hour clock ("15시").
  if (rawHour < 0 || rawHour > 23) {
    return "invalid";
  }
  return { hour: rawHour, minute };
}
