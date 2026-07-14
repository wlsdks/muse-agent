/**
 * On-disk briefing composition for `muse today --local` and the in-chat
 * `/today` — reads tasks / events / notes / reminders / follow-ups / birthdays
 * from the local files (no API daemon, no model). Split from commands-today.ts.
 */

import { promises as fs } from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";

import {
  resolveContactsFile,
  resolveFollowupsFile,
  resolveLocalCalendarFile,
  resolveNotesDir,
  resolveRemindersFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { LocalCalendarProvider } from "@muse/calendar";
import { compareFollowupsByScheduledFor, compareRemindersByDueAt, compareTasksByDueDate, queryContacts, readFollowups, readReminders, readTasks, resolveUpcomingBirthdays, serializeFollowup, serializeReminder, serializeTask, type PersistedTask } from "@muse/stores";

import { resolveTodayFeedHeadlines, resolveTodayWeatherLine } from "./commands-today-feeds.js";
import { formatTodayBrief, type TodayBriefing } from "./today-format.js";

const MAX_RECENT_NOTES = 5;
const MAX_NOTES_WALK_DEPTH = 8;

export async function composeLocalBriefing(lookaheadHours: number): Promise<TodayBriefing> {
  const env = process.env;
  const tasksFile = resolveTasksFile(env);
  const notesDir = resolveNotesDir(env);
  const calendarFile = resolveLocalCalendarFile(env);
  const remindersFile = resolveRemindersFile(env);
  const followupsFile = resolveFollowupsFile(env);
  const contactsFile = resolveContactsFile(env);
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadHours * 3_600_000);

  const [tasks, events, notes, reminders, followups, birthdays] = await Promise.all([
    readOpenTasks(tasksFile).catch(() => undefined),
    readLocalEvents(calendarFile, now, horizon).catch(() => undefined),
    readRecentNotes(notesDir).catch(() => undefined),
    readDueReminders(remindersFile, horizon).catch(() => undefined),
    readDueFollowups(followupsFile, horizon).catch(() => undefined),
    readUpcomingBirthdays(contactsFile, now).catch(() => undefined)
  ]);

  return {
    birthdays,
    events,
    followups,
    generatedAt: now.toISOString(),
    lookaheadHours,
    notes,
    reminders,
    tasks
  };
}

/**
 * Compose the morning briefing from the LOCAL on-disk sources (tasks, events,
 * notes, reminders, follow-ups) plus weather + feed headlines, and return the
 * formatted text. The in-chat `/today` path — no API daemon, no model — so a
 * small local model never has to chain four tool calls to answer "what's today".
 */
export async function buildLocalTodayText(env: Record<string, string | undefined>, lookaheadHours: number): Promise<string> {
  let briefing = await composeLocalBriefing(lookaheadHours);
  const weather = await resolveTodayWeatherLine(env);
  if (weather) briefing = { ...briefing, weather };
  const headlines = await resolveTodayFeedHeadlines(env, lookaheadHours);
  if (headlines && headlines.length > 0) briefing = { ...briefing, headlines };
  return formatTodayBrief(briefing, true).trimEnd();
}

/**
 * Upcoming birthdays within a week — the same machinery the morning brief uses,
 * surfaced in the on-demand `muse today` digest so a user checking their day
 * doesn't miss "Zelda's birthday is today" just because they didn't wait for the
 * morning brief. Empty when no contact has a birthday in the window.
 */
export async function readUpcomingBirthdays(
  file: string,
  now: Date
): Promise<readonly { name: string; daysUntil: number }[]> {
  const contacts = await queryContacts(file);
  return resolveUpcomingBirthdays(contacts, { now, withinDays: 7 })
    .map((upcoming) => ({ daysUntil: upcoming.daysUntil, name: upcoming.contact.name }));
}

