/**
 * Self-followup detector — rule-only first pass.
 *
 * When the model writes "I'll check tomorrow morning" or "let me
 * remind you in 30 minutes", the proactive flow today is text-only:
 * the assistant says it, the user reads it, nothing gets queued.
 * `docs/design/agent-self-followup.md` describes a multi-iter
 * extension that closes the loop — this module lands step 1, the
 * pure detector that scans an assistant turn for explicit
 * time-bound promises.
 *
 * The detector is intentionally conservative — it lans toward
 * false negatives over spurious queueings. A casual "I'll think
 * about it" is not a followup; only phrases that pin a concrete
 * future moment are extracted. Step 2 (storage), step 3 (runtime
 * hook), and step 4 (firing daemon) land in follow-up iters.
 *
 * Supported patterns:
 *   English:
 *     - `in N (min|minutes|hour|hours|day|days)` → now + N
 *     - `tomorrow (morning|afternoon|evening|night)?` → next day
 *       at the configured slot hour
 *     - `at H(:MM)? (am|pm)?` → today at that time (or tomorrow
 *       when the time has already passed)
 *     - `(next|this)? <weekday> (at H(:MM)? (am|pm)?)?` → the next
 *       occurrence of that weekday (this week if still ahead,
 *       else next week; `next <weekday>` forces next week)
 *   Korean:
 *     - `N분 뒤 | N분 후` → now + N minutes
 *     - `N시간 뒤 | N시간 후` → now + N hours
 *     - `N일 뒤 | N일 후 | N일 이내` → now + N days
 *     - `내일 (아침|점심|저녁|밤)?` → next day at the configured slot
 *     - `오늘 H시(에)?` → today at that hour
 *     - `(이번주|다음주|담주)? <요일>요일 (H시(N분)?)?` → the next
 *       occurrence of that weekday (다음주/담주 forces next week)
 *     - `(다음달|이번달)? N일` | `N월 N일` (+ `H시(N분)?`) → the
 *       next occurrence of that day-of-month (다음달 forces next
 *       month; an unqualified past date this month rolls to next
 *       month; an explicit month/day already past this year rolls
 *       to next year)
 *
 * Out of scope: conditional promises ("if X then I'll do Y"),
 * vague intents ("sometime next week"), multi-clause statements
 * (we treat each clause independently and dedupe by resolved
 * scheduledFor).
 */

export interface FollowupPromise {
  /** The substring of the assistant turn that produced this promise. */
  readonly originalText: string;
  /** Absolute resolved time the model promised to revisit. */
  readonly scheduledFor: Date;
  /**
   * Rule-detector confidence:
   *   "high" — explicit numeric+unit ("in 30 minutes", "30분 뒤")
   *   "low"  — soft pin ("tomorrow morning", "내일 아침") that
   *           depends on the configured default slot hour
   */
  readonly confidence: "high" | "low";
  /** Detector classification — useful for diagnostics + dedupe. */
  readonly kind:
    | "relative-minutes"
    | "relative-hours"
    | "relative-days"
    | "tomorrow-slot"
    | "today-at"
    | "weekday"
    | "korean-relative-minutes"
    | "korean-relative-hours"
    | "korean-relative-days"
    | "korean-tomorrow-slot"
    | "korean-today-at"
    | "korean-weekday"
    | "korean-absolute-date";
}

export interface ExtractFollowupPromisesOptions {
  /** Anchor time for relative resolution. */
  readonly now: Date;
  /**
   * Commissive-force gate (arXiv:2502.14321 speech-act paradigm): when true, a
   * time phrase is emitted ONLY if a first-person commitment governs its sentence
   * ("I'll … tomorrow" / "…확인해 드릴게요"), not a bare description/mention ("your
   * meeting is tomorrow" / a stray "7시에" with no promise verb). The production
   * capture hook sets this so a descriptive time mention never queues a reminder
   * the assistant didn't promise — Korean kinds are gated too (via the Korean
   * commitment morphology 할게/드릴게/하겠습니다 …), closing what used to be a
   * korean-* bypass. Default false keeps the pure time-parser contract for
   * non-self-followup callers.
   */
  readonly requireCommissive?: boolean;
  /**
   * Slot hours used when the model says "tomorrow morning" without a
   * concrete clock time. Defaults reflect typical assistant cadence:
   * morning=9, afternoon=14, evening=19, night=21.
   */
  readonly slotHours?: Partial<Record<"morning" | "afternoon" | "evening" | "night", number>>;
}

