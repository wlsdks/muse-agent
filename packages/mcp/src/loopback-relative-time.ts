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

const DAY_PART_HOURS: Record<string, number> = {
  morning: 9,
  afternoon: 15,
  evening: 18,
  night: 21
};

// Standalone day-part phrase ("tonight", "this evening",
// "afternoon") → that hour TODAY. "tonight" is the natural
// synonym for the night slot. Bare/`this `-prefixed only — a
// day-headed form like "tomorrow evening" is handled by the
// dayPattern + parseTimeOfDay path, so the two never overlap.
const FLAT_UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000
};
const FRACTION_OF_UNIT =
  /^in\s+(?:an?\s+)?(half|quarter|three\s+quarters)\s+(?:of\s+)?(?:an?\s+)?(second|minute|hour|day|week)s?$/u;
const UNIT_AND_A_HALF =
  /^in\s+(\d+|an?)\s+(second|minute|hour|day|week)s?\s+and\s+a\s+half$/u;

// Precise fractional/compound durations the plain `in N <unit>`
// pattern can't express: "in half an hour" (30m), "in a quarter
// of an hour" (15m), "in three quarters of an hour" (45m), "in
// an hour and a half" (90m), "in 2 days and a half". Exact —
// every fraction × FLAT_UNIT_MS is an integer ms. Vague
// quantities ("a few", "a couple") are intentionally NOT here.
function resolveFractionalDurationMs(phrase: string): number | undefined {
  const frac = FRACTION_OF_UNIT.exec(phrase);
  if (frac) {
    const word = frac[1] ?? "";
    const unitMs = FLAT_UNIT_MS[frac[2] ?? ""];
    if (unitMs === undefined) return undefined;
    const factor = word === "half" ? 0.5 : word === "quarter" ? 0.25 : 0.75;
    return unitMs * factor;
  }
  const compound = UNIT_AND_A_HALF.exec(phrase);
  if (compound) {
    const raw = compound[1] ?? "";
    const qty = raw === "a" || raw === "an" ? 1 : Number.parseInt(raw, 10);
    const unitMs = FLAT_UNIT_MS[compound[2] ?? ""];
    if (unitMs === undefined || !Number.isFinite(qty)) return undefined;
    return unitMs * (qty + 0.5);
  }
  return undefined;
}

