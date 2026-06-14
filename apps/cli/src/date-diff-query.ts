/**
 * `muse ask`'s pure date-DIFFERENCE fast-path — "how many days between June 1 and
 * August 15?". Distinct from the countdown fast-path (which counts from NOW to a
 * date): this counts between two GIVEN dates. The local 8B is confidently
 * imperfect at it (it answered one case 263 when it's 264 — off-by-one is still a
 * wrong answer a trust-first assistant should not give), so a query that is
 * nothing but a date difference is answered EXACTLY here. Precision-first: both
 * endpoints must parse as literal calendar dates, else it falls through to recall.
 *
 * It uses a LITERAL date parser (not the reminder grammar, which rolls a past
 * month-day forward to its next occurrence — wrong for a between-two-dates span):
 * a bare "June 1" means THIS year's June 1, and a "from X to Y" where Y lands
 * before X (e.g. Dec 20 → Jan 5) rolls Y forward one year.
 */

const DAY_MS = 86_400_000;

/**
 * Build a calendar date ONLY if y/m/d is a real date — `new Date(y,m,d)` silently
 * rolls an impossible date (Feb 30, a non-leap Feb 29) into the next month, so we
 * round-trip the components and return null instead. Used by the literal parser
 * AND the cross-year roll, so neither emits a confident count over a date the
 * user never typed (the fast-path bypasses the grounding gate — precision-first).
 */
function realDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d ? dt : null;
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11
};

interface LiteralDate {
  readonly date: Date;
  /** Whether the phrase named an explicit year (so cross-year rolling must NOT adjust it). */
  readonly hadYear: boolean;
}

/** Parse a LITERAL calendar date — ISO `YYYY-MM-DD`, "Month Day[, Year]", or today/tomorrow/yesterday — without the reminder grammar's forward-roll. Null if not a date. */
function parseLiteralDate(raw: string, now: Date): LiteralDate | null {
  const s = raw.trim().toLowerCase().replace(/(\d+)(?:st|nd|rd|th)\b/gu, "$1");
  const atMidnight = (y: number, m: number, d: number): Date => new Date(y, m, d);
  if (s === "today") return { date: atMidnight(now.getFullYear(), now.getMonth(), now.getDate()), hadYear: true };
  if (s === "tomorrow") return { date: new Date(atMidnight(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + DAY_MS), hadYear: true };
  if (s === "yesterday") return { date: new Date(atMidnight(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - DAY_MS), hadYear: true };
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(s);
  if (iso) {
    const date = realDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date ? { date, hadYear: true } : null;
  }
  // "Month Day[, Year]" or "Day Month [Year]"
  const monthDay = /^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/u.exec(s);
  const dayMonth = /^(\d{1,2})\s+([a-z]+)(?:,?\s+(\d{4}))?$/u.exec(s);
  const parts = monthDay
    ? { month: monthDay[1]!, day: Number(monthDay[2]), year: monthDay[3] }
    : dayMonth ? { month: dayMonth[2]!, day: Number(dayMonth[1]), year: dayMonth[3] } : null;
  if (parts) {
    const month = MONTHS[parts.month];
    if (month === undefined || parts.day < 1 || parts.day > 31) return null;
    const hadYear = parts.year !== undefined;
    const date = realDate(hadYear ? Number(parts.year) : now.getFullYear(), month, parts.day);
    return date ? { date, hadYear } : null;
  }
  return null;
}

const DIFF_RE = /^(?:how\s+many\s+(days?|weeks?|months?)|how\s+long)\s+(?:are\s+there\s+)?(?:between|from)\s+(.+?)\s+(?:and|to|until|till|-|–|—|through)\s+(.+)$/u;

export interface DateDiffResult {
  readonly unit: "days" | "weeks" | "months";
  readonly days: number;
  readonly from: Date;
  readonly to: Date;
}

/**
 * Detect a pure date-difference question and compute it, or null. Handles "how
 * many days/weeks/months between X and Y" and "how long from X to Y". Both
 * endpoints must parse as literal dates; returns null otherwise so recall is
 * never hijacked. A `from`-`to` span whose end precedes its start (both
 * year-less) rolls the end forward a year (Dec→Jan).
 */
export function detectDateDiffQuery(query: string, now: Date): DateDiffResult | null {
  const q = query.trim().toLowerCase().replace(/[?.!]+$/u, "").trim();
  const m = DIFF_RE.exec(q);
  if (!m) {
    return null;
  }
  const unit = m[1]?.startsWith("week") ? "weeks" : m[1]?.startsWith("month") ? "months" : "days";
  const a = parseLiteralDate(m[2]!, now);
  const b = parseLiteralDate(m[3]!, now);
  if (!a || !b) {
    return null;
  }
  let to = b.date;
  if (to.getTime() < a.date.getTime() && !a.hadYear && !b.hadYear) {
    // Dec → Jan span: roll the end forward a year — but a year-less Feb 29 rolled
    // into a non-leap year is impossible, so decline (null) rather than let
    // `new Date` silently roll it to Mar 1 and report a count for a date never typed.
    const rolled = realDate(b.date.getFullYear() + 1, b.date.getMonth(), b.date.getDate());
    if (!rolled) {
      return null;
    }
    to = rolled;
  }
  const days = Math.round(Math.abs(to.getTime() - a.date.getTime()) / DAY_MS);
  return { unit, days, from: a.date, to };
}

const longDate = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

/** "There are 75 days between June 1, 2026 and August 15, 2026." Pure. */
export function formatDateDiff(result: DateDiffResult): string {
  const span = `between ${longDate(result.from)} and ${longDate(result.to)}`;
  if (result.unit === "weeks") {
    const weeks = Math.round(result.days / 7);
    return `There ${weeks === 1 ? "is about 1 week" : `are about ${weeks.toString()} weeks`} ${span}.`;
  }
  if (result.unit === "months") {
    const months = Math.round(result.days / 30.4375);
    return `There ${months === 1 ? "is about 1 month" : `are about ${months.toString()} months`} ${span}.`;
  }
  return `There ${result.days === 1 ? "is 1 day" : `are ${result.days.toString()} days`} ${span}.`;
}
