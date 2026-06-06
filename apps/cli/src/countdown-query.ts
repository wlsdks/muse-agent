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

/** Korean fixed-date holidays → a phrase `parseReminderDueAt` understands (lunar ones — 설날/추석 — are intentionally omitted). */
const KO_HOLIDAYS: Record<string, string> = {
  "크리스마스": "December 25", "성탄절": "December 25", "크리스마스 이브": "December 24",
  "신정": "January 1", "새해": "January 1", "핼러윈": "October 31", "할로윈": "October 31",
  "발렌타인데이": "February 14", "발렌타인 데이": "February 14"
};
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// Korean countdown: "<target>까지 며칠/몇 주/얼마나 (남았어)?". The target precedes
// "까지" (the EN form trails "until"). parseReminderDueAt remains the precision gate.
const KO_COUNTDOWN_RE = /^(.+?)\s*까지\s*(며칠|몇\s*일|몇\s*주|얼마나)/u;

/** "12월 25일" → "December 25" (a form the date grammar resolves); null if not a Korean month-day. */
function koMonthDayToEnglish(phrase: string): string | null {
  const m = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/u.exec(phrase.trim());
  if (!m) {
    return null;
  }
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    return null;
  }
  return `${EN_MONTHS[mo - 1]} ${d.toString()}`;
}

/**
 * Detect a pure countdown question and return its time unit + the target date
 * phrase to resolve, or null. Handles "how many days/weeks until X", "how long
 * until X", "days until X", "countdown to X" — with named holidays (Christmas,
 * New Year, Halloween, Valentine's) resolved to a parseable date. The caller
 * still validates the phrase with `parseReminderDueAt`, so a non-date remainder
 * never hijacks retrieval.
 */
export function detectCountdownQuery(query: string): { readonly unit: "days" | "weeks"; readonly targetPhrase: string; readonly ko: boolean } | null {
  const trimmed = query.trim().replace(/[?.!]+$/u, "").trim();
  if (/[가-힣]/u.test(trimmed)) {
    const km = KO_COUNTDOWN_RE.exec(trimmed);
    if (km) {
      const unit = km[2]!.replace(/\s+/gu, "").startsWith("몇주") ? "weeks" : "days";
      const target = km[1]!.trim();
      const targetPhrase = KO_HOLIDAYS[target] ?? koMonthDayToEnglish(target) ?? target;
      if (targetPhrase.length > 0) {
        return { ko: true, targetPhrase, unit };
      }
    }
    return null;
  }
  const q = trimmed.toLowerCase();
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
  return { ko: false, targetPhrase, unit };
}

/** Whole calendar days from `now`'s local date to the target ISO date (UTC midnight from the date grammar). Pure. */
export function countdownDays(now: Date, targetIso: string): number {
  const t = new Date(targetIso);
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((b - a) / DAY_MS);
}

/** "There are 203 days until Friday, December 25, 2026." — date rendered in UTC so the grammar's UTC-midnight date doesn't shift. Pure. */
export function formatCountdown(unit: "days" | "weeks", days: number, targetIso: string, ko = false): string {
  if (ko) {
    const koDate = new Date(targetIso).toLocaleDateString("ko-KR", {
      timeZone: "UTC", day: "numeric", month: "long", weekday: "long", year: "numeric"
    });
    if (days === 0) {
      return `${koDate}, 오늘입니다!`;
    }
    if (unit === "weeks") {
      return `${koDate}까지 약 ${Math.round(days / 7).toString()}주 남았습니다.`;
    }
    return `${koDate}까지 ${days.toString()}일 남았습니다.`;
  }
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
