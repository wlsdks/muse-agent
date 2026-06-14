/**
 * Relative-time phrase resolver shared by `muse.tasks.add` (dueAt)
 * and `muse.calendar.add` (startsAt / endsAt).
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
 *   "in 1 month" / "in 3 months"                 → calendar-month offset
 *   "next monday" / "next mon"                   → next Monday at 09:00
 *   "next monday at 6pm" / "next monday 6pm"     → next Monday at 18:00
 *   "next week"                                  → reference + 7 days at 09:00
 *   "next month" / "next year"                   → calendar +1mo / +12mo
 *   "this weekend" / "next weekend"              → this/next ISO-week Saturday 09:00
 *   "end of the month" / "end of month"          → last calendar day at 09:00
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
 *   "다음 주" / "다음 달" / "내년" → +7d / calendar +1mo / +12mo at 09:00
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

import { addCalendarMonths, DEFAULT_HOUR, DEFAULT_MINUTE, startOfDay } from "./loopback-relative-time-base.js";
import { resolveKoreanRelativePhrase } from "./loopback-relative-time-korean.js";

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};


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
const DECIMAL_OF_UNIT =
  /^in\s+(\d+\.\d+)\s+(second|minute|hour|day|week)s?$/u;
const TWO_UNIT_COMPOUND =
  /^in\s+(\d+)\s+(second|minute|hour|day|week)s?\s+(?:and\s+)?(\d+)\s+(second|minute|hour|day|week)s?$/u;

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
  const decimal = DECIMAL_OF_UNIT.exec(phrase);
  if (decimal) {
    const amount = Number(decimal[1]);
    const unitMs = FLAT_UNIT_MS[decimal[2] ?? ""];
    if (unitMs === undefined || !Number.isFinite(amount)) return undefined;
    return Math.round(amount * unitMs);
  }
  const compoundPair = TWO_UNIT_COMPOUND.exec(phrase);
  if (compoundPair) {
    const n1 = Number.parseInt(compoundPair[1] ?? "", 10);
    const ms1 = FLAT_UNIT_MS[compoundPair[2] ?? ""];
    const n2 = Number.parseInt(compoundPair[3] ?? "", 10);
    const ms2 = FLAT_UNIT_MS[compoundPair[4] ?? ""];
    if (ms1 === undefined || ms2 === undefined || !Number.isFinite(n1) || !Number.isFinite(n2)) {
      return undefined;
    }
    return n1 * ms1 + n2 * ms2;
  }
  return undefined;
}

/**
 * Map a day-part word + a clock spec to a 24h time, letting the day-part supply
 * the AM/PM when the user wrote only a bare 1-12 hour: "morning at 8" → 08:00,
 * "evening at 6" → 18:00, "tonight at 8" → 20:00 (night), "night at 12" →
 * midnight. An EXPLICIT am/pm or HH:MM (or a 13-23 hour) is honoured as written —
 * the day-part bias only fills the gap a bare hour leaves.
 */
function dayPartBiasedTime(part: string, timeSpec: string): { hour: number; minute: number } | undefined {
  const cleaned = timeSpec.trim().toLowerCase();
  const bareHour = /^(\d{1,2})$/u.exec(cleaned);
  if (bareHour) {
    const raw = Number.parseInt(bareHour[1] ?? "", 10);
    if (!Number.isFinite(raw) || raw < 0 || raw > 23) return undefined;
    if (raw < 1 || raw > 12) {
      return { hour: raw, minute: 0 }; // already a 24h hour ("evening at 20")
    }
    const pm = part === "afternoon" || part === "evening" || part === "night";
    if (!pm) {
      return { hour: raw === 12 ? 0 : raw, minute: 0 }; // morning
    }
    if (part === "night" && raw === 12) {
      return { hour: 0, minute: 0 }; // "tonight at 12" → midnight
    }
    return { hour: raw === 12 ? 12 : raw + 12, minute: 0 };
  }
  const explicit = parseTimeOfDay(cleaned); // am/pm, HH:MM, noon/midnight — honour as written
  return explicit === "invalid" ? undefined : explicit;
}

