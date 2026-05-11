/**
 * Active-context surface (Context Engineering Phase 1).
 *
 * Pulls in "what the agent needs to know right now without a tool
 * call" — current time, user timezone, working-hours boolean, and
 * the user's active task / current focus — and renders it as a
 * single `[Active Context]` block injected via `appendSystemSection`.
 *
 * Provider is intentionally minimal so callers can compose:
 *   - `DefaultActiveContextProvider`: always-on time + timezone +
 *     working-hours derived from `UserMemory.preferences`.
 *   - Callers may also pass an `activeTaskResolver` (e.g. backed by
 *     the task memory store) to surface a single task line.
 */

import type { UserMemoryProvider } from "./types.js";
import {
  formatCurrentTime,
  humanizeRelativeFromIso,
  isWorkingHours,
  parseWorkingHoursString
} from "./time-helpers.js";

export interface ActiveTaskHint {
  readonly id?: string;
  readonly title: string;
  readonly dueIso?: string;
}

export interface CalendarEventHint {
  readonly title: string;
  readonly startIso: string;
  readonly endIso?: string;
  readonly allDay?: boolean;
  readonly location?: string;
}

export interface ReminderHint {
  /** Free-form reminder text the operator authored. */
  readonly text: string;
  /** ISO timestamp when the reminder is/was due. */
  readonly dueIso: string;
}

export interface ActiveContextSnapshot {
  readonly nowIso: string;
  readonly weekday: string;
  readonly timezone: string;
  readonly localHour: number;
  readonly workingHours?: { readonly start: number; readonly end: number };
  readonly isWorkingHours?: boolean;
  readonly activeTask?: ActiveTaskHint;
  readonly currentFocus?: string;
  /**
   * Today's calendar events (D1). Surfaced into `[Active Context]`
   * so the agent does not need to invoke `muse.calendar.upcoming`
   * just to know "is there a meeting in 30 minutes?". Provider
   * decides ordering — typically chronological by `startIso`.
   */
  readonly todaysEvents?: readonly CalendarEventHint[];
  /**
   * Iter 41: pending reminders due within the next ~2 hours (or
   * already overdue but still un-fired). Surfaced so the agent can
   * say "you asked me to remind you about X at 3pm — it's 2:55"
   * without first calling `muse.reminders.list`. JARVIS-class
   * proactive nudge surface.
   */
  readonly reminders?: readonly ReminderHint[];
}

export interface ActiveContextResolveOptions {
  readonly userId?: string;
  readonly sessionId?: string;
}

export interface ActiveContextProvider {
  resolve(
    options?: ActiveContextResolveOptions
  ): Promise<ActiveContextSnapshot | undefined> | ActiveContextSnapshot | undefined;
}

export interface ActiveTaskResolver {
  resolve(
    options: { readonly userId?: string; readonly sessionId?: string }
  ): Promise<ActiveTaskHint | undefined> | ActiveTaskHint | undefined;
}

export interface CalendarEventsResolver {
  resolve(
    options: { readonly nowIso: string; readonly timezone: string; readonly userId?: string }
  ): Promise<readonly CalendarEventHint[] | undefined> | readonly CalendarEventHint[] | undefined;
}

export interface RemindersResolver {
  resolve(
    options: { readonly nowIso: string; readonly userId?: string }
  ): Promise<readonly ReminderHint[] | undefined> | readonly ReminderHint[] | undefined;
}

export interface DefaultActiveContextProviderOptions {
  readonly now?: () => Date;
  readonly userMemoryProvider?: UserMemoryProvider;
  readonly activeTaskResolver?: ActiveTaskResolver;
  readonly calendarEventsResolver?: CalendarEventsResolver;
  readonly remindersResolver?: RemindersResolver;
  readonly defaultTimezone?: string;
}

export class DefaultActiveContextProvider implements ActiveContextProvider {
  private readonly now: () => Date;
  private readonly userMemoryProvider?: UserMemoryProvider;
  private readonly activeTaskResolver?: ActiveTaskResolver;
  private readonly calendarEventsResolver?: CalendarEventsResolver;
  private readonly remindersResolver?: RemindersResolver;
  private readonly defaultTimezone?: string;

