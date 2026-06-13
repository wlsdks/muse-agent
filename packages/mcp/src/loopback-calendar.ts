import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProviderRegistry
} from "@muse/calendar";
import type { JsonObject, JsonValue } from "@muse/shared";

import { computeAvailability } from "./calendar-availability.js";
import { detectCalendarConflicts } from "./calendar-conflicts.js";
import { formatDueLocal } from "./local-due-format.js";
import { readBoolean, readString, readStringArray, errorMessage } from "./loopback-helpers.js";
import type { LoopbackMcpServer } from "./loopback.js";
import { hasTimeComponent, isTimeOnlyPhrase, isUtcMidnight, recurrenceFromPhrase, resolveRelativeTimePhrase, startOfLocalDay, withTimeOfDay } from "./loopback-relative-time.js";
import { syncRemindersOnEventDelete, syncRemindersOnEventReschedule } from "./event-reminder-link.js";

/** Recurrence cadences the calendar `add` tool accepts (mapped to an RRULE FREQ). */
const CALENDAR_CADENCES = new Set(["daily", "weekly", "monthly", "yearly"]);

/**
 * `muse.calendar` loopback MCP server.
 *
 * Lifted out of `loopback.ts` to keep the calendar tool surface and
 * its private serialize / arg-parse helpers in one cohesive module.
 * Same public surface as before: `CalendarMcpServerOptions` +
 * `createCalendarMcpServer`. Both symbols are re-exported from
 * `loopback.ts` so consumers (`packages/mcp/src/index.ts`,
 * autoconfigure, the existing tests) keep working without
 * import-site edits.
 */

export interface CalendarMcpServerOptions {
  readonly registry: CalendarProviderRegistry;
  /** When set, event delete/update keeps the eventId-linked reminders in sync. */
  readonly remindersFile?: string;
}