export async function readDueReminders(
  file: string,
  horizon: Date
): Promise<readonly { id: string; text: string; dueAt: string }[]> {
  const all = await readReminders(file);
  return all
    .filter((reminder) => {
      if (reminder.status !== "pending") {
        return false;
      }
      const due = Date.parse(reminder.dueAt);
      if (Number.isNaN(due)) {
        return false;
      }
      return due <= horizon.getTime();
    })
    // Sort by parsed instant, not raw ISO: a lexicographic compare
    // mis-orders mixed-precision / timezone-offset dueAt strings (a
    // hand-edited reminders.json or import need not be canonical), so
    // `muse today` could list a later reminder as more imminent. Reuse
    // the store's canonical comparator (same order as `muse reminders`).
    .slice()
    .sort(compareRemindersByDueAt)
    .map((reminder) => {
      const serialized = serializeReminder(reminder);
      return { dueAt: String(serialized.dueAt), id: String(serialized.id), text: String(serialized.text) };
    });
}

export async function readDueFollowups(
  file: string,
  horizon: Date
): Promise<readonly { id: string; summary: string; scheduledFor: string }[]> {
  const all = await readFollowups(file);
  return all
    .filter((followup) => {
      if (followup.status !== "scheduled") {
        return false;
      }
      const when = Date.parse(followup.scheduledFor);
      if (Number.isNaN(when)) {
        return false;
      }
      return when <= horizon.getTime();
    })
    .slice()
    .sort(compareFollowupsByScheduledFor)
    .map((followup) => {
      const serialized = serializeFollowup(followup);
      return {
        id: String(serialized.id),
        scheduledFor: String(serialized.scheduledFor),
        summary: String(serialized.summary)
      };
    });
}

export async function readLocalEvents(
  file: string,
  from: Date,
  to: Date
): Promise<readonly { id: string; title: string; startsAtIso: string; endsAtIso: string }[]> {
  const provider = new LocalCalendarProvider({ file });
  const events = await provider.listEvents({ from, to });
  return events.map((event) => ({
    id: event.id,
    startsAtIso: event.startsAt.toISOString(),
    endsAtIso: event.endsAt.toISOString(),
    title: event.title
  }));
}

async function readOpenTasks(tasksFile: string): Promise<readonly { id: string; title: string }[]> {
  const all = await readTasks(tasksFile);
  return all
    .filter((task: PersistedTask) => task.status === "open")
    // Due-soonest first (same comparator as `muse tasks list`) so the
    // briefing leads with imminent deadlines instead of burying them
    // under recent quick-captures — and the slice keeps the most
    // due-relevant 50, not just the 50 newest.
    .sort(compareTasksByDueDate)
    .slice(0, 50)
    .map((task) => {
      const serialized = serializeTask(task);
      return {
        id: String(serialized.id),
        title: String(serialized.title),
        ...(serialized.dueAt ? { dueAt: String(serialized.dueAt) } : {})
      };
    });
}

async function readRecentNotes(notesDir: string): Promise<readonly string[]> {
  const root = resolvePath(notesDir);
  const collected: { name: string; mtime: number }[] = [];
  await collectNotesRecursive(root, "", collected, 0);
  return collected
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_RECENT_NOTES)
    .map((entry) => entry.name.split(sep).join("/"));
}

export async function collectNotesRecursive(
  absDir: string,
  relPrefix: string,
  out: { name: string; mtime: number }[],
  depth: number
): Promise<void> {
  if (depth > MAX_NOTES_WALK_DEPTH) {
    return;
  }
  let entries: { readonly name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const fileStats = await Promise.all(
    visible
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const rel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
        try {
          const stat = await fs.stat(join(absDir, entry.name));
          return { mtime: stat.mtime.getTime(), name: rel };
        } catch {
          return undefined;
        }
      })
  );
  for (const entry of fileStats) {
    if (entry) {
      out.push(entry);
    }
  }
  for (const entry of visible) {
    if (entry.isDirectory()) {
      const childAbs = join(absDir, entry.name);
      const childRel = relPrefix.length > 0 ? join(relPrefix, entry.name) : entry.name;
      await collectNotesRecursive(childAbs, childRel, out, depth + 1);
    }
  }
}