  constructor(options: DefaultActiveContextProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.userMemoryProvider = options.userMemoryProvider;
    this.activeTaskResolver = options.activeTaskResolver;
    this.calendarEventsResolver = options.calendarEventsResolver;
    this.remindersResolver = options.remindersResolver;
    this.defaultTimezone = options.defaultTimezone;
  }

  async resolve(
    options?: ActiveContextResolveOptions
  ): Promise<ActiveContextSnapshot | undefined> {
    const resolved = options ?? {};
    const userId = resolved.userId;
    const sessionId = resolved.sessionId;
    const now = this.now();
    let timezone = this.defaultTimezone;
    let workingHours: { start: number; end: number } | undefined;
    let currentFocus: string | undefined;
    if (userId && this.userMemoryProvider) {
      try {
        const memory = await this.userMemoryProvider.findByUserId(userId);
        if (memory) {
          const tz = memory.preferences["timezone"] ?? memory.preferences["tz"];
          if (typeof tz === "string" && tz.trim()) {
            timezone = tz.trim();
          }
          const workingHoursRaw = memory.preferences["working_hours"];
          if (typeof workingHoursRaw === "string") {
            workingHours = parseWorkingHoursString(workingHoursRaw);
          }
          // Preferences are user-set (intentional, e.g. `muse memory
          // set preferences.current_focus "..."`); facts are
          // auto-extracted from conversation. The user's explicit
          // setting must win over a heuristic extraction, so
          // preferences come first and facts only fill the gap.
          const focus = memory.preferences["current_focus"] ?? memory.facts["current_focus"];
          if (typeof focus === "string" && focus.trim()) {
            currentFocus = focus.trim();
          }
        }
      } catch {
        // fail-open: keep nowIso + timezone defaults
      }
    }
    const formatted = formatCurrentTime(now, timezone);
    let activeTask: ActiveTaskHint | undefined;
    if (this.activeTaskResolver && (userId || sessionId)) {
      try {
        activeTask = (await this.activeTaskResolver.resolve({ sessionId, userId })) ?? undefined;
      } catch {
        activeTask = undefined;
      }
    }
    let todaysEvents: readonly CalendarEventHint[] | undefined;
    if (this.calendarEventsResolver) {
      try {
        todaysEvents = (await this.calendarEventsResolver.resolve({
          nowIso: formatted.iso,
          timezone: formatted.timezone,
          userId
        })) ?? undefined;
      } catch {
        todaysEvents = undefined;
      }
    }
    let reminders: readonly ReminderHint[] | undefined;
    if (this.remindersResolver) {
      try {
        reminders = (await this.remindersResolver.resolve({
          nowIso: formatted.iso,
          userId
        })) ?? undefined;
      } catch {
        reminders = undefined;
      }
    }
    return {
      activeTask,
      currentFocus,
      isWorkingHours: workingHours ? isWorkingHours(now, workingHours, formatted.timezone) : undefined,
      localHour: formatted.localHour,
      nowIso: formatted.iso,
      reminders,
      timezone: formatted.timezone,
      todaysEvents,
      weekday: formatted.weekday,
      workingHours
    };
  }
}

/**
 * Render the snapshot as a `[Active Context]` block. Returns undefined
 * if the snapshot carries nothing useful — but normally always returns
 * a string since `nowIso` + `timezone` are always populated.
 */