export function createCalendarMcpServer(options: CalendarMcpServerOptions): LoopbackMcpServer {
  const { registry, remindersFile } = options;

  // List a generous window and resolve the agent's event ref (id OR title word)
  // so update/delete don't force a list→find-id→act chain. Returns the matched
  // event, or an error payload (ambiguous → candidates with local times).
  const resolveEventForAction = async (
    ref: string,
    providerId: string | undefined
  ): Promise<{ readonly event: EventRefLike } | { readonly error: string; readonly candidates?: JsonValue }> => {
    const from = new Date(Date.now() - 30 * 86_400_000);
    const to = new Date(Date.now() + 365 * 86_400_000);
    let events;
    try {
      events = await registry.listEvents({ from, to }, providerId);
    } catch (error) {
      return { error: errorMessage(error) };
    }
    const resolution = resolveEventByRef(events, ref);
    if (resolution.status === "ambiguous") {
      return {
        candidates: resolution.candidates.map((event) => ({ id: event.id, startsAtLocal: eventLocal(event.startsAt, false), title: event.title })) as JsonValue,
        error: `"${ref}" matches multiple events — say which one`
      };
    }
    if (resolution.status !== "resolved") {
      return { error: `event not found: ${ref}` };
    }
    return { event: resolution.event };
  };

  return {
    description: "Personal calendar (provider-neutral: local file, Google Calendar, CalDAV, macOS).",
    name: "muse.calendar",
    tools: [
      {
        description:
          "List configured calendar providers (id, displayName, local). " +
          "Use `providerId` from this list to target a specific provider in other muse.calendar.* calls.",
        execute: async (): Promise<JsonObject> => ({
          providers: registry.describe().map((info) => ({
            description: info.description,
            displayName: info.displayName,
            id: info.id,
            local: info.local
          })) as JsonValue
        }),
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object"
        },
        domain: "calendar",
        name: "providers",
        risk: "read"
      },
      {
        description:
          "List the user's calendar EVENTS between `fromIso` and `toIso` (ISO 8601 timestamps). " +
          "If `providerId` is omitted, fans out across all providers. " +
          "Pass `query` to find a specific event — keeps only events whose title / location / notes match that text (case-insensitive), e.g. 'find my meeting with Bob this week'. " +
          "Defaults: from = now, to = +30 days. " +
          "USE WHEN the user asks what's on their schedule ('이번 주 일정 보여줘', '내 캘린더 알려줘', \"what's on my calendar\"); " +
          "NOT for to-dos (tasks `list`) or reminders (reminders `list`).",
        keywords: ["일정", "캘린더", "calendar", "event", "events", "schedule", "약속", "미팅", "meeting", "보여줘", "목록", "list", "알려줘"],
        execute: async (args): Promise<JsonObject> => {
          const fromIso = readString(args, "fromIso");
          const toIso = readString(args, "toIso");
          const providerId = readString(args, "providerId");
          const queryTrimmed = (readString(args, "query") ?? "").trim();
          const needle = queryTrimmed.toLowerCase();
          const from = parseIsoDate(fromIso) ?? new Date();
          const to = parseIsoDate(toIso) ?? new Date(from.getTime() + 30 * 86_400_000);
          try {
            const all = await registry.listEvents({ from, to }, providerId);
            const events = needle.length === 0
              ? all
              : all.filter((e) => `${e.title} ${e.location ?? ""} ${e.notes ?? ""}`.toLowerCase().includes(needle));
            return {
              events: events.map(serializeEvent) as JsonValue,
              total: events.length,
              ...(queryTrimmed ? { query: queryTrimmed } : {})
            };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            fromIso: { description: "ISO 8601 start (default: now)", type: "string" },
            providerId: { description: "Specific provider id (default: all)", type: "string" },
            query: { description: "Optional text to match in an event's title / location / notes (case-insensitive substring), e.g. 'dentist' or 'Bob'. Filters the listed events.", type: "string" },
            toIso: { description: "ISO 8601 end (default: now + 30 days)", type: "string" }
          },
          type: "object"
        },
        domain: "calendar",
        name: "list",
        risk: "read"
      },
      {
        description:
          "Check whether the user is FREE or BUSY in a time window and list the open gaps. " +
          "Use for 'am I free at 3pm?', 'do I have time this afternoon?', 'find a 30-minute gap tomorrow'. " +
          "`fromIso` is required; `toIso` defaults to fromIso + 60 minutes. Both accept an ISO-8601 timestamp OR a relative phrase " +
          "('tomorrow 3pm', '내일 오후 3시', 'in 2 hours'). `minMinutes` keeps only free gaps at least that long. " +
          "Returns `fullyFree`, the `busy` events overlapping the window, and the `free` gaps. " +
          "Do NOT use to LIST everything scheduled (use `list`) or to CREATE an event (use `add`).",
        execute: async (args): Promise<JsonObject> => {
          const from = parseIsoDate(readString(args, "fromIso"));
          if (!from) {
            return {
              error:
                `fromIso must be an ISO-8601 timestamp or a supported relative phrase (got ${JSON.stringify(readString(args, "fromIso") ?? "")}). ` +
                `Examples: "tomorrow 3pm", "in 2 hours", "내일 오후 3시".`
            };
          }
          const to = parseIsoDate(readString(args, "toIso")) ?? new Date(from.getTime() + 60 * 60_000);
          const minRaw = (args as Record<string, unknown>)["minMinutes"];
          const minMinutes = typeof minRaw === "number" && Number.isFinite(minRaw) ? minRaw : undefined;
          const providerId = readString(args, "providerId");
          try {
            const events = await registry.listEvents({ from, to }, providerId);
            const result = computeAvailability(events, { from, to }, minMinutes !== undefined ? { minFreeMinutes: minMinutes } : {});
            return {
              busy: result.busy.map((block) => ({
                endsAtIso: block.endsAt.toISOString(),
                startsAtIso: block.startsAt.toISOString(),
                titles: [...block.titles]
              })) as JsonValue,
              free: result.free.map((slot) => ({
                endsAtIso: slot.endsAt.toISOString(),
                startsAtIso: slot.startsAt.toISOString()
              })) as JsonValue,
              fullyFree: result.fullyFree,
              windowFromIso: from.toISOString(),
              windowToIso: to.toISOString()
            };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            fromIso: { description: "Window start — ISO-8601 OR a natural phrase like 'tomorrow 3pm' / '내일 오후 3시'.", type: "string" },
            minMinutes: { description: "Only return free gaps at least this many minutes long, e.g. 30.", type: "number" },
            providerId: { description: "Specific calendar provider id (default: all).", type: "string" },
            toIso: { description: "Window end — ISO-8601 or a relative phrase; defaults to fromIso + 60 minutes.", type: "string" }
          },
          required: ["fromIso"],
          type: "object"
        },
        domain: "calendar",
        keywords: ["free", "busy", "available", "availability", "gap", "slot", "한가"],
        name: "availability",
        risk: "read"
      },
      {
        description:
          "List DOUBLE-BOOKINGS — pairs of events whose times OVERLAP — in a window. " +
          "Use for 'do I have any conflicts?', 'am I double-booked next week?', 'any overlapping meetings?', '겹치는 일정 있어?'. " +
          "`fromIso` / `toIso` accept an ISO-8601 timestamp OR a relative phrase ('next week', 'tomorrow'); " +
          "defaults: from = now, to = +7 days. If `providerId` is omitted, fans out across all providers. " +
          "Returns each overlapping PAIR (`a`, `b`, with local times) plus the `overlap` span, and `total`. " +
          "Do NOT use to check whether you're free at ONE specific time (use `availability`) or to LIST everything scheduled (use `list`).",
        execute: async (args): Promise<JsonObject> => {
          const from = parseIsoDate(readString(args, "fromIso")) ?? new Date();
          const to = parseIsoDate(readString(args, "toIso")) ?? new Date(from.getTime() + 7 * 86_400_000);
          const providerId = readString(args, "providerId");
          try {
            const events = await registry.listEvents({ from, to }, providerId);
            const conflicts = detectCalendarConflicts(
              events.map((e) => ({ endsAt: e.endsAt, startsAt: e.startsAt, title: e.title }))
            );
            return {
              conflicts: conflicts.map((c) => ({
                a: { endsAtLocal: eventLocal(c.a.endsAt, false), startsAtLocal: eventLocal(c.a.startsAt, false), title: c.a.title },
                b: { endsAtLocal: eventLocal(c.b.endsAt, false), startsAtLocal: eventLocal(c.b.startsAt, false), title: c.b.title },
                overlapEndsAtIso: c.overlapEndsAt.toISOString(),
                overlapStartsAtIso: c.overlapStartsAt.toISOString(),
                overlapStartsAtLocal: eventLocal(c.overlapStartsAt, false)
              })) as JsonValue,
              total: conflicts.length,
              windowFromIso: from.toISOString(),
              windowToIso: to.toISOString()
            };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            fromIso: { description: "Window start — ISO-8601 OR a relative phrase like 'next week' / 'tomorrow' (default: now).", type: "string" },
            providerId: { description: "Specific calendar provider id (default: all).", type: "string" },
            toIso: { description: "Window end — ISO-8601 or a relative phrase (default: from + 7 days).", type: "string" }
          },
          type: "object"
        },
        domain: "calendar",
        keywords: ["conflict", "conflicts", "double", "double-booked", "double-booking", "overlap", "overlapping", "clash", "겹치", "중복"],
        name: "conflicts",
        risk: "read"
      },
      {
        description:
          "Create a new calendar event. `startsAt` is required; `endsAt` defaults to startsAt + 60 minutes. " +
          "Pass the user's time IN THEIR OWN WORDS — do NOT compute a date or convert the timezone yourself; the server resolves the phrase against the current local time. " +
          "English: 'tomorrow 3pm', 'today at 14:30', 'in 2 hours', 'next Friday', 'next Monday at 9am'. " +
          "Korean: '내일 오후 3시', '오늘 14시 30분', '2시간 후', '이번 주 토요일 오후 2시', '다음 주 월요일 오전 9시'. " +
          "Only pass an ISO-8601 timestamp when the user literally gave one. " +
          "If `providerId` is omitted, the primary (first registered) provider is used. " +
          "When you confirm the event back to the user, state the time using the result's `startsAtLocal` / `endsAtLocal` fields (the local-timezone time, e.g. 'Fri, Jun 5, 2026, 3:00 PM'), NEVER the raw ISO `startsAtIso` / `endsAtIso`, which are UTC and read back the wrong hour. " +
          "USE WHEN the user schedules a calendar EVENT / appointment / meeting at a date+time ('내일 오후 3시 팀 미팅 일정 추가해줘', 'schedule a dentist appointment Friday 2pm'); " +
          "you MUST call this to actually create it — never just reply that it was added. NOT for a plain to-do (tasks `add`) or a timed alert (reminders `add`).",
        keywords: ["일정", "캘린더", "calendar", "event", "meeting", "미팅", "약속", "appointment", "schedule", "스케줄", "추가", "add", "등록", "잡아"],
        execute: async (args): Promise<JsonObject> => {
          const title = readString(args, "title")?.trim();
          // `startsAt` is the exposed field; `startsAtIso` is accepted as a
          // fallback for any caller still on the old name. The neutral name
          // matters: the "Iso" suffix made the local model pre-compute a
          // (wrong, un-timezone-converted) ISO instead of passing the user's
          // phrase to the server-side resolver.
          const startsAtRaw = readString(args, "startsAt") ?? readString(args, "startsAtIso");
          const endsAtRaw = readString(args, "endsAt") ?? readString(args, "endsAtIso");
          const providerId = readString(args, "providerId");
          if (!title) {
            return { error: "title is required" };
          }
          const startsAt = parseIsoDate(startsAtRaw);
          if (!startsAt) {
            return {
              error:
                `startsAt must be a natural-language time phrase or an ISO-8601 timestamp (got ${JSON.stringify(startsAtRaw ?? "")}). ` +
                `Examples: "내일 오후 3시", "이번 주 토요일 오후 2시", "3일 후", "tomorrow 9am", "next monday 6pm".`
            };
          }
          // A bare time-of-day endsAt ("4pm" / "오후 4시") anchors to the START's day,
          // not today — else a not-today event resolves the end against now and the
          // provider rejects it ("endsAt must be at or after startsAt"). Mirrors `update`.
          const endsAt = (endsAtRaw && isTimeOnlyPhrase(endsAtRaw)
            ? parseIsoDate(endsAtRaw, () => startOfLocalDay(startsAt))
            : parseIsoDate(endsAtRaw)) ?? new Date(startsAt.getTime() + 60 * 60_000);
          const allDay = readBoolean(args, "allDay") ?? false;
          const location = readString(args, "location") ?? undefined;
          const notes = readString(args, "notes") ?? undefined;
          const tags = readStringArray(args, "tags") ?? undefined;
          // Recurring events: "매주 월요일 팀 회의" must REPEAT, not silently become a
          // one-time event. Take the explicit `recurrence` cadence, else infer it
          // from the start phrase ("매주"/"every week"). Map to an iCalendar RRULE,
          // which the local provider already expands (CLI `--repeat`, P41-37).
          const cadenceArg = readString(args, "recurrence")?.trim().toLowerCase();
          const cadence = (cadenceArg && CALENDAR_CADENCES.has(cadenceArg) ? cadenceArg : undefined)
            ?? recurrenceFromPhrase(startsAtRaw ?? "");
          const recurrence = cadence ? `FREQ=${cadence.toUpperCase()}` : undefined;
          const input: CalendarEventInput = {
            allDay,
            endsAt,
            startsAt,
            title,
            ...(location ? { location } : {}),
            ...(notes ? { notes } : {}),
            ...(tags ? { tags } : {}),
            ...(recurrence ? { recurrence } : {})
          };
          try {
            const created = await registry.createEvent(providerId, input);
            return { event: serializeEvent(created) as JsonValue };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            allDay: { description: "True for an all-day event (no specific time).", type: "boolean" },
            endsAt: { description: "End time in the user's own words ('오후 4시', '5pm'); defaults to start + 60 min. Do not pre-compute a date/timezone.", type: "string" },
            location: { description: "Where the event is, e.g. 'Room 4' or an address.", type: "string" },
            notes: { description: "Free-text notes / agenda for the event.", type: "string" },
            providerId: { description: "Calendar provider id (default: the primary provider).", type: "string" },
            recurrence: { description: "Repeat cadence for a RECURRING event — set when the user says '매주'/'매일'/'every week' etc. One of 'daily', 'weekly', 'monthly', 'yearly'. Omit for a one-time event.", enum: ["daily", "weekly", "monthly", "yearly"], type: "string" },
            startsAt: { description: "Start time in the user's OWN WORDS — 'tomorrow 3pm', '내일 오후 3시', '이번 주 토요일 오후 2시'. Do NOT compute a date or convert the timezone; the server resolves it.", type: "string" },
            tags: { description: "Optional labels for the event.", items: { type: "string" }, type: "array" },
            title: { description: "Event title, e.g. 'Dentist appointment'.", type: "string" }
          },
          required: ["title", "startsAt"],
          type: "object"
        },
        domain: "calendar",
        // The 8B fabricates these free-text annotations (a location/notes the
        // user never said) and they get persisted; the runtime drops either
        // when it isn't grounded in the user's utterance.
        groundedArgs: ["location", "notes"],
        name: "add",
        risk: "write"
      },
      {
        description:
          "Update/reschedule an existing calendar event. `id` is its id OR a distinct word from " +
          "its title ('dentist') — an ambiguous word returns the matching events instead of guessing. " +
          "Pass only the fields you want to change. Use for 'move my dentist appointment to Friday 3pm', " +
          "'rename the standup', 'change the location'.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id (or a distinct word from the event title) is required" };
          }
          const resolved = await resolveEventForAction(ref, readString(args, "providerId"));
          if ("error" in resolved) {
            return resolved.candidates ? { candidates: resolved.candidates, error: resolved.error } : { error: resolved.error };
          }
          const startsAtRaw = readString(args, "startsAt") ?? readString(args, "startsAtIso");
          const endsAtRaw = readString(args, "endsAt") ?? readString(args, "endsAtIso");
          // A bare time-of-day keeps the event's DATE (anchor to its own day);
          // a date-bearing phrase resolves against now as before.
          const anchorFor = (raw: string): (() => Date) =>
            isTimeOnlyPhrase(raw) ? () => startOfLocalDay(resolved.event.startsAt) : () => new Date();
          const resolvedStartsAt = startsAtRaw ? parseIsoDate(startsAtRaw, anchorFor(startsAtRaw)) : undefined;
          // A provided-but-unparseable startsAt must ERROR, not silently drop the move
          // and report success (the sibling `add` tool already errors on this) — else
          // "move my dentist to flurbsday" reports done while nothing moved.
          if (startsAtRaw !== undefined && resolvedStartsAt === undefined) {
            return {
              error:
                `startsAt could not be parsed (got ${JSON.stringify(startsAtRaw)}) — the event was NOT moved. ` +
                `Use an ISO-8601 timestamp or a phrase like "tomorrow 2pm" / "내일 오후 3시".`
            };
          }
          // A DATE-only reschedule ("월요일로 옮겨줘") keeps the event's time-of-day —
          // otherwise the resolver defaults it to midnight and a 2pm event lands at
          // 9am. A full ISO (has a `T`) or any phrase that names a time is left as-is.
          const startIsDateOnly = startsAtRaw !== undefined
            && !/^\d{4}-\d{2}-\d{2}T/u.test(startsAtRaw)
            && !isTimeOnlyPhrase(startsAtRaw)
            && !hasTimeComponent(startsAtRaw);
          // isUtcMidnight excludes a relative OFFSET ("in 2 hours"), which resolves
          // to now-plus-delta rather than a bare date's midnight default.
          const newStartsAt = resolvedStartsAt && startIsDateOnly && isUtcMidnight(resolvedStartsAt)
            ? withTimeOfDay(resolvedStartsAt, resolved.event.startsAt)
            : resolvedStartsAt;
          // Moving only the start preserves the event's DURATION — shift the end
          // by the same delta so a later start can't land before the old end.
          const durationMs = resolved.event.endsAt ? resolved.event.endsAt.getTime() - resolved.event.startsAt.getTime() : 0;
          // A time-only endsAt anchors to the (possibly moved) START's day, not the
          // event's ORIGINAL day — else "move it to Monday, ending 5pm" lands the end
          // back on the old day. anchorFor uses the old event day, so override here.
          const endAnchorDay = newStartsAt ?? resolved.event.startsAt;
          const resolvedEndsAt = endsAtRaw
            ? parseIsoDate(endsAtRaw, isTimeOnlyPhrase(endsAtRaw) ? () => startOfLocalDay(endAnchorDay) : () => new Date())
            : undefined;
          // Same as startsAt: a provided-but-unparseable endsAt must error, not be
          // silently dropped (which would also leave the end un-shifted while the start
          // moved — an end-before-start event).
          if (endsAtRaw !== undefined && resolvedEndsAt === undefined) {
            return {
              error:
                `endsAt could not be parsed (got ${JSON.stringify(endsAtRaw)}) — the event was NOT changed. ` +
                `Use an ISO-8601 timestamp or a phrase like "5pm" / "오후 5시".`
            };
          }
          // Moving only the start preserves the event's DURATION (shift the end by the
          // same delta); an explicit endsAt overrides that.
          const newEndsAt = resolvedEndsAt ?? (newStartsAt && durationMs > 0 ? new Date(newStartsAt.getTime() + durationMs) : undefined);
          const update: CalendarEventUpdate = {
            ...(readString(args, "title") ? { title: readString(args, "title")! } : {}),
            ...(newStartsAt ? { startsAt: newStartsAt } : {}),
            ...(newEndsAt ? { endsAt: newEndsAt } : {}),
            ...(readBoolean(args, "allDay") !== undefined ? { allDay: readBoolean(args, "allDay") } : {}),
            ...("location" in args ? { location: readString(args, "location") ?? null } : {}),
            ...("notes" in args ? { notes: readString(args, "notes") ?? null } : {})
          };
          try {
            const updated = await registry.updateEvent(resolved.event.providerId, resolved.event.id, update);
            // Keep the eventId-linked reminders in step with the move — the
            // lifecycle-link contract holds on EVERY surface, not just the CLI.
            const remindersShifted = remindersFile && update.startsAt
              ? await syncRemindersOnEventReschedule(remindersFile, resolved.event.id, resolved.event.startsAt, update.startsAt)
              : 0;
            return { event: serializeEvent(updated) as JsonValue, ...(remindersShifted > 0 ? { remindersShifted } : {}) };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            allDay: { description: "Set true/false to change the all-day flag (only if changing it).", type: "boolean" },
            endsAt: { description: "New end time in the user's own words (only if changing it). Do not pre-compute a date/timezone.", type: "string" },
            id: { description: "The event's id (from `list`) OR a distinct word from its title — copy it EXACTLY as the event is titled, in the event's own language; do NOT translate (e.g. 'standup', '회의', '치과'). An ambiguous word returns the matching events.", type: "string" },
            location: { description: "New location (only if changing it).", type: "string" },
            notes: { description: "New notes (only if changing it).", type: "string" },
            providerId: { description: "Optional — narrow the search to one provider when you have several. Resolved from the matched event when omitted.", type: "string" },
            startsAt: { description: "New start in the user's own words — a TIME alone ('오후 4시' moves the time, keeps the date), a DATE alone ('다음 주 월요일' moves the day, keeps the current time), or BOTH ('금요일 오후 3시'). Pass the user's exact phrase; do NOT ask for a time they didn't give, and do NOT pre-compute a date/timezone. Only if changing it.", type: "string" },
            title: { description: "New title (only if changing it).", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        keywords: ["일정", "캘린더", "calendar", "event", "미팅", "약속", "meeting", "update", "change", "reschedule", "수정", "변경", "바꿔", "옮겨", "연기", "미뤄"],
        domain: "calendar",
        // Same free-text fabrication risk as `add` — drop a location/notes the
        // user didn't state (an unmentioned field is left unchanged, not invented).
        groundedArgs: ["location", "notes"],
        name: "update",
        risk: "write"
      },
      {
        description:
          "Cancel / delete a calendar event. `id` is its id OR a distinct word from its title " +
          "('standup') — an ambiguous word returns the matching events instead of guessing. " +
          "Use for 'cancel my dentist appointment', 'delete the 3pm meeting'.",
        execute: async (args): Promise<JsonObject> => {
          const ref = readString(args, "id");
          if (!ref) {
            return { error: "id (or a distinct word from the event title) is required" };
          }
          const resolved = await resolveEventForAction(ref, readString(args, "providerId"));
          if ("error" in resolved) {
            return resolved.candidates ? { candidates: resolved.candidates, error: resolved.error } : { error: resolved.error };
          }
          try {
            await registry.deleteEvent(resolved.event.providerId, resolved.event.id);
            const remindersRemoved = remindersFile
              ? await syncRemindersOnEventDelete(remindersFile, resolved.event.id)
              : 0;
            return { deleted: true, id: resolved.event.id, providerId: resolved.event.providerId, ...(remindersRemoved > 0 ? { remindersRemoved } : {}), title: resolved.event.title };
          } catch (error) {
            return { error: errorMessage(error) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            id: { description: "The event's id (from `list`) OR a distinct word from its title — copy it EXACTLY as the event is titled, in the event's own language; do NOT translate (e.g. 'standup', '회의', '치과'). An ambiguous word returns the matching events.", type: "string" },
            providerId: { description: "Optional — narrow the search to one provider when you have several. Resolved from the matched event when omitted.", type: "string" }
          },
          required: ["id"],
          type: "object"
        },
        keywords: ["일정", "캘린더", "calendar", "event", "미팅", "약속", "meeting", "delete", "remove", "cancel", "삭제", "취소", "지워", "제거", "없애"],
        domain: "calendar",
        name: "delete",
        risk: "write"
      }
    ]
  };
}

