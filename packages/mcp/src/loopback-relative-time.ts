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

export function resolveRelativeTimePhrase(phrase: string, now: () => Date): Date | undefined {
  const trimmed = phrase.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }
  const reference = now();

  const inMatch = /^in\s+(\d+)\s+(minute|hour|day|week|month)s?$/u.exec(trimmed);
  if (inMatch) {
    const amount = Number.parseInt(inMatch[1] ?? "0", 10);
    const unit = inMatch[2];
    // Month uses Date.setMonth for calendar semantics (Jan 15 +
    // 1mo → Feb 15, not +30d). Other units use a flat ms offset.
    if (unit === "month") {
      const next = new Date(reference);
      next.setMonth(next.getMonth() + amount);
      return next;
    }
    const offsetMs = unit === "minute" ? amount * 60_000
      : unit === "hour" ? amount * 3_600_000
      : unit === "day" ? amount * 86_400_000
      : unit === "week" ? amount * 7 * 86_400_000
      : 0;
    return new Date(reference.getTime() + offsetMs);
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
  return targetDay;
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