const DEFAULT_SLOTS: Record<"morning" | "afternoon" | "evening" | "night", number> = {
  afternoon: 14,
  evening: 19,
  morning: 9,
  night: 21
};

export const RULE_FOLLOWUP_FUTURE_HORIZON_MS = 365 * 86_400_000;

const KOREAN_SLOTS: Record<string, "morning" | "afternoon" | "evening" | "night"> = {
  "아침": "morning",
  "오전": "morning",
  "점심": "afternoon",
  "오후": "afternoon",
  "저녁": "evening",
  "밤": "night"
};

// getDay() indices: Sun=0 … Sat=6.
const KOREAN_WEEKDAY_INDEX: Record<string, number> = {
  "일": 0, "월": 1, "화": 2, "수": 3, "목": 4, "금": 5, "토": 6
};
const EN_WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
};

/**
 * Extract every promise the model made in `text`. Promises are
 * deduped by their resolved `scheduledFor` (minute precision) so a
 * model that says "in 30 minutes" then immediately repeats "in 30
 * min" emits one entry.
 */
export function extractFollowupPromises(
  text: string,
  options: ExtractFollowupPromisesOptions
): readonly FollowupPromise[] {
  if (!text || text.trim().length === 0) {
    return [];
  }
  const out: FollowupPromise[] = [];
  const seenMinute = new Set<number>();
  const slots = { ...DEFAULT_SLOTS, ...options.slotHours };
  const push = (promise: FollowupPromise, matchIndex: number): void => {
    // A recurrence marker (매일/매주/매달/…요일마다/마다) governing the time
    // expression means the model resolved a RECURRING request into a wrong
    // ONE-SHOT time (e.g. "매일 아침 8시" → today 08:00, once). Full recurrence
    // support is out of scope; a wrong one-shot is worse than no followup at
    // all (it fires once at the wrong moment and never again), so the whole
    // match is dropped — the honest caveat then tells the user recurring
    // isn't supported yet instead of silently mis-scheduling.
    if (recurrenceGoverns(text, matchIndex)) return;
    // A refusal right before the time phrase ("I won't remind you in 30 min",
    // "I will NOT check tomorrow") means the assistant DECLINED — it is not a
    // promise to queue. Suppress it; the module's documented bias is toward
    // false negatives over spurious queueings. (English negation only — Korean
    // 안/않 morphology is too ambiguous to window-match safely here.)
    if (negatedBefore(text, matchIndex)) return;
    // Commissive-force gate (arXiv:2502.14321, speech-act paradigm): a self-followup
    // is a COMMISSIVE act — the assistant must actually commit ("I'll … tomorrow" /
    // "…확인해 드릴게요"), not merely mention a time ("your meeting is tomorrow" / a
    // bare "7시에..." with no promise verb). A bare time phrase with no first-person
    // commitment is an illocutionary misfire; queueing it fires a reminder the
    // assistant never promised. Opt-in (the capture hook sets it). Korean kinds use
    // the Korean commitment morphology check (할게/드릴게/하겠습니다 …) instead of the
    // EN one — they are NOT exempted from the gate. Subtractive: only drops spurious.
    if (options.requireCommissive) {
      const committed = promise.kind.startsWith("korean-")
        ? hasKoreanCommissiveForce(text, matchIndex)
        : hasCommissiveForce(text, matchIndex);
      if (!committed) return;
    }
    // `setHours(NaN, ...)` (e.g. from a corrupt slotHours config —
    // NaN-poisoning via env / settings parse upstream) yields an
    // Invalid Date. Downstream the followup-capture-hook calls
    // `.toISOString()` on `scheduledFor`, which throws RangeError on
    // an Invalid Date — that would crash the afterTurn hook on every
    // run carrying a `tomorrow morning` phrase. Refuse to emit
    // invalid promises so the hook contract stays "every promise has
    // a serialisable scheduledFor."
    const ts = promise.scheduledFor.getTime();
    if (!Number.isFinite(ts)) return;
    // Sanity-bound the horizon: a regex like `in 9999 days` would
    // otherwise queue a follow-up ~27 years out that never
    // meaningfully fires. Parity with the LLM detector's
    // LLM_FOLLOWUP_FUTURE_HORIZON_MS.
    if (ts > options.now.getTime() + RULE_FOLLOWUP_FUTURE_HORIZON_MS) return;
    const minuteKey = Math.floor(ts / 60_000);
    if (seenMinute.has(minuteKey)) return;
    seenMinute.add(minuteKey);
    out.push(promise);
  };

  for (const match of text.matchAll(/\bin\s+(\d{1,4})\s*(min(?:ute)?s?|hours?|hr|hrs|days?)\b/giu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(value) || value <= 0) continue;
    const ms = unitToMs(unit, value);
    if (ms === undefined) continue;
    push({
      confidence: "high",
      kind: ms >= 86_400_000 ? "relative-days" : ms >= 3_600_000 ? "relative-hours" : "relative-minutes",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + ms)
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/(\d{1,4})\s*분\s*(?:뒤|후|이?내?에?)/gu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    push({
      confidence: "high",
      kind: "korean-relative-minutes",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + value * 60_000)
    }, match.index ?? 0);
  }
  for (const match of text.matchAll(/(\d{1,3})\s*시간\s*(?:뒤|후|이?내?에?)/gu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    push({
      confidence: "high",
      kind: "korean-relative-hours",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + value * 3_600_000)
    }, match.index ?? 0);
  }
  // Stricter tail than 분/시간 (require 뒤|후|이내, not a bare 에):
  // "30일에" is a day-of-month, not "30 days later".
  for (const match of text.matchAll(/(\d{1,3})\s*일\s*(?:뒤|후|이내(?:에)?)/gu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    push({
      confidence: "high",
      kind: "korean-relative-days",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + value * 86_400_000)
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/\btomorrow(?:\s+(morning|afternoon|evening|night))?\b/giu)) {
    const slot = ((match[1] ?? "morning").toLowerCase()) as keyof typeof slots;
    const hour = slots[slot] ?? slots.morning;
    const scheduledFor = nextDayAtHour(options.now, hour);
    push({
      confidence: "low",
      kind: "tomorrow-slot",
      originalText: match[0] ?? "",
      scheduledFor
    }, match.index ?? 0);
  }
  for (const match of text.matchAll(/내일(?:\s*(아침|오전|점심|오후|저녁|밤))?/gu)) {
    const slotKr = match[1] ?? "아침";
    const slot = (KOREAN_SLOTS[slotKr] ?? "morning");
    const hour = slots[slot] ?? slots.morning;
    const scheduledFor = nextDayAtHour(options.now, hour);
    push({
      confidence: "low",
      kind: "korean-tomorrow-slot",
      originalText: match[0] ?? "",
      scheduledFor
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/giu)) {
    const hourRaw = Number.parseInt(match[1] ?? "", 10);
    const minuteRaw = match[2] ? Number.parseInt(match[2], 10) : 0;
    const meridiem = (match[3] ?? "").toLowerCase().replace(/\./gu, "");
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) continue;
    if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) continue;
    const hour24 = applyMeridiem(hourRaw, meridiem);
    if (hour24 === undefined) continue;
    push({
      confidence: meridiem ? "high" : "low",
      kind: "today-at",
      originalText: match[0] ?? "",
      scheduledFor: nextOccurrenceAtHourMinute(options.now, hour24, minuteRaw)
    }, match.index ?? 0);
  }
  for (const match of text.matchAll(/(?:오늘\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?(?:에|쯤)?/gu)) {
    // Avoid matching "5 시간" which is "hours" (e.g. "5시간 후").
    const tail = text.slice((match.index ?? 0) + (match[0]?.length ?? 0));
    if (/^\s*간/u.test(tail) || /^\s*(?:뒤|후)/u.test(tail)) continue;
    const hourRaw = Number.parseInt(match[1] ?? "", 10);
    const minuteRaw = match[2] ? Number.parseInt(match[2], 10) : 0;
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) continue;
    if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) continue;
    push({
      confidence: "high",
      kind: "korean-today-at",
      originalText: match[0] ?? "",
      scheduledFor: nextOccurrenceAtHourMinute(options.now, hourRaw, minuteRaw)
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/(이번\s?주|다음\s?주|담주)?\s*(월|화|수|목|금|토|일)요일(?:\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?)?/gu)) {
    const targetDay = KOREAN_WEEKDAY_INDEX[match[2] ?? ""];
    if (targetDay === undefined) continue;
    const qualifier = (match[1] ?? "").replace(/\s+/gu, "");
    const forceNextWeek = qualifier === "다음주" || qualifier === "담주";
    const hasExplicitTime = match[3] !== undefined;
    const hourRaw = hasExplicitTime ? Number.parseInt(match[3] ?? "", 10) : slots.morning;
    const minuteRaw = match[4] ? Number.parseInt(match[4], 10) : 0;
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) continue;
    if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) continue;
    push({
      confidence: hasExplicitTime ? "high" : "low",
      kind: "korean-weekday",
      originalText: match[0] ?? "",
      scheduledFor: nextWeekdayOccurrence(options.now, targetDay, forceNextWeek, hourRaw, minuteRaw)
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/\b(next|this)?\s?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?)?/giu)) {
    const targetDay = EN_WEEKDAY_INDEX[(match[2] ?? "").toLowerCase()];
    if (targetDay === undefined) continue;
    const forceNextWeek = (match[1] ?? "").toLowerCase() === "next";
    const hasExplicitTime = match[3] !== undefined;
    let hourRaw = slots.morning;
    let minuteRaw = 0;
    let confidence: "high" | "low" = "low";
    if (hasExplicitTime) {
      const rawHour = Number.parseInt(match[3] ?? "", 10);
      const rawMinute = match[4] ? Number.parseInt(match[4], 10) : 0;
      const meridiem = (match[5] ?? "").toLowerCase().replace(/\./gu, "");
      if (!Number.isFinite(rawHour) || rawHour < 0 || rawHour > 23) continue;
      if (!Number.isFinite(rawMinute) || rawMinute < 0 || rawMinute > 59) continue;
      const hour24 = applyMeridiem(rawHour, meridiem);
      if (hour24 === undefined) continue;
      hourRaw = hour24;
      minuteRaw = rawMinute;
      confidence = meridiem ? "high" : "low";
    }
    push({
      confidence,
      kind: "weekday",
      originalText: match[0] ?? "",
      scheduledFor: nextWeekdayOccurrence(options.now, targetDay, forceNextWeek, hourRaw, minuteRaw)
    }, match.index ?? 0);
  }

  for (const match of text.matchAll(/(?:(\d{1,2})\s?월\s?)?(?:(다음\s?달|이번\s?달)\s*)?(\d{1,2})일(?!\s*(?:뒤|후|이내))(?:\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?)?/gu)) {
    const explicitMonthRaw = match[1] ? Number.parseInt(match[1], 10) : undefined;
    const qualifier = (match[2] ?? "").replace(/\s+/gu, "");
    const forceNextMonth = explicitMonthRaw === undefined && qualifier === "다음달";
    const day = Number.parseInt(match[3] ?? "", 10);
    const hasExplicitTime = match[4] !== undefined;
    const hourRaw = hasExplicitTime ? Number.parseInt(match[4] ?? "", 10) : slots.morning;
    const minuteRaw = match[5] ? Number.parseInt(match[5], 10) : 0;
    if (!Number.isFinite(hourRaw) || hourRaw < 0 || hourRaw > 23) continue;
    if (!Number.isFinite(minuteRaw) || minuteRaw < 0 || minuteRaw > 59) continue;
    const scheduledFor = resolveAbsoluteDate(options.now, explicitMonthRaw, forceNextMonth, day, hourRaw, minuteRaw);
    if (!scheduledFor) continue;
    push({
      confidence: hasExplicitTime ? "high" : "low",
      kind: "korean-absolute-date",
      originalText: match[0] ?? "",
      scheduledFor
    }, match.index ?? 0);
  }

  return out;
}

