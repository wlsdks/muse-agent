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

export interface DefaultActiveContextProviderOptions {
  readonly now?: () => Date;
  readonly userMemoryProvider?: UserMemoryProvider;
  readonly activeTaskResolver?: ActiveTaskResolver;
  readonly calendarEventsResolver?: CalendarEventsResolver;
  readonly defaultTimezone?: string;
}

export class DefaultActiveContextProvider implements ActiveContextProvider {
  private readonly now: () => Date;
  private readonly userMemoryProvider?: UserMemoryProvider;
  private readonly activeTaskResolver?: ActiveTaskResolver;
  private readonly calendarEventsResolver?: CalendarEventsResolver;
  private readonly defaultTimezone?: string;

  constructor(options: DefaultActiveContextProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.userMemoryProvider = options.userMemoryProvider;
    this.activeTaskResolver = options.activeTaskResolver;
    this.calendarEventsResolver = options.calendarEventsResolver;
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
    return {
      activeTask,
      currentFocus,
      isWorkingHours: workingHours ? isWorkingHours(now, workingHours, formatted.timezone) : undefined,
      localHour: formatted.localHour,
      nowIso: formatted.iso,
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
    lines.push(`active_task: ${taskParts.join(" · ")}`);
  }
  if (snapshot.currentFocus) {
    lines.push(`current_focus: ${sanitizeInline(snapshot.currentFocus)}`);
  }
  if (snapshot.todaysEvents && snapshot.todaysEvents.length > 0) {
    lines.push("today_events:");
    for (const event of snapshot.todaysEvents.slice(0, 8)) {
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
  return lines.join("\n");
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
