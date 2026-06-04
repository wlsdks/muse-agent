/**
 * `muse ask`'s pure date-countdown fast-path — "how many days until X?". The
 * local 8B is CONFIDENTLY WRONG at counting days across months/year boundaries
 * (it answered "Christmas" 198 when it's 203, "March 1" 245 when it's 269), the
 * worst failure mode for a trust-first assistant. So a query that is nothing but
 * a countdown is answered EXACTLY here: this file detects the question + the
 * target phrase (resolving named holidays to a date), the caller resolves the
 * phrase through the reminder/task date grammar (`parseReminderDueAt`, which
 * rolls a past month-day to its NEXT occurrence — "March 1" → next March), and
 * the day count is computed deterministically. Precision-first: a phrase the
 * date grammar can't parse falls through to recall.
 */

const DAY_MS = 86_400_000;

/** Fixed-date holidays → a phrase `parseReminderDueAt` understands. (Variable-date ones like Thanksgiving are intentionally omitted.) */
const HOLIDAYS: Record<string, string> = {
  christmas: "December 25", "christmas day": "December 25", "christmas eve": "December 24", xmas: "December 25",
  "new year": "January 1", "new years": "January 1", "new year's": "January 1", "new year's day": "January 1", "new years day": "January 1",
  "new year's eve": "December 31", "new years eve": "December 31",
  halloween: "October 31",
  "valentine's day": "February 14", "valentines day": "February 14", "valentine's": "February 14", valentines: "February 14"
};

const COUNTDOWN_RE = /^(?:how\s+many\s+(days?|weeks?)|how\s+(?:long|soon)|(days?|weeks?)|countdown)\s+(?:until|till|til|to|before)\s+(.+)$/u;

/**
 * Detect a pure countdown question and return its time unit + the target date
 * phrase to resolve, or null. Handles "how many days/weeks until X", "how long
 * until X", "days until X", "countdown to X" — with named holidays (Christmas,
 * New Year, Halloween, Valentine's) resolved to a parseable date. The caller
 * still validates the phrase with `parseReminderDueAt`, so a non-date remainder
 * never hijacks retrieval.
 */
export function detectCountdownQuery(query: string): { readonly unit: "days" | "weeks"; readonly targetPhrase: string } | null {
  const q = query.trim().toLowerCase().replace(/[?.!]+$/u, "").trim();
  const m = COUNTDOWN_RE.exec(q);
  if (!m) {
    return null;
  }
  const unitRaw = m[1] ?? m[2];
  const unit = unitRaw?.startsWith("week") ? "weeks" : "days";
  const raw = m[3]!.trim().replace(/^(?:the|my)\s+/u, "").trim();
  const targetPhrase = HOLIDAYS[raw] ?? raw;
  if (targetPhrase.length === 0) {
    return null;
  }
  return { targetPhrase, unit };
}

/** Whole calendar days from `now`'s local date to the target ISO date (UTC midnight from the date grammar). Pure. */
export function countdownDays(now: Date, targetIso: string): number {
  const t = new Date(targetIso);
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((b - a) / DAY_MS);
}

/** "There are 203 days until Friday, December 25, 2026." — date rendered in UTC so the grammar's UTC-midnight date doesn't shift. Pure. */
export function formatCountdown(unit: "days" | "weeks", days: number, targetIso: string): string {
  const date = new Date(targetIso).toLocaleDateString("en-US", {
    timeZone: "UTC", day: "numeric", month: "long", weekday: "long", year: "numeric"
  });
  if (days === 0) {
    return `${date} is today!`;
  }
  if (unit === "weeks") {
    const weeks = Math.round(days / 7);
    return `There ${weeks === 1 ? "is about 1 week" : `are about ${weeks.toString()} weeks`} until ${date}.`;
  }
  return `There ${days === 1 ? "is 1 day" : `are ${days.toString()} days`} until ${date}.`;
}