// A negation of the promise verb in the short window before a time phrase. The
// `\b` anchors keep it from firing inside words ("cannot" handled explicitly).
const NEGATION_BEFORE_RE = /\b(?:not|never|cannot)\b|won['’]?t|can['’]?t|wouldn['’]?t|won['’]?t\s+be\s+able/iu;
function negatedBefore(text: string, index: number): boolean {
  return NEGATION_BEFORE_RE.test(text.slice(Math.max(0, index - 28), index));
}

// Korean recurrence markers — 매일/매주/매달 ("every day/week/month") and the
// generic "…마다" suffix (covers "N요일마다", "매년마다", etc). English recurring
// phrasing ("every day") is out of scope here (no observed audit finding for
// it); this stays Korean-only rather than guessing an EN equivalent.
const RECURRENCE_MARKER_RE = /매일|매주|매달|마다/u;

/** Does a recurrence marker (매일/매주/매달/…마다) govern the sentence containing the time phrase at `index`? */
function recurrenceGoverns(text: string, index: number): boolean {
  return RECURRENCE_MARKER_RE.test(sentenceWindow(text, index));
}

// First-person commissive markers (the assistant committing to a future act).
// Apostrophe REQUIRED on "I'll" so it can't match the adjective "ill".
const COMMISSIVE_EN_RE = /\bi['’]ll\b|\bi\s+will\b|\bi['’]m\s+going\s+to\b|\bi\s+am\s+going\s+to\b|\blet\s+me\b|\bremind\s+you\b|\bping\s+you\b|\bfollow(?:\s+|-)?up\b|\bget\s+back\s+to\s+you\b|\bcheck\s+back\b|\bcircle\s+back\b/iu;

