/**
 * Pure render + select helpers for `muse today` / the in-chat `/today`.
 * Split from commands-today.ts; the briefing shape lives here because the
 * formatters are its primary consumer.
 */

import { computeAvailability, type AvailabilityEventLike, type Contact } from "@muse/mcp";
import { detectCalendarConflicts } from "@muse/domain-tools";
import { stripUntrustedTerminalChars } from "@muse/shared";

import type { RecallHit } from "./commands-recall.js";
import { formatHeadlines, formatWeatherLine } from "./commands-today-feeds.js";
import { formatLocalDate, formatLocalDateTime as shortDateTimeBrief } from "./human-formatters.js";
import { colorize } from "./tty-color.js";

export interface TodayBriefing {
  readonly generatedAt: string;
  readonly weather?: string;
  readonly lookaheadHours: number;
  readonly tasks?: readonly { readonly id: string; readonly title: string; readonly dueAt?: string }[];
  readonly events?: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string; readonly endsAtIso?: string }[];
  readonly notes?: readonly string[];
  readonly reminders?: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
  readonly followups?: readonly { readonly id: string; readonly summary: string; readonly scheduledFor: string }[];
  readonly headlines?: readonly { readonly feedId: string; readonly title: string; readonly link: string; readonly publishedAt: string }[];
  readonly birthdays?: readonly { readonly name: string; readonly daysUntil: number }[];
}

/**
 * Render a composed briefing as the formatted text block (header + every
 * section + empty-state hints). Shared by `muse today` and the in-chat
 * `/today` so both render identically. Each section helper already carries
 * its own trailing newline.
 */
export function formatTodayBrief(briefing: TodayBriefing, local: boolean): string {
  const now = briefingNow(briefing);
  // Lead with what's already past due, then DROP those same items from the
  // prospective sections so each overdue item is surfaced ONCE (in the led
  // heads-up), not buried-and-duplicated below.
  const overdue = selectTodayOverdue(briefing.tasks, briefing.reminders, now);
  const overdueTaskIds = new Set(overdue.tasks.map((t) => t.id));
  const overdueReminderIds = new Set(overdue.reminders.map((r) => r.id));
  const futureTasks = briefing.tasks?.filter((t) => !overdueTaskIds.has(t.id));
  const futureReminders = briefing.reminders?.filter((r) => !overdueReminderIds.has(r.id));
  // When every open task was overdue, the led section already shows them —
  // suppress the prospective Tasks section rather than misreport "(none open)".
  const taskSection =
    futureTasks && futureTasks.length === 0 && overdue.tasks.length > 0
      ? ""
      : formatTasks(futureTasks, now, briefing.lookaheadHours);
  return (
    `Today (${shortDateLabel(briefing.generatedAt)}, next ${briefing.lookaheadHours}h${local ? ", local" : ""})\n`
    + formatOverdue(overdue)
    + formatNextEvent(briefing.events, now)
    + formatWeatherLine(briefing.weather)
    + formatReminders(futureReminders, briefing.generatedAt)
    + formatFollowups(briefing.followups, briefing.generatedAt)
    + taskSection
    + formatEvents(briefing.events)
    + formatTodayConflicts(briefing.events)
    + formatLargestBreak(largestBreakBetweenEvents(briefing.events, now))
    + formatBirthdays(briefing.birthdays)
    + formatNotes(briefing.notes)
    + formatHeadlines(briefing.headlines)
    + formatEmptyStateHints(briefing)
  );
}

/**
 * The OVERDUE slice of the on-demand `muse today` digest — open tasks +
 * pending reminders whose due moment is ALREADY PAST. The on-demand twin of
 * the morning brief's `selectBriefOverdue`: the brief LEADS with these (most
 * time-sensitive, still actionable today) while `muse today` only tagged them
 * "(overdue)" buried inside the per-category lists. Operates on the briefing's
 * already-serialized shapes (the readers pre-filter to open tasks / pending
 * reminders), so it only filters past-due. Pure; most-overdue-first.
 */
