/**
 * Deterministic natural-language cadence → cron-expression parser. Never
 * routed through the model (`tool-calling.md`/product goal: "no cron syntax
 * knowledge required" from a non-developer). Accepts a small, fixed KO+EN
 * grammar; anything outside it is a hard error listing the accepted forms —
 * no best-effort guessing at a schedule the user didn't actually ask for.
 */

export const CADENCE_ACCEPTED_FORMS: readonly string[] = [
  `"매일 09:00" / "daily 9am" / "every day at 09:00"`,
  `"매일 아침 9시" / "매일 오후 3시"`,
  `"매주 월요일 9시" / "every monday 9am"`,
  `"평일 9시" / "weekdays 9am"`,
  `"매시간" / "hourly"`,
  `"30분마다" / "every 30 minutes"`
];

export interface CadenceParseResult {
  readonly cronExpression: string;
}

const KO_WEEKDAYS: Readonly<Record<string, number>> = {
  "금요일": 5,
  "목요일": 4,
  "수요일": 3,
  "월요일": 1,
  "일요일": 0,
  "토요일": 6,
  "화요일": 2
};

const EN_WEEKDAYS: Readonly<Record<string, number>> = {
  friday: 5,
  monday: 1,
  saturday: 6,
  sunday: 0,
  thursday: 4,
  tuesday: 2,
  wednesday: 3
};

const KO_AM_MARKERS = new Set(["오전", "아침", "새벽"]);
const KO_PM_MARKERS = new Set(["오후", "저녁", "밤"]);

interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

function isValidTime(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function to24Hour(hour12: number, meridiem: "am" | "pm"): number {
  if (meridiem === "am") {
    return hour12 === 12 ? 0 : hour12;
  }
  return hour12 === 12 ? 12 : hour12 + 12;
}

/**
 * Extract a single HH:MM time-of-day from free text. Tries 24h "HH:MM"
 * first, then EN 12h "9am"/"9:30pm", then KO "<오전/오후/아침/저녁/밤>? N시
 * (M분)?". A bare KO "N시" with no AM/PM marker is read as the literal
 * 24h digit (fail-close: no assumption about which half of the day the
 * user meant beyond what they wrote).
 */
function parseTimeOfDay(text: string): TimeOfDay | undefined {
  // EN 12h ("6:30pm") is tried BEFORE bare "HH:MM": "6:30pm" also matches
  // the 24h pattern as a (wrong) literal 06:30, so the am/pm-qualified form
  // must win whenever it's present.
  const en12 = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/iu.exec(text);
  if (en12) {
    const hour12 = Number(en12[1]);
    const minute = en12[2] ? Number(en12[2]) : 0;
    const meridiem = en12[3]!.toLowerCase() as "am" | "pm";
    if (hour12 >= 1 && hour12 <= 12) {
      const hour = to24Hour(hour12, meridiem);
      if (isValidTime(hour, minute)) {
        return { hour, minute };
      }
    }
  }

  const hhmm = /(\d{1,2}):(\d{2})/u.exec(text);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (isValidTime(hour, minute)) {
      return { hour, minute };
    }
  }

  const ko = /(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/u.exec(text);
  if (ko) {
    const marker = ko[1];
    let hour = Number(ko[2]);
    const minute = ko[3] ? Number(ko[3]) : 0;
    if (hour >= 1 && hour <= 12 && marker && KO_AM_MARKERS.has(marker)) {
      hour = hour === 12 ? 0 : hour;
    } else if (hour >= 1 && hour <= 12 && marker && KO_PM_MARKERS.has(marker)) {
      // "밤/저녁 12시" is colloquial Korean for MIDNIGHT, not noon — only
      // "오후 12시" means 12:00.
      hour = hour === 12 ? (marker === "오후" ? 12 : 0) : hour + 12;
    }
    if (isValidTime(hour, minute)) {
      return { hour, minute };
    }
  }

  return undefined;
}

function matchWeekday(text: string, lower: string): number | undefined {
  for (const [word, day] of Object.entries(KO_WEEKDAYS)) {
    if (text.includes(word)) {
      return day;
    }
  }
  for (const [word, day] of Object.entries(EN_WEEKDAYS)) {
    if (new RegExp(`\\b${word}\\b`, "u").test(lower)) {
      return day;
    }
  }
  return undefined;
}

function cadenceError(raw: string): Error {
  return new Error(
    `Unrecognized cadence '${raw}'. Accepted forms: ${CADENCE_ACCEPTED_FORMS.join("; ")}`
  );
}

/**
 * Parse a natural-language recurrence phrase into a standard 5-field cron
 * expression. KO+EN, table-driven grammar (see `CADENCE_ACCEPTED_FORMS`).
 * Returns an `Error` — never throws — on anything outside the accepted
 * grammar so the caller renders it as a normal CLI error message.
 */
export function parseCadence(raw: string): CadenceParseResult | Error {
  const text = raw.trim();
  if (text.length === 0) {
    return cadenceError(raw);
  }
  const lower = text.toLowerCase();

  if (/매\s*시간/u.test(text) || /\bhourly\b/u.test(lower)) {
    return { cronExpression: "0 * * * *" };
  }

  const everyMinEn = /\bevery\s+(\d{1,3})\s*min(?:ute)?s?\b/u.exec(lower);
  const everyMinKo = /(\d{1,3})\s*분\s*마다/u.exec(text);
  const minuteMatch = everyMinEn ?? everyMinKo;
  if (minuteMatch) {
    const n = Number(minuteMatch[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 59) {
      return { cronExpression: `*/${n.toString()} * * * *` };
    }
    return cadenceError(raw);
  }

  if (/평일/u.test(text) || /\bweekdays?\b/u.test(lower)) {
    const time = parseTimeOfDay(text);
    if (!time) {
      return cadenceError(raw);
    }
    return { cronExpression: `${time.minute.toString()} ${time.hour.toString()} * * 1-5` };
  }

  const weekday = matchWeekday(text, lower);
  if (weekday !== undefined) {
    const time = parseTimeOfDay(text);
    if (!time) {
      return cadenceError(raw);
    }
    return { cronExpression: `${time.minute.toString()} ${time.hour.toString()} * * ${weekday.toString()}` };
  }

  if (/매일/u.test(text) || /\bdaily\b/u.test(lower) || /\bevery\s+day\b/u.test(lower)) {
    const time = parseTimeOfDay(text);
    if (!time) {
      return cadenceError(raw);
    }
    return { cronExpression: `${time.minute.toString()} ${time.hour.toString()} * * *` };
  }

  return cadenceError(raw);
}