// Korean commissive morphology — the future-promise conjugations ("…할게(요)",
// "…해둘게(요)", "…알려줄게(요)/알려드릴게(요)", "…드릴게(요)", "…하겠습니다",
// "…드리겠습니다") that mark the sentence as an actual COMMITMENT, as opposed to
// a bare mention ("7시에 회의가 있어요" — a description, not a promise).
const COMMISSIVE_KO_RE = /할게요?|해\s*둘게요?|알려\s*(?:줄게|드릴게)요?|드릴게요?|해\s*드릴게요?|하겠습니다|드리겠습니다|해\s*드리겠습니다/u;

/**
 * Extracts the SENTENCE containing `index` (bounded by . ! ? or newline on
 * each side) — the shared window {@link hasCommissiveForce} and
 * {@link hasKoreanCommissiveForce} test their commitment regex against, so a
 * commitment before OR after the time phrase counts while one in a DIFFERENT
 * sentence does not leak in.
 */
function sentenceWindow(text: string, index: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") { end = i; break; }
  }
  return text.slice(start, end);
}

/** Does a first-person ENGLISH commissive marker govern the sentence containing the time phrase at `index`? */
export function hasCommissiveForce(text: string, index: number): boolean {
  return COMMISSIVE_EN_RE.test(sentenceWindow(text, index));
}

