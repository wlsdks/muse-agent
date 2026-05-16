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
 *   Korean:
 *     - `N분 뒤 | N분 후` → now + N minutes
 *     - `N시간 뒤 | N시간 후` → now + N hours
 *     - `내일 (아침|점심|저녁|밤)?` → next day at the configured slot
 *     - `오늘 H시(에)?` → today at that hour
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
    | "korean-relative-minutes"
    | "korean-relative-hours"
    | "korean-tomorrow-slot"
    | "korean-today-at";
}

export interface ExtractFollowupPromisesOptions {
  /** Anchor time for relative resolution. */
  readonly now: Date;
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

const KOREAN_SLOTS: Record<string, "morning" | "afternoon" | "evening" | "night"> = {
  "아침": "morning",
  "오전": "morning",
  "점심": "afternoon",
  "오후": "afternoon",
  "저녁": "evening",
  "밤": "night"
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
  const push = (promise: FollowupPromise): void => {
    const minuteKey = Math.floor(promise.scheduledFor.getTime() / 60_000);
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
    });
  }

  for (const match of text.matchAll(/(\d{1,4})\s*분\s*(?:뒤|후|이?내?에?)/gu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    push({
      confidence: "high",
      kind: "korean-relative-minutes",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + value * 60_000)
    });
  }
  for (const match of text.matchAll(/(\d{1,3})\s*시간\s*(?:뒤|후|이?내?에?)/gu)) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    push({
      confidence: "high",
      kind: "korean-relative-hours",
      originalText: match[0] ?? "",
      scheduledFor: new Date(options.now.getTime() + value * 3_600_000)
    });
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
    });
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
    });
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
    });
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
    });
  }

  return out;
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