export function renderActiveContextSection(snapshot: ActiveContextSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }
  const lines: string[] = ["[Active Context]"];
  lines.push(`now=${snapshot.nowIso} (${snapshot.weekday}, ${snapshot.timezone})`);
  if (snapshot.workingHours) {
    const status = snapshot.isWorkingHours === undefined
      ? "unknown"
      : snapshot.isWorkingHours
        ? "yes"
        : "no";
    lines.push(`working_hours=${snapshot.workingHours.start}-${snapshot.workingHours.end} (in_window=${status})`);
  }
  if (snapshot.activeTask) {
    // External task stores (and the user themselves) supply `title`
    // / `id` / `dueIso`. A `\n[System Override]\n…` in any of them
    // would splice a fake section header into `[Active Context]` —
    // same injection class iter 13/14/15/20 already closed. Inline
    // sanitise every author-supplied string field. `dueIso` is
    // safe (Date.toISOString) but defensive for symmetry.
    const taskParts: string[] = [sanitizeInline(snapshot.activeTask.title)];
    if (snapshot.activeTask.id) {
      taskParts.push(`id=${sanitizeInline(snapshot.activeTask.id)}`);
    }
    if (snapshot.activeTask.dueIso) {
      const dueIso = sanitizeInline(snapshot.activeTask.dueIso);
      const relative = humanizeRelativeFromIso(snapshot.nowIso, dueIso);
      taskParts.push(relative ? `due=${dueIso} (${relative})` : `due=${dueIso}`);
    }
    // Iter 52 — explicit urgency marker. The `due=... (3h ago)`
    // string carries the info but the agent has to PARSE "ago" to
    // realise the task is past due. A JARVIS-class assistant
    // signals overdue up-front: front-loaded `[OVERDUE]` /
    // `[DUE SOON]` prefix so the urgency is the FIRST thing the
    // model reads on this line.
    //   - past dueIso         → `[OVERDUE]`
    //   - within next 30 min  → `[DUE SOON]`
    //   - otherwise           → no marker (the relative time is
    //                           informative enough)
    const urgency = computeTaskUrgency(snapshot.activeTask.dueIso, snapshot.nowIso);
    const urgencyPrefix = urgency ? `[${urgency}] ` : "";
    lines.push(`active_task: ${urgencyPrefix}${taskParts.join(" · ")}`);
  }
  if (snapshot.currentFocus) {
    lines.push(`current_focus: ${sanitizeInline(snapshot.currentFocus)}`);
  }
  if (snapshot.todaysEvents && snapshot.todaysEvents.length > 0) {
    // JARVIS-class affordance: the user reads this block as a
    // timeline. Apply two defensive transforms before slicing so the
    // rendered output is deterministic and prompt-token-efficient
    // regardless of how the `CalendarEventsResolver` returned the
    // list:
    //   1. Sort by `startIso` ascending — random / alphabetical /
    //      creation order from a third-party adapter would otherwise
    //      put "Design review at 16:00" above "Morning standup at
    //      09:00", defeating the "what's next?" affordance.
    //   2. Drop events that ended more than 30 minutes before `nowIso`
    //      — old standups burn prompt tokens with no relevance.
    //      30-min grace window so a meeting that just wrapped is
    //      still the freshest context.
    const filteredEvents = filterAndSortTodayEvents(snapshot.todaysEvents, snapshot.nowIso);
    // Iter 41: promote the most-imminent event (happening now, or
    // starting within 30 minutes) to a `next_up:` line BEFORE the
    // chronological list. JARVIS-class "heads up" affordance — the
    // agent shouldn't have to scan the whole timeline to know
    // "you have a meeting in 10 minutes". The event also still
    // appears in `today_events:` (redundancy is feature: the agent
    // can cross-reference end-time, location, etc).
    const imminent = findImminentEvent(filteredEvents, snapshot.nowIso);
    if (imminent) {
      const annotation = eventTimeAnnotation(snapshot.nowIso, imminent) ?? "soon";
      const title = sanitizeInline(imminent.title);
      const locationPart = imminent.location ? ` @ ${sanitizeInline(imminent.location)}` : "";
      lines.push(`next_up: [${annotation}] ${title}${locationPart}`);
    }
    if (filteredEvents.length > 0) {
      lines.push("today_events:");
      for (const event of filteredEvents.slice(0, 8)) {
        // Same defensive Round 3 pattern iter 22 used for `dueIso` and
        // iter 33 for inbox `receivedAtIso`. `startIso` / `endIso` are
        // typed `string` and supposed to come from `Date.toISOString()`
        // but `CalendarEventsResolver` is a third-party-pluggable
        // interface — a buggy adapter (or a malicious event source
        // upstream of the calendar API) could land a newline-bearing
        // string there, splicing a fake `[System Override]` section
        // header into `[Active Context]`. Inline-sanitise both before
        // they touch the rendered line.
        const startIsoSafe = sanitizeInline(event.startIso);
        const endIsoSafe = event.endIso ? sanitizeInline(event.endIso) : undefined;
        const timePart = event.allDay
          ? "(all day)"
          : endIsoSafe
            ? `${startIsoSafe} → ${endIsoSafe}`
            : startIsoSafe;
        // Humanize the start time relative to now ("in 30 min" / "now"
        // / "2h ago") so the agent answers "next meeting?" without
        // doing ISO date arithmetic. Past-ended events get a clear
        // `ended` marker so they're not mistaken for upcoming.
        const annotation = event.allDay
          ? undefined
          : eventTimeAnnotation(snapshot.nowIso, event);
        const annotationPart = annotation ? ` [${annotation}]` : "";
        // External calendars (Google Calendar, iCloud, etc.) supply
        // `title` and `location`. An attacker who can create a
        // calendar event in the user's account could embed
        // `\n[System Override]\n…` in either field — the title is
        // entirely free-form. Inline sanitise both.
        const eventTitle = sanitizeInline(event.title);
        const locationPart = event.location ? ` @ ${sanitizeInline(event.location)}` : "";
        lines.push(`  · ${timePart}${annotationPart} ${eventTitle}${locationPart}`);
      }
    }
  }
  // Iter 41: pending reminders surfaced inline. Already-overdue or
  // due within the next ~2h. Filtered + sorted here so a buggy
  // resolver can't blow the prompt with stale or random-order data.
  // Same Round 3 sanitisation seam (text + dueIso) the other blocks
  // already use.
  if (snapshot.reminders && snapshot.reminders.length > 0) {
    const filteredReminders = filterAndSortReminders(snapshot.reminders, snapshot.nowIso);
    if (filteredReminders.length > 0) {
      lines.push("reminders:");
      for (const reminder of filteredReminders.slice(0, 8)) {
        const dueIsoSafe = sanitizeInline(reminder.dueIso);
        const relative = humanizeRelativeFromIso(snapshot.nowIso, dueIsoSafe);
        const annotation = relative ? `[${relative}] ` : "";
        const text = sanitizeInline(reminder.text);
        lines.push(`  · ${annotation}due=${dueIsoSafe} — ${text}`);
      }
    }
  }
  return lines.join("\n");
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

