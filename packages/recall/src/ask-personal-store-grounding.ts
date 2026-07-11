/**
 * Personal-store grounding for `muse ask`, lifted out of the commands-ask god-file:
 * open tasks, upcoming calendar events (merged across all registered providers),
 * pending reminders, and query-matching contacts. Each is gated by its flag
 * (default-on), reads its store, and is fail-soft — a missing/unreadable store
 * contributes no block. Returns the blocks + the match lists the action threads
 * into the prompt, the citation gate, and the verdict.
 */

import { lexicalTokens } from "@muse/agent-core";
import type { CalendarEvent } from "@muse/calendar";
import { buildCalendarContextBlock, buildReminderContextBlock, buildTaskContextBlock } from "./context-blocks.js";
import { buildContactContextBlock, contactMatchScore } from "./select.js";
import { readContacts, readReminders, readTasks, type Contact, type PersistedReminder, type PersistedTask } from "@muse/stores";

import { parseBoundedInt } from "./parse-bounded-int.js";

export interface PersonalStoreGrounding {
  readonly openTasks: readonly PersistedTask[];
  readonly taskBlock: string;
  readonly upcomingEvents: readonly CalendarEvent[];
  readonly calendarBlock: string;
  readonly pendingReminders: readonly PersistedReminder[];
  readonly reminderBlock: string;
  readonly matchedContacts: readonly Contact[];
  readonly contactBlock: string;
}

export async function buildPersonalStoreGrounding(params: {
  readonly query: string;
  readonly tasks: boolean;
  readonly calendar: boolean;
  readonly calendarDays: string | undefined;
  readonly reminders: boolean;
  readonly contacts: boolean;
  /** Resolved store paths (autoconfigure owns resolution above this package). */
  readonly tasksFile: string;
  readonly remindersFile: string;
  readonly contactsFile: string;
  /** List events across the caller's registered calendar providers (registry stays caller-side). */
  readonly listCalendarEvents: (range: { readonly from: Date; readonly to: Date }) => Promise<readonly CalendarEvent[]>;
}): Promise<PersonalStoreGrounding> {
  const { query, tasks, calendar, calendarDays, reminders, contacts, tasksFile, remindersFile, contactsFile, listCalendarEvents } = params;

  // Open tasks: "what should I focus on today?" hits tasks, not notes. Sort by due
  // date so the most imminent are first; cap to keep the prompt tight.
  let openTasks: readonly PersistedTask[] = [];
  if (tasks) {
    try {
      const all = await readTasks(tasksFile);
      openTasks = all
        .filter((t) => t.status === "open")
        .sort((a, b) => {
          const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
          const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
          return ad - bd;
        })
        .slice(0, 20);
    } catch {
      // tasks file missing or unreadable — silently skip
    }
  }
  const taskBlock = buildTaskContextBlock(openTasks);

  // Upcoming calendar events, merged across all registered providers (local + gcal
  // + caldav + macos) so a mixed setup gets one view. "any meetings tomorrow?"
  let upcomingEvents: readonly CalendarEvent[] = [];
  if (calendar) {
    const days = parseBoundedInt(calendarDays, "--calendar-days", 1, 30, 7);
    const from = new Date();
    const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
    try {
      upcomingEvents = [...(await listCalendarEvents({ from, to }))]
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, 20);
    } catch {
      // provider listing failed — skip calendar grounding
    }
  }
  const calendarBlock = buildCalendarContextBlock(upcomingEvents);

  // Pending reminders (fire-once notifications), distinct from tasks + events.
  let pendingReminders: readonly PersistedReminder[] = [];
  if (reminders) {
    try {
      const all = await readReminders(remindersFile);
      pendingReminders = all
        .filter((r) => r.status === "pending")
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
        .slice(0, 20);
    } catch {
      // file missing — silently skip
    }
  }
  const reminderBlock = buildReminderContextBlock(pendingReminders);

  // MATCHING contacts from the user's own address book, by query-token overlap on
  // name/aliases/email/handle — inject only the relevant people, never the whole book.
  let matchedContacts: readonly Contact[] = [];
  if (contacts) {
    try {
      const queryTokensForContacts = lexicalTokens(query);
      const all = await readContacts(contactsFile);
      matchedContacts = all
        .map((c) => ({ c, score: contactMatchScore(c, queryTokensForContacts) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => x.c);
    } catch {
      // contacts file missing or unreadable — silently skip
    }
  }
  const contactBlock = buildContactContextBlock(matchedContacts);

  return { calendarBlock, contactBlock, matchedContacts, openTasks, pendingReminders, reminderBlock, taskBlock, upcomingEvents };
}