export interface EventRefLike {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly startsAt: Date;
  // The resolved events come from `listEvents` (full CalendarEvents), so this is
  // present at runtime; optional only so hand-built test fixtures stay valid.
  readonly endsAt?: Date;
}

export type EventRefResolution =
  | { readonly status: "resolved"; readonly event: EventRefLike }
  | { readonly status: "ambiguous"; readonly candidates: readonly EventRefLike[] }
  | { readonly status: "not-found" };

/**
 * Resolve a calendar event the agent named — its exact id OR a distinct word
 * from its title ('dentist') — so `update` / `delete` work in ONE shot instead
 * of forcing the small model to chain list → find-id → act. Exact-id wins;
 * otherwise a case-insensitive title-substring match: a unique hit resolves, two+
 * return the candidates (never guess), zero is not-found. Pure (mirrors
 * resolveReminderRef / resolveTaskRef).
 */
export function resolveEventByRef(events: readonly EventRefLike[], ref: string): EventRefResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const byId = events.find((event) => event.id === trimmed);
  if (byId) {
    return { event: byId, status: "resolved" };
  }
  const lower = trimmed.toLowerCase();
  const byTitle = events.filter((event) => event.title.toLowerCase().includes(lower));
  if (byTitle.length === 1) {
    return { event: byTitle[0]!, status: "resolved" };
  }
  if (byTitle.length > 1) {
    return { candidates: byTitle, status: "ambiguous" };
  }
  return { status: "not-found" };
}

// The local-timezone rendering the chat model should echo. An all-day event
// has no meaningful clock time (its startsAt is local midnight), so show the
// date only — otherwise `formatDueLocal` would read it back as "12:00 AM".
function eventLocal(when: Date, allDay: boolean): string {
  return allDay
    ? when.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" })
    : formatDueLocal(when.toISOString());
}

function serializeEvent(event: CalendarEvent): JsonObject {
  return {
    allDay: event.allDay,
    endsAtIso: event.endsAt.toISOString(),
    endsAtLocal: eventLocal(event.endsAt, event.allDay),
    id: event.id,
    providerId: event.providerId,
    startsAtIso: event.startsAt.toISOString(),
    startsAtLocal: eventLocal(event.startsAt, event.allDay),
    title: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(event.notes ? { notes: event.notes } : {}),
    ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] as JsonValue } : {}),
    ...(event.url ? { url: event.url } : {})
  };
}

function parseIsoDate(value: string | undefined, anchor: () => Date = () => new Date()): Date | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return resolveRelativeTimePhrase(value, anchor);
}