/**
 * A standalone day-part phrase, optionally with a clock time, → that time TODAY:
 * "tonight" / "this evening" → the slot's default hour; "tonight at 8" → 20:00;
 * "this morning at 8" → 08:00. A day-headed form ("tomorrow morning at 9") is
 * handled by the dayPattern + parseTimeOfDay path, so the two never overlap.
 */
function standaloneDayPartTime(phrase: string): { hour: number; minute: number } | undefined {
  const m = /^(?:(tonight)|(?:this\s+)?(morning|afternoon|evening|night))(?:\s+(?:at\s+)?(.+))?$/u.exec(phrase);
  if (!m) {
    return undefined;
  }
  const part = m[1] ? "night" : (m[2] ?? "");
  const timeSpec = m[3];
  if (timeSpec === undefined) {
    return { hour: DAY_PART_HOURS[part] ?? DEFAULT_HOUR, minute: 0 };
  }
  return dayPartBiasedTime(part, timeSpec);
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
    // Re-validate the +1-year roll: "feb 29" in a leap year rolls into a
    // non-leap next year where new Date silently overflows to March 1. Fail
    // safe — return undefined, never a date the user did not ask for.
    const rolled = new Date(year + 1, monthIndex, day, time.hour, time.minute, 0, 0);
    return rolled.getMonth() === monthIndex && rolled.getDate() === day ? rolled : undefined;
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
 * A recurring-reminder phrase carries a cadence PREFIX the date resolver
 * doesn't need: "매주 월요일 오전 9시" / "매일 아침 8시" / "every monday 9am" /
 * "every day 8am". Strip it so the FIRST occurrence resolves (the reminders
 * tool infers the cadence separately via `recurrenceFromPhrase`). Returns the
 * phrase unchanged when no recurrence prefix is present — the `!==` guard in
 * the caller then prevents re-stripping / infinite recursion.
 */
export function stripRecurrencePrefix(phrase: string): string {
  return phrase
    .replace(/^\s*매\s*(?:주|일|달|월|년|해)\s+/u, "")
    .replace(/^\s*(?:every|each)\s+(?:day|week|month|year)\s+/iu, "")
    .replace(/^\s*(?:every|each)\s+(?=mon|tue|wed|thu|fri|sat|sun)/iu, "");
}

/**
 * The repeat cadence a phrase implies, or undefined for a one-shot. Lets the
 * reminders tool set `recurrence` deterministically when the local model fills
 * the time ("매주 월요일 아침 9시") but FORGETS the separate `recurrence` arg —
 * a weekly medication reminder must not silently become a one-time one.
 */
export function recurrenceFromPhrase(phrase: string): "daily" | "weekly" | "monthly" | "yearly" | undefined {
  const t = phrase.toLowerCase();
  if (/매일|daily|every\s+day/u.test(t)) return "daily";
  if (/매주|weekly|every\s+week|every\s+(?:mon|tue|wed|thu|fri|sat|sun)/u.test(t)) return "weekly";
  if (/매달|매월|monthly|every\s+month/u.test(t)) return "monthly";
  if (/매년|매해|yearly|annually|every\s+year/u.test(t)) return "yearly";
  return undefined;
}

// A phrase that is ONLY a time-of-day ("오후 4시", "4pm", "16:00") — no date. A
// reschedule given one of these must keep the existing item's DATE, so callers
// anchor it to that item's own day instead of resolving against `now` (which
// silently moves the event/task to today).
const TIME_ONLY_PHRASE_RE = /^(오전|오후)?\s*\d{1,2}\s*시(\s*반|\s*\d{1,2}\s*분)?$|^\d{1,2}:\d{2}\s*(am|pm)?$|^\d{1,2}\s*(am|pm)$/iu;

export function isTimeOnlyPhrase(phrase: string): boolean {
  return TIME_ONLY_PHRASE_RE.test(phrase.trim());
}

/** Local midnight of `date`'s calendar day — the anchor for a time-only reschedule. */
export function startOfLocalDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

// Does the phrase name a clock time at all? A DATE-only reschedule ("월요일로
// 옮겨줘") has none — it must keep the item's existing time-of-day rather than
// reset to a default midnight. Inclusive on purpose: a missed time marker only
// preserves the original time (a safe default), while never overriding a time
// the user DID state.
const TIME_COMPONENT_RE = /\d{1,2}\s*시|\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|오전|오후|정각|noon|midnight|morning|afternoon|evening|night|새벽|아침|점심|저녁|밤/iu;

export function hasTimeComponent(phrase: string): boolean {
  return TIME_COMPONENT_RE.test(phrase);
}

/** Combine `date`'s calendar day with `time`'s local clock time — for a date-only
 *  reschedule that must keep the item's original time-of-day. */
export function withTimeOfDay(date: Date, time: Date): Date {
  const out = new Date(date);
  out.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
  return out;
}

// `resolveRelativeTimePhrase` lands a bare DATE ("다음 주 월요일", "2026-06-20") at
// UTC midnight — its no-time default. This is the reliable signal that a
// reschedule phrase carried a date but no time (so the item's own time-of-day
// should be kept), distinguishing it from a relative OFFSET ("in 30 minutes")
// that resolves to now-plus-delta, NOT midnight. Pair with `hasTimeComponent` so
// an explicit "오전 9시" (= 00:00Z in KST) is never mistaken for a bare date.
export function isUtcMidnight(date: Date): boolean {
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}

/**
 * Does a YYYY-MM-DD head (year, month 1-12, day) round-trip through `Date.UTC`
 * unchanged? `new Date("2026-02-30")` silently rolls over to Mar 2 rather than
 * failing; a real calendar date does not. The shared rollover guard behind the
 * task / calendar / time date parsers — reject a head this returns false for
 * (each caller keeps its own fall-through: Error / undefined / relative-phrase).
 */
export function isoDateHeadRoundTrips(year: number, month1to12: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month1to12 - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month1to12 - 1 && probe.getUTCDate() === day;
}

export function resolveRelativeTimePhrase(phrase: string, now: () => Date): Date | undefined {
  const trimmed = phrase.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  const reference = now();

  // Recurring phrases ("매주 월요일 오전 9시", "every monday 9am") fail every
  // pattern below because of the leading cadence word — strip it and resolve
  // the remainder as the first occurrence.
  const deRecurred = stripRecurrencePrefix(phrase.trim());
  if (deRecurred !== phrase.trim() && deRecurred.length > 0) {
    return resolveRelativeTimePhrase(deRecurred, now);
  }

  // Korean is the user's native input language; "내일 오후 3시"
  // must resolve as readily as "tomorrow 3pm". Tried before the
  // English patterns since Korean phrases never collide with them.
  const korean = finiteDate(resolveKoreanRelativePhrase(phrase.trim(), reference));
  if (korean) {
    return korean;
  }

  // "in" is optional: a bare duration ("2 hours", "30 minutes", "a week") reads
  // as that offset from now — the natural form, especially via `remind snooze
  // --in "2 hours"` where the word "in" is already in the flag.
  const inMatch = /^(?:in\s+)?(\d+|an?)\s+(second|minute|hour|day|week|month)s?$/u.exec(trimmed);
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

  // Compact unit-suffix form ("in 1h", "in 30m", "in 2d", "in 90 mins").
  // Disjoint from the full-word handler above (which requires a space
  // + a spelled-out unit). `m` = minute, matching the project's own
  // `/loop` interval grammar (Nm/Nh/Nd/Ns); no month abbrev — `mo`
  // collides with `m` and the codebase rejects ambiguous phrases.
  const compactMatch = /^(?:in\s+)?(\d+)\s*(secs?|s|mins?|m|hrs?|h|d|w)$/u.exec(trimmed);
  if (compactMatch) {
    const amount = Number.parseInt(compactMatch[1] ?? "0", 10);
    const token = compactMatch[2] ?? "";
    const unitMs = token === "s" || token === "sec" || token === "secs" ? 1000
      : token === "m" || token === "min" || token === "mins" ? 60_000
      : token === "h" || token === "hr" || token === "hrs" ? 3_600_000
      : token === "d" ? 86_400_000
      : token === "w" ? 7 * 86_400_000
      : 0;
    return finiteDate(new Date(reference.getTime() + amount * unitMs));
  }

  const fractionalMs = resolveFractionalDurationMs(trimmed);
  if (fractionalMs !== undefined) {
    return finiteDate(new Date(reference.getTime() + fractionalMs));
  }

  const standaloneTime = standaloneDayPartTime(trimmed);
  if (standaloneTime !== undefined) {
    const day = startOfDay(reference);
    day.setHours(standaloneTime.hour, standaloneTime.minute, 0, 0);
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

  // "day after tomorrow" (+2 days) — English counterpart of the
  // Korean "모레" the grammar already supports; the bare-`[a-z]+`
  // dayPattern would otherwise treat "day" as a weekday and fail.
  const dayAfter = /^(?:the\s+)?day\s+after\s+tomorrow(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (dayAfter) {
    const time = parseTimeOfDay(dayAfter[1]);
    if (time === "invalid") {
      return undefined;
    }
    const target = startOfDay(new Date(reference.getTime() + 2 * 86_400_000));
    target.setHours(time.hour, time.minute, 0, 0);
    return finiteDate(target);
  }

  const absoluteDate = finiteDate(resolveAbsoluteMonthDate(trimmed, reference));
  if (absoluteDate) {
    return absoluteDate;
  }

  // "next week" / "next month" / "next year" — period offsets the weekday
  // `next <day>` pattern below would mis-read ("week"/"month"/"year" aren't
  // weekdays, so they fell through to UNRESOLVED). week → +7d; month/year →
  // calendar offset (same semantics as "in 1 month"). "remind me next month"
  // is as natural as "in 1 month" and must work.
  const periodMatch = /^(?:next|the\s+following)\s+(week|month|year)(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (periodMatch) {
    const periodTime = parseTimeOfDay(periodMatch[2]);
    if (periodTime === "invalid") {
      return undefined;
    }
    const periodUnit = periodMatch[1];
    const periodTarget = periodUnit === "week"
      ? startOfDay(new Date(reference.getTime() + 7 * 86_400_000))
      : startOfDay(addCalendarMonths(reference, periodUnit === "month" ? 1 : 12));
    periodTarget.setHours(periodTime.hour, periodTime.minute, 0, 0);
    return finiteDate(periodTarget);
  }

  // "this weekend" / "next weekend" → the (this/next ISO week) Saturday at 09:00.
  // "remind me this weekend to call home" is everyday phrasing the weekday
  // pattern can't reach ("weekend" isn't a weekday).
  const weekendMatch = /^(this|next)\s+weekend(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (weekendMatch) {
    const weekendTime = parseTimeOfDay(weekendMatch[2]);
    if (weekendTime === "invalid") {
      return undefined;
    }
    const base = startOfDay(reference);
    let delta = (6 - base.getDay() + 7) % 7; // upcoming Saturday (today if Sat)
    if (weekendMatch[1] === "next") {
      delta += 7;
    }
    const weekendTarget = new Date(base.getTime() + delta * 86_400_000);
    weekendTarget.setHours(weekendTime.hour, weekendTime.minute, 0, 0);
    return finiteDate(weekendTarget);
  }

  // "end of the month" / "end of month" / "end of this month" → last calendar
  // day at 09:00 (Date(y, m+1, 0) = last day of month m). "end of NEXT month" is
  // just as natural and pins the following month's last day (offset +1).
  const monthEndMatch = /^(?:the\s+)?end\s+of\s+(the\s+|this\s+|next\s+)?month(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (monthEndMatch) {
    const monthEndTime = parseTimeOfDay(monthEndMatch[2]);
    if (monthEndTime === "invalid") {
      return undefined;
    }
    const monthEndOffset = monthEndMatch[1]?.trim() === "next" ? 1 : 0;
    const lastDay = new Date(reference.getFullYear(), reference.getMonth() + 1 + monthEndOffset, 0);
    lastDay.setHours(monthEndTime.hour, monthEndTime.minute, 0, 0);
    return finiteDate(lastDay);
  }

  // "the 25th of next month" / "the 1st of this month" — a day-of-month pinned to
  // an explicit relative month. MUST precede the bare "the Nth" handler below,
  // whose `(.+)` time slot would otherwise swallow "of next month" and fail it.
  // "of next month" is the one phrasing with no offset alternative (you can't say
  // "in N days" without counting), so it's high-value. An explicit month is
  // honoured literally (even a past day this month); a day absent from the target
  // month (the 31st of a 30-day month) is rejected, not silently rolled.
  const domOfMonthMatch = /^(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(this|next)\s+month(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (domOfMonthMatch) {
    const dom = Number.parseInt(domOfMonthMatch[1] ?? "", 10);
    if (Number.isInteger(dom) && dom >= 1 && dom <= 31) {
      const domTime = parseTimeOfDay(domOfMonthMatch[3]);
      if (domTime === "invalid") {
        return undefined;
      }
      const monthOffset = domOfMonthMatch[2] === "next" ? 1 : 0;
      const target = new Date(reference.getFullYear(), reference.getMonth() + monthOffset, dom, domTime.hour, domTime.minute, 0, 0);
      return finiteDate(target.getDate() === dom ? target : undefined);
    }
  }

  // "the 25th" / "on the 25th" / "the 1st at 9am" — a bare day-of-month with NO
  // month named resolves to the NEXT occurrence of that day: this month if it
  // hasn't passed, else next month. "Remind me on the 25th to pay rent" / "rent
  // is due the 1st" is everyday phrasing the month-NAME parser above can't reach
  // (it needs "June 25"). The time-aware roll keeps a same-day-but-earlier time
  // out of the past, and the getDate guard rolls a day absent from the current
  // month (e.g. the 31st of a 30-day month) onto the next month that has it.
  const dayOfMonthMatch = /^(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)(?:\s+(?:at\s+)?(.+))?$/u.exec(trimmed);
  if (dayOfMonthMatch) {
    const dom = Number.parseInt(dayOfMonthMatch[1] ?? "", 10);
    if (Number.isInteger(dom) && dom >= 1 && dom <= 31) {
      const domTime = parseTimeOfDay(dayOfMonthMatch[2]);
      if (domTime === "invalid") {
        return undefined;
      }
      // Roll forward month-by-month to the next one that ACTUALLY HAS this day,
      // re-checking getDate() each step. A single +1-month roll overflows a short
      // month (new Date(2026, 1, 31) = Feb 31 → March 3); the loop lands on March 31.
      let domTarget = new Date(reference.getFullYear(), reference.getMonth(), dom, domTime.hour, domTime.minute, 0, 0);
      for (let ahead = 1; (domTarget.getDate() !== dom || domTarget.getTime() <= reference.getTime()) && ahead <= 12; ahead += 1) {
        domTarget = new Date(reference.getFullYear(), reference.getMonth() + ahead, dom, domTime.hour, domTime.minute, 0, 0);
      }
      return domTarget.getDate() === dom ? finiteDate(domTarget) : undefined;
    }
  }

  // "this friday" is as common as "next friday"; treat both as the next
  // occurrence of that weekday (you can't schedule a past one). Without "this"
  // here it was mis-parsed as a bare weekday "this" → unresolved, so the model's
  // natural "add a meeting this friday at 3pm" failed at calendar.add.
  const dayPattern = /^(today|tomorrow|(?:next|this)\s+([a-z]+)|([a-z]+))(?:\s+(?:at\s+)?(.+))?$/u;
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
  // Day-part + an explicit clock time ("tomorrow morning at 9", "monday evening
  // at 6") — the day-part biases a bare 1-12 hour to AM/PM.
  const dayPartTimeMatch = /^(morning|afternoon|evening|night)\s+(?:at\s+)?(.+)$/u.exec(cleaned);
  if (dayPartTimeMatch) {
    return dayPartBiasedTime(dayPartTimeMatch[1] ?? "", dayPartTimeMatch[2] ?? "") ?? "invalid";
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