export function selectTodayOverdue(
  tasks: TodayBriefing["tasks"],
  reminders: TodayBriefing["reminders"],
  now: Date
): {
  readonly tasks: readonly { readonly id: string; readonly title: string; readonly dueAt: string }[];
  readonly reminders: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[];
} {
  const nowMs = now.getTime();
  const pastDue = (iso: string | undefined): boolean => {
    if (!iso) return false;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) && ms < nowMs;
  };
  return {
    reminders: (reminders ?? [])
      .filter((r) => pastDue(r.dueAt))
      .map((r) => ({ dueAt: r.dueAt, id: r.id, text: r.text }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt)),
    tasks: (tasks ?? [])
      .filter((t) => pastDue(t.dueAt))
      .map((t) => ({ dueAt: t.dueAt as string, id: t.id, title: t.title }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
  };
}

/**
 * The LED "act today" heads-up for `muse today` — open tasks + pending
 * reminders already past their due moment, surfaced ABOVE the prospective
 * sections so they aren't buried (the on-demand twin of the morning brief's
 * OVERDUE lead). Empty when nothing is overdue.
 */
export function formatOverdue(overdue: ReturnType<typeof selectTodayOverdue>): string {
  const count = overdue.tasks.length + overdue.reminders.length;
  if (count === 0) {
    return "";
  }
  const lines = [
    ...overdue.tasks.map((t) => `  ${colorize("⚠", "red")} ${t.title} (was due ${shortDateTimeBrief(t.dueAt)})`),
    ...overdue.reminders.map((r) => `  ${colorize("⚠", "red")} ${r.text} (was due ${shortDateTimeBrief(r.dueAt)})`)
  ];
  return `\n${colorize(`⚠ Overdue — past due, still open, act today (${count.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}

/**
 * SB/proactive: build a recall query from today's most concrete items (task +
 * event titles, tasks first) so the briefing can surface related past knowledge.
 * Pure — empty when there's nothing concrete to connect from.
 */
export function pickConnectionQuery(briefing: {
  readonly tasks?: readonly { readonly title: string }[];
  readonly events?: readonly { readonly title: string }[];
}): string {
  return [
    ...(briefing.tasks ?? []).map((t) => t.title),
    ...(briefing.events ?? []).map((e) => e.title)
  ]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 5)
    .join("; ");
}

/**
 * Render the proactive "Worth revisiting" block — notes whose age landed
 * on a spaced-review interval today (spacing effect / Leitner). Empty when
 * nothing's due, so most days it stays silent. Shows the filename + the
 * interval it crossed.
 */
export function formatRevisitSection(due: readonly { readonly path: string; readonly intervalDays: number }[]): string {
  if (due.length === 0) {
    return "";
  }
  const lines = due.map((d) => `  [${d.intervalDays.toString()}d] ${d.path.split("/").pop() ?? d.path}`);
  return `\n📒 Worth revisiting (spaced review):\n${lines.join("\n")}\n`;
}


/** Render the proactive "Related in your brain" block (empty when no hits). */
export function formatConnectionsSection(hits: readonly RecallHit[]): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = hits.map((h) => `  [${h.source}] ${h.ref.split("/").pop() ?? h.ref} — ${h.snippet.replace(/\s+/gu, " ").trim().slice(0, 80)}`);
  return `\n💡 Related in your brain:\n${lines.join("\n")}\n`;
}

/**
 * When every section came back empty (fresh install — no tasks, no
 * events, no notes, no reminders, no followups), the briefing
 * collapses to a wall of "(none)" lines with no next step. Surface
 * a few onboarding commands so a first-time user knows where to
 * start. Suppressed the moment any section carries data — once
 * the user has at least one of anything the report is informative
 * on its own.
 */
function formatEmptyStateHints(briefing: TodayBriefing): string {
  const hasContent =
    (briefing.tasks?.length ?? 0) > 0
    || (briefing.events?.length ?? 0) > 0
    || (briefing.notes?.length ?? 0) > 0
    || (briefing.reminders?.length ?? 0) > 0
    || (briefing.followups?.length ?? 0) > 0
    || (briefing.headlines?.length ?? 0) > 0;
  if (hasContent) {
    return "";
  }
  return [
    "",
    "Looks like a fresh start. A few JARVIS-friendly ways to seed today:",
    "  muse tasks add \"Send Q3 memo\" --due tomorrow",
    "  muse remind add \"Call vet\" \"tomorrow at 6pm\"",
    "  muse notes save daily/2026-05-14.md \"Today's plan: ...\"",
    "  muse remember \"I prefer concise Korean replies\"",
    ""
  ].join("\n");
}

function shortDateLabel(generatedAt: string): string {
  return formatLocalDate(generatedAt);
}

function formatReminders(
  reminders: readonly { readonly id: string; readonly text: string; readonly dueAt: string }[] | undefined,
  generatedAt: string
): string {
  if (!reminders || reminders.length === 0) {
    return "";
  }
  const nowMs = Date.parse(generatedAt);
  const lines = reminders.map((reminder) => {
    const dueMs = Date.parse(reminder.dueAt);
    const overdue = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs
      ? ` ${colorize("(overdue)", "red")}`
      : "";
    return `  - [${reminder.id.slice(0, 12)}] ${shortDateTimeBrief(reminder.dueAt)}  ${reminder.text}${overdue}`;
  });
  return `\n${colorize(`Reminders (${reminders.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}

function formatBirthdays(birthdays: TodayBriefing["birthdays"]): string {
  if (!birthdays || birthdays.length === 0) {
    return "";
  }
  const when = (days: number): string => days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days.toString()} days`;
  const lines = birthdays.map((birthday) => `  🎂 ${birthday.name} — ${when(birthday.daysUntil)}`);
  return `\n${colorize(`Birthdays (${birthdays.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}


function formatFollowups(
  followups: readonly { readonly id: string; readonly summary: string; readonly scheduledFor: string }[] | undefined,
  generatedAt: string
): string {
  if (!followups || followups.length === 0) {
    return "";
  }
  const nowMs = Date.parse(generatedAt);
  const lines = followups.map((followup) => {
    const dueMs = Date.parse(followup.scheduledFor);
    const overdue = Number.isFinite(dueMs) && Number.isFinite(nowMs) && dueMs < nowMs
      ? ` ${colorize("(overdue)", "red")}`
      : "";
    return `  - [${followup.id.slice(0, 12)}] ${shortDateTimeBrief(followup.scheduledFor)}  ${followup.summary}${overdue}`;
  });
  return `\n${colorize(`Followups (${followups.length.toString()}):`, "bold")}\n${lines.join("\n")}\n`;
}

function briefingNow(briefing: TodayBriefing): Date {
  const ms = Date.parse(briefing.generatedAt);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/**
 * Relative due tag for a task in the daily view — " (overdue)" /
 * " (today)" / " (tomorrow)" / " (in N days)", or "" when undated /
 * unparseable. Calendar-day diff (local midnights) so a dueAt later
 * today still reads "today". Lets `muse today` show urgency instead of
 * a flat list of titles.
 */
export function relativeDueTag(dueAtIso: string | undefined, now: Date): string {
  if (!dueAtIso) {
    return "";
  }
  const ms = Date.parse(dueAtIso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const due = new Date(ms);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayDiff = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime() - today.getTime()) / 86_400_000);
  if (dayDiff < 0) {
    return " (overdue)";
  }
  if (dayDiff === 0) {
    return " (today)";
  }
  if (dayDiff === 1) {
    return " (tomorrow)";
  }
  return ` (in ${dayDiff.toString()} days)`;
}

export function formatTasks(
  tasks: readonly { readonly id: string; readonly title: string; readonly dueAt?: string }[] | undefined,
  now: Date,
  lookaheadHours = 24
): string {
  if (!tasks) {
    return "\nTasks: (not configured)\n";
  }
  if (tasks.length === 0) {
    return "\nTasks: (none open)\n";
  }
  const horizon = now.getTime() + lookaheadHours * 3_600_000;
  // Imminent = dated AND due within the window (overdue included — it is the
  // most pressing). Undated or far-future tasks are the long tail: in the
  // morning brief they are noise, so collapse them to a count + a pointer to
  // the full list rather than dumping every open task.
  const imminent = tasks.filter((task) => {
    if (!task.dueAt) {
      return false;
    }
    const due = Date.parse(task.dueAt);
    return Number.isFinite(due) && due <= horizon;
  });
  const remaining = tasks.length - imminent.length;
  const moreLine = remaining > 0 ? `\n  +${remaining} more open (use \`muse tasks list\`)` : "";
  if (imminent.length === 0) {
    return `\nTasks: ${tasks.length} open, none due within ${lookaheadHours}h (use \`muse tasks list\`)\n`;
  }
  const lines = imminent.map((task) => `  - [${task.id.slice(0, 12)}] ${task.title}${relativeDueTag(task.dueAt, now)}`);
  return `\nTasks due ≤${lookaheadHours}h (${imminent.length}):\n${lines.join("\n")}${moreLine}\n`;
}

/**
 * Proactive double-booking warning for the morning briefing: flag events that
 * overlap in time so the user is told "you're scheduled twice at once" without
 * having to run `muse calendar conflicts`. Only events carrying both start AND
 * end times participate (the local briefing provides them; a remote briefing
 * whose events lack endsAtIso simply yields no warning). Empty when none.
 */
export function formatTodayConflicts(
  events: readonly { readonly title: string; readonly startsAtIso: string; readonly endsAtIso?: string }[] | undefined
): string {
  const timed = (events ?? []).flatMap((e) =>
    e.endsAtIso ? [{ title: e.title, startsAt: new Date(e.startsAtIso), endsAt: new Date(e.endsAtIso) }] : []
  );
  const conflicts = detectCalendarConflicts(timed);
  if (conflicts.length === 0) {
    return "";
  }
  const lines = conflicts.map((c) => {
    const a = stripUntrustedTerminalChars(c.a.title).replace(/\s+/gu, " ").trim();
    const b = stripUntrustedTerminalChars(c.b.title).replace(/\s+/gu, " ").trim();
    return `  - "${a}" overlaps "${b}" (${c.overlapStartsAt.toISOString().slice(11, 16)}–${c.overlapEndsAt.toISOString().slice(11, 16)} UTC)`;
  });
  return `\n⚠️  Double-booked (${conflicts.length.toString()}):\n${lines.join("\n")}\n`;
}

const NAME_TOKEN = /[^\p{L}\p{N}]+/u;

/**
 * When a calendar event's title names a known contact who has a RELATIONSHIP to
 * the user, return the annotation to append — "Lunch with Dana" → " (your
 * manager)" — surfacing the relationship graph in the day view.
 * Matches a contact's name/alias TOKEN as a whole word in the title (so "Dana"
 * matches "Lunch with Dana"); only relationship-bearing contacts annotate (a
 * bare name adds nothing). Empty when nothing matches. Pure.
 */
export function annotateEventTitle(title: string, contacts: readonly Contact[]): string {
  const words = new Set(title.toLowerCase().split(NAME_TOKEN).filter((w) => w.length >= 2));
  if (words.size === 0) {
    return "";
  }
  const matched: { readonly first: string; readonly relationship: string }[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    const relationship = contact.relationship?.trim();
    if (!relationship || seen.has(contact.id)) {
      continue;
    }
    const names = [contact.name, ...(contact.aliases ?? [])];
    const hit = names.some((name) =>
      name.toLowerCase().split(NAME_TOKEN).some((token) => token.length >= 2 && words.has(token))
    );
    if (hit) {
      seen.add(contact.id);
      matched.push({ first: contact.name.split(/\s+/u)[0] ?? contact.name, relationship });
    }
  }
  if (matched.length === 0) {
    return "";
  }
  if (matched.length === 1) {
    return ` (your ${matched[0]!.relationship})`;
  }
  return ` (${matched.map((m) => `${m.first}: your ${m.relationship}`).join("; ")})`;
}

export function formatEvents(events: readonly { readonly id: string; readonly title: string; readonly startsAtIso: string }[] | undefined): string {
  if (!events) {
    return "\nUpcoming: (calendar not configured)\n";
  }
  if (events.length === 0) {
    return "\nUpcoming: (no calendar events in window)\n";
  }
  // A calendar event SUMMARY is set by whoever sent the invite
  // (CalDAV / Google / shared calendars) — third-party-controlled
  // and printed straight to the terminal, so strip ESC/C0/C1/DEL
  // like the inbox / feeds / search surfaces.
  const lines = events.map((event) => {
    const title = stripUntrustedTerminalChars(event.title).replace(/\s+/gu, " ").trim();
    return `  - ${event.startsAtIso.slice(11, 16)} — ${title}`;
  });
  return `\nUpcoming (${events.length}):\n${lines.join("\n")}\n`;
}

/** Relative countdown to the next event — "in 25 min" / "in 2h 10m" / "in 3 days". */
function formatTimeUntil(deltaMs: number): string {
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `in ${mins.toString()} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `in ${hours.toString()}h ${remMins.toString()}m` : `in ${hours.toString()}h`;
  const days = Math.round(hours / 24);
  return `in ${days.toString()} day${days === 1 ? "" : "s"}`;
}

const MIN_BREAK_MS = 45 * 60_000; // a gap shorter than this isn't worth flagging as a "free block"

function formatBreakDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours === 0) return `${rem.toString()}m`;
  if (rem === 0) return `${hours.toString()}h`;
  return `${hours.toString()}h ${rem.toString()}m`;
}

/**
 * The largest open gap BETWEEN today's meetings (events merged into busy blocks
 * first, so back-to-back events don't count as a gap) — your longest focus
 * window. ONLY gaps bounded by a meeting on both sides count, so the open-ended
 * trailing/overnight stretch after your last event is never reported. Bounded to
 * the rest of TODAY (local). Null when there's no ≥45-min between-meeting gap. Pure.
 */
export function largestBreakBetweenEvents(
  events: readonly { readonly startsAtIso: string; readonly endsAtIso?: string }[] | undefined,
  now: Date
): { readonly startsAt: Date; readonly endsAt: Date } | null {
  if (!events || events.length === 0) {
    return null;
  }
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const eventLikes: AvailabilityEventLike[] = events
    .map((event) => {
      const startsAt = new Date(event.startsAtIso);
      const endsAt = event.endsAtIso ? new Date(event.endsAtIso) : new Date(startsAt.getTime() + 3_600_000);
      return { allDay: false, endsAt, startsAt, title: "" };
    })
    .filter((event) => Number.isFinite(event.startsAt.getTime()) && Number.isFinite(event.endsAt.getTime()) && event.endsAt.getTime() > event.startsAt.getTime());
  const { busy } = computeAvailability(eventLikes, { from: now, to: endOfToday });
  let best: { startsAt: Date; endsAt: Date } | null = null;
  for (let i = 0; i < busy.length - 1; i += 1) {
    const startsAt = busy[i]!.endsAt;
    const endsAt = busy[i + 1]!.startsAt;
    const length = endsAt.getTime() - startsAt.getTime();
    if (length >= MIN_BREAK_MS && (best === null || length > best.endsAt.getTime() - best.startsAt.getTime())) {
      best = { endsAt, startsAt };
    }
  }
  return best;
}

/** The "🟢 Biggest free block …" line for `muse today`, or empty when there's no meaningful gap. Pure. */
export function formatLargestBreak(slot: { readonly startsAt: Date; readonly endsAt: Date } | null): string {
  if (!slot) {
    return "";
  }
  const clock = (date: Date): string => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `\n🟢 Biggest free block: ${clock(slot.startsAt)}–${clock(slot.endsAt)} (${formatBreakDuration(slot.endsAt.getTime() - slot.startsAt.getTime())}) — your longest open stretch between today's events.\n`;
}

/**
 * The soonest FUTURE event as a time-aware lead — "⏰ Next: Standup in 25 min" —
 * so `muse today` tells you what's imminent at a glance instead of leaving you to
 * subtract the clock from a flat list of start times. Events that already started
 * are skipped; empty when nothing upcoming remains in the window (end of day), so
 * it never adds noise. Pure.
 */
export function formatNextEvent(
  events: readonly { readonly title: string; readonly startsAtIso: string }[] | undefined,
  now: Date
): string {
  if (!events || events.length === 0) {
    return "";
  }
  const nowMs = now.getTime();
  const next = events
    .map((event) => ({ startMs: Date.parse(event.startsAtIso), title: event.title }))
    .filter((event) => Number.isFinite(event.startMs) && event.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];
  if (!next) {
    return "";
  }
  const title = stripUntrustedTerminalChars(next.title).replace(/\s+/gu, " ").trim();
  return `⏰ Next: ${title} ${formatTimeUntil(next.startMs - nowMs)}\n`;
}

function formatNotes(notes: readonly string[] | undefined): string {
  if (!notes) {
    return "\nRecent notes: (notes dir not configured)\n";
  }
  if (notes.length === 0) {
    return "\nRecent notes: (none)\n";
  }
  return `\nRecent notes:\n${notes.map((name) => `  - ${name}`).join("\n")}\n`;
}