function standaloneDayPartHour(phrase: string): number | undefined {
  const key = phrase === "tonight"
    ? "night"
    : /^(?:this\s+)?(morning|afternoon|evening|night)$/u.exec(phrase)?.[1];
  return key === undefined ? undefined : DAY_PART_HOURS[key];
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11
};
const MONTH_ALT = Object.keys(MONTHS).join("|");
const MONTH_FIRST = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?(?:\\s+(?:at\\s+)?(.+))?$`, "u");
const DAY_FIRST = new RegExp(`^(\\d{1,2})\\s+(${MONTH_ALT})(?:,?\\s+(\\d{4}))?(?:\\s+(?:at\\s+)?(.+))?$`, "u");

// Absolute month-name date: "May 20", "Dec 25 at 3pm",
// "June 1 9am", "20 May 2027". No explicit year + already past
// this year → next occurrence, matching the weekday "next"
// convention. Reuses parseTimeOfDay (undefined timeSpec → 09:00,
// same as a bare day word); a malformed trailing time fails the
// whole phrase rather than silently defaulting.
function resolveAbsoluteMonthDate(phrase: string, reference: Date): Date | undefined {
  let monthName: string | undefined;
  let dayStr: string | undefined;
  let yearStr: string | undefined;
  let timeSpec: string | undefined;
  const mf = MONTH_FIRST.exec(phrase);
  if (mf) {
    [, monthName, dayStr, yearStr, timeSpec] = mf;
  } else {
    const df = DAY_FIRST.exec(phrase);
    if (df) {
      [, dayStr, monthName, yearStr, timeSpec] = df;
    }
  }
  if (monthName === undefined || dayStr === undefined) return undefined;
  const monthIndex = MONTHS[monthName];
  if (monthIndex === undefined) return undefined;
  const day = Number.parseInt(dayStr, 10);
  if (day < 1 || day > 31) return undefined;
  const time = parseTimeOfDay(timeSpec);
  if (time === "invalid") return undefined;
  const year = yearStr !== undefined ? Number.parseInt(yearStr, 10) : reference.getFullYear();
  const built = new Date(year, monthIndex, day, time.hour, time.minute, 0, 0);
  if (built.getFullYear() !== year || built.getMonth() !== monthIndex || built.getDate() !== day) {
    return undefined;
  }
  if (yearStr === undefined && built.getTime() < reference.getTime()) {
    return new Date(year + 1, monthIndex, day, time.hour, time.minute, 0, 0);
  }
  return built;
}

// A huge offset ("in 9999999999 days", "99999999999일 후") or a
// month overflow pushes the Date past ±8.64e15 ms → an Invalid
// Date (NaN time). Returning that lets the caller's
// `relative.toISOString()` throw an unhandled RangeError; an
// out-of-range phrase must degrade to the same "not recognized"
// path every other bad input takes.
function finiteDate(date: Date | undefined): Date | undefined {
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * `reference + amount` calendar months. Raw `Date.setMonth`
 * overflows — Jan 31 + 1mo becomes Mar 3 because Feb has no 31st —
 * which silently lands a reminder in the wrong month. Clamp the
 * day back to the last day of the intended month instead.
 */
function addCalendarMonths(reference: Date, amount: number): Date {
  const next = new Date(reference);
  const targetMonth = next.getMonth() + amount;
  next.setMonth(targetMonth);
  if (next.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    next.setDate(0);
  }
  return next;
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

  const inMatch = /^in\s+(\d+|an?)\s+(second|minute|hour|day|week|month)s?$/u.exec(trimmed);
  if (inMatch) {
    const rawAmount = inMatch[1] ?? "0";
    const amount = rawAmount === "a" || rawAmount === "an"
      ? 1
      : Number.parseInt(rawAmount, 10);
    const unit = inMatch[2];
    // Month uses calendar semantics (Jan 15 + 1mo → Feb 15, not
    // +30d). Other units use a flat ms offset.
    if (unit === "month") {
      return finiteDate(addCalendarMonths(reference, amount));
    }
    const offsetMs = unit === "second" ? amount * 1000
      : unit === "minute" ? amount * 60_000
      : unit === "hour" ? amount * 3_600_000
      : unit === "day" ? amount * 86_400_000
      : unit === "week" ? amount * 7 * 86_400_000
      : 0;
    return finiteDate(new Date(reference.getTime() + offsetMs));
  }

  const fractionalMs = resolveFractionalDurationMs(trimmed);
  if (fractionalMs !== undefined) {
    return finiteDate(new Date(reference.getTime() + fractionalMs));
  }

  const standaloneHour = standaloneDayPartHour(trimmed);
  if (standaloneHour !== undefined) {
    const day = startOfDay(reference);
    day.setHours(standaloneHour, 0, 0, 0);
    return finiteDate(day);
  }

  // Bare time with no day word ("at 5pm", "5pm", "17:30",
  // "noon") → today at that time, matching the "today <time>"
  // semantics. Gated purely on parseTimeOfDay validity: every
  // day word ("today"/"tomorrow"/weekday) is "invalid" there and
  // falls through to dayPattern, so the two never overlap.
  const bareTimeSpec = /^at\s+(.+)$/u.exec(trimmed)?.[1] ?? trimmed;
  const bareTime = parseTimeOfDay(bareTimeSpec);
  if (bareTime !== "invalid") {
    const day = startOfDay(reference);
    day.setHours(bareTime.hour, bareTime.minute, 0, 0);
    return finiteDate(day);
  }

  const absoluteDate = finiteDate(resolveAbsoluteMonthDate(trimmed, reference));
  if (absoluteDate) {
    return absoluteDate;
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
  // Conventional day-part hours ("tomorrow morning", "monday
  // evening"); morning aligns with the bare-day DEFAULT_HOUR.
  const dayPartHour = DAY_PART_HOURS[cleaned];
  if (dayPartHour !== undefined) {
    return { hour: dayPartHour, minute: 0 };
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
  // Bare hour ("tomorrow at 3", "today 15") — read as a 24h hour,
  // symmetric with the Korean "15시" form and the HH:MM range.
  // No am/pm guessing: a user who means 3pm writes "3pm".
  const bareHourMatch = /^(\d{1,2})$/u.exec(cleaned);
  if (bareHourMatch) {
    const hour = Number.parseInt(bareHourMatch[1] ?? "", 10);
    if (hour < 0 || hour > 23) {
      return "invalid";
    }
    return { hour, minute: 0 };
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