const ENDED_EVENT_GRACE_MS = 30 * 60 * 1_000;
const IMMINENT_EVENT_WINDOW_MS = 30 * 60 * 1_000;
const REMINDER_WINDOW_MS = 2 * 60 * 60 * 1_000;
const TASK_DUE_SOON_WINDOW_MS = 30 * 60 * 1_000;

/**
 * Iter 52 — explicit task-urgency marker. Returns the string the
 * renderer prefixes onto the `active_task:` line:
 *   - `"OVERDUE"`   when `dueIso < nowIso`
 *   - `"DUE SOON"`  when `dueIso - nowIso <= 30 min`
 *   - `undefined`   otherwise (no prefix)
 *
 * JARVIS-class affordance: signal urgency in the first read
 * position of the line rather than buried in a `(3h ago)` suffix.
 * Falls open on unparseable timestamps (no marker).
 */
function computeTaskUrgency(dueIso: string | undefined, nowIso: string): "OVERDUE" | "DUE SOON" | undefined {
  if (!dueIso) {
    return undefined;
  }
  const nowMs = Date.parse(nowIso);
  const dueMs = Date.parse(dueIso);
  if (!Number.isFinite(nowMs) || !Number.isFinite(dueMs)) {
    return undefined;
  }
  if (dueMs < nowMs) {
    return "OVERDUE";
  }
  if (dueMs - nowMs <= TASK_DUE_SOON_WINDOW_MS) {
    return "DUE SOON";
  }
  return undefined;
}

/**
 * Iter 41 — JARVIS-class "heads up" promotion. Returns the event
 * the operator most needs to know about RIGHT NOW: a currently-
 * happening event if any, otherwise the next event starting within
 * `IMMINENT_EVENT_WINDOW_MS` (30 minutes). Returns undefined when
 * nothing is in the window — the renderer skips the `next_up:` line.
 * All-day events are excluded (they're not "imminent" in the same
 * sense — they don't have a specific start moment to nudge about).
 */