/** Does a KOREAN commissive conjugation (할게/드릴게/하겠습니다 …) govern the sentence containing the time phrase at `index`? */
export function hasKoreanCommissiveForce(text: string, index: number): boolean {
  return COMMISSIVE_KO_RE.test(sentenceWindow(text, index));
}

function unitToMs(unit: string, value: number): number | undefined {
  if (unit.startsWith("min")) return value * 60_000;
  if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") return value * 3_600_000;
  if (unit.startsWith("day")) return value * 86_400_000;
  return undefined;
}

function applyMeridiem(hour: number, meridiem: string): number | undefined {
  if (!meridiem) {
    return hour;
  }
  // With am/pm it's a 12-hour-clock value; anything outside 1..12
  // ("at 15pm", "at 0am") is contradictory garbage. Reject it so
  // `hour + 12` can't push setHours() past 24 and silently roll
  // the followup over to the wrong time the next day.
  if (hour < 1 || hour > 12) {
    return undefined;
  }
  if (meridiem === "am") {
    return hour === 12 ? 0 : hour;
  }
  if (meridiem === "pm") {
    return hour === 12 ? 12 : hour + 12;
  }
  return undefined;
}

function nextDayAtHour(now: Date, hour: number): Date {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function nextOccurrenceAtHourMinute(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  // If the candidate has already passed today, roll to tomorrow.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

/**
 * The next occurrence of `targetDay` (0=Sun..6=Sat). Same weekday as today
 * resolves to TODAY when the target hour/minute is still ahead — else it
 * rolls a full week forward, same "already passed" convention as
 * {@link nextOccurrenceAtHourMinute}. `forceNextWeek` (다음주/담주, EN
 * "next <weekday>") always adds a full week regardless of how much of the
 * current week is left.
 */
function nextWeekdayOccurrence(now: Date, targetDay: number, forceNextWeek: boolean, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let diff = (targetDay - now.getDay() + 7) % 7;
  if (diff === 0) {
    if (forceNextWeek || candidate.getTime() <= now.getTime()) {
      diff = 7;
    }
  } else if (forceNextWeek) {
    diff += 7;
  }
  candidate.setDate(candidate.getDate() + diff);
  return candidate;
}

/**
 * Resolve a day-of-month (`day`, 1-31) into the next real calendar
 * occurrence at `hour`:`minute`. `explicitMonth` (1-12) pins a specific
 * month — already-past this year rolls to next year. Without it,
 * `forceNextMonth` (다음달) always advances a month; otherwise the
 * unqualified/이번달 default is "this month if still ahead, else next
 * month" — the same already-passed convention as the other resolvers.
 * `undefined` means the day/month combination isn't a valid calendar date
 * (`day` out of 1-31, month out of 1-12, or a day that doesn't exist in
 * the resolved month, e.g. "31일" in April) — the detector favors a
 * dropped match over silently rolling to a DIFFERENT day the model never
 * said.
 */
function resolveAbsoluteDate(
  now: Date,
  explicitMonth: number | undefined,
  forceNextMonth: boolean,
  day: number,
  hour: number,
  minute: number
): Date | undefined {
  if (!Number.isFinite(day) || day < 1 || day > 31) return undefined;
  const year = now.getFullYear();
  const buildValid = (y: number, monthIndex: number): Date | undefined => {
    const candidate = new Date(y, monthIndex, day, hour, minute, 0, 0);
    return candidate.getDate() === day && candidate.getMonth() === monthIndex ? candidate : undefined;
  };
  if (explicitMonth !== undefined) {
    if (!Number.isFinite(explicitMonth) || explicitMonth < 1 || explicitMonth > 12) return undefined;
    const monthIndex = explicitMonth - 1;
    const thisYear = buildValid(year, monthIndex);
    if (!thisYear) return undefined;
    if (thisYear.getTime() > now.getTime()) return thisYear;
    return buildValid(year + 1, monthIndex);
  }
  if (forceNextMonth) {
    const nextMonthIndex = (now.getMonth() + 1) % 12;
    const nextMonthYear = now.getMonth() === 11 ? year + 1 : year;
    return buildValid(nextMonthYear, nextMonthIndex);
  }
  const thisMonth = buildValid(year, now.getMonth());
  if (!thisMonth) {
    // The day doesn't exist in the CURRENT month at all (e.g. "31일" said in
    // April) — don't guess a different month than the one the model implied.
    return undefined;
  }
  if (thisMonth.getTime() > now.getTime()) {
    return thisMonth;
  }
  const nextMonthIndex = (now.getMonth() + 1) % 12;
  const nextMonthYear = now.getMonth() === 11 ? year + 1 : year;
  return buildValid(nextMonthYear, nextMonthIndex);
}

// Explicit remember-request verbs. "알려줘"/"알려주세요" are DELIBERATELY
// excluded even though the rules above resolve their date phrase — bare
// "알려줘" is also how a plain information request ends ("내일 날씨 알려줘"),
// so including it would flip a normal question into a false remember-intent
// signal. "까먹지 않게" already covers the "don't let me forget, tell me"
// idiom without needing "알려줘" as its own marker.
const REMEMBER_MARKER_RE = /기억해|기억할게|잊지\s*(?:마|말아|않게)|까먹지\s*않게|리마인드/u;

// A date-ish token: the same vocabulary the rule detector above resolves
// (요일/N일/N월/다음달/이번달), plus near-future relative days the detector
// does NOT yet resolve (모레/내일모레/글피) and named holidays whose date
// moves every year (설날/추석) — the two are exactly the residual gap this
// helper exists to flag for an honest caveat.
const DATE_ISH_TOKEN_RE = /(?:월|화|수|목|금|토|일)요일|\d{1,2}\s?월\s?\d{1,2}\s?일|\d{1,2}\s?일|다음\s?달|이번\s?달|내일모레|모레|글피|설날|추석/u;

/**
 * True when `text` reads as a request to remember/be-reminded of something
 * tied to a DATE, whether or not {@link extractFollowupPromises} can
 * actually resolve that date (e.g. "모레" / "설날" have no rule yet). The
 * companion caller (the honest-caveat gate) checks this ONLY when the rule
 * detector produced nothing, so a caveat fires exactly on the residual gap
 * rather than duplicating an already-scheduled followup. Conservative by
 * construction: BOTH a remember marker AND a date-ish token must be
 * present, so a plain question ("내일 날씨 어때?") or a bare "기억해줘" with
 * no date never trips it.
 */
export function detectUnscheduledRememberIntent(text: string): boolean {
  if (!text || text.trim().length === 0) {
    return false;
  }
  return REMEMBER_MARKER_RE.test(text) && DATE_ISH_TOKEN_RE.test(text);
}