function findImminentEvent(
  events: readonly CalendarEventHint[],
  nowIso: string
): CalendarEventHint | undefined {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return undefined;
  }
  for (const event of events) {
    if (event.allDay) {
      continue;
    }
    const startMs = Date.parse(event.startIso);
    if (!Number.isFinite(startMs)) {
      continue;
    }
    const endMs = event.endIso ? Date.parse(event.endIso) : Number.NaN;
    const happeningNow = startMs <= nowMs && (Number.isFinite(endMs) ? endMs >= nowMs : true);
    if (happeningNow) {
      return event;
    }
    if (startMs > nowMs && startMs - nowMs <= IMMINENT_EVENT_WINDOW_MS) {
      return event;
    }
  }
  return undefined;
}

/**
 * Iter 41 — filter+sort reminders for `[Active Context]`. Keep
 * pending reminders that are overdue or due within
 * `REMINDER_WINDOW_MS` (2 hours). Sort by dueIso ascending so the
 * most-imminent surfaces first. Same defensive shape as
 * `filterAndSortTodayEvents`.
 */
function filterAndSortReminders(
  reminders: readonly ReminderHint[],
  nowIso: string
): readonly ReminderHint[] {
  const nowMs = Date.parse(nowIso);
  const sorted = [...reminders].sort((a, b) => {
    const aMs = Date.parse(a.dueIso);
    const bMs = Date.parse(b.dueIso);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
      return aMs - bMs;
    }
    return a.dueIso.localeCompare(b.dueIso);
  });
  if (!Number.isFinite(nowMs)) {
    return sorted;
  }
  const horizonMs = nowMs + REMINDER_WINDOW_MS;
  return sorted.filter((reminder) => {
    const dueMs = Date.parse(reminder.dueIso);
    if (!Number.isFinite(dueMs)) {
      return true;
    }
    // Keep overdue (dueMs <= now) AND due within window.
    return dueMs <= horizonMs;
  });
}

/**
 * Defensive transform applied at the render boundary so the
 * `today_events:` block is always deterministic and free of
 * tokens-burned-on-ancient-history. Sort by `startIso` ascending,
 * then drop events that ended more than `ENDED_EVENT_GRACE_MS`
 * before `nowIso`. Events with unparseable timestamps fall through
 * the sort (relative ordering via `localeCompare`) and survive the
 * filter — they're preserved on the assumption that the operator
 * authored them, and a downstream sanity check is better than
 * silent dropping.
 */
function filterAndSortTodayEvents(
  events: readonly CalendarEventHint[],
  nowIso: string
): readonly CalendarEventHint[] {
  const nowMs = Date.parse(nowIso);
  const sorted = [...events].sort((a, b) => {
    const aMs = Date.parse(a.startIso);
    const bMs = Date.parse(b.startIso);
    if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
      return aMs - bMs;
    }
    return a.startIso.localeCompare(b.startIso);
  });
  if (!Number.isFinite(nowMs)) {
    return sorted;
  }
  return sorted.filter((event) => {
    if (!event.endIso) {
      return true;
    }
    const endMs = Date.parse(event.endIso);
    if (!Number.isFinite(endMs)) {
      return true;
    }
    return endMs >= nowMs - ENDED_EVENT_GRACE_MS;
  });
}

function eventTimeAnnotation(nowIso: string, event: CalendarEventHint): string | undefined {
  const nowMs = Date.parse(nowIso);
  const startMs = Date.parse(event.startIso);
  const endMs = event.endIso ? Date.parse(event.endIso) : Number.NaN;
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs)) {
    return undefined;
  }
  if (Number.isFinite(endMs) && endMs < nowMs) {
    return "ended";
  }
  if (startMs <= nowMs && (!Number.isFinite(endMs) || endMs >= nowMs)) {
    return "happening now";
  }
  return humanizeRelativeFromIso(nowIso, event.startIso);
}
