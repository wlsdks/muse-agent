// Imminent-item collection — calendar + task sources scanned into the
// common `ImminentItem` shape the notice loop iterates and delivers.

import type { CalendarEvent, CalendarProviderRegistry } from "@muse/calendar";
import { readTasks, type PersistedTask, type ProactiveFiredKind } from "@muse/stores";

import { minutesUntil } from "./quiet-hours.js";

/**
 * Order imminent items soonest-first so the most time-critical one
 * interrupts first (Proactive Agent, arXiv 2410.12361: prioritise WHAT to
 * surface). Items are collected per-source (calendar, then tasks), so without
 * this a task due in 2 min could fire after a calendar event 9 min out purely
 * by insertion order. Stable: equal start times keep their collection order.
 * Non-finite / missing start times sort last (deterministic, never NaN-poison).
 */
export function sortImminentByStart<T extends { readonly startsAt: Date }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const aMs = a.startsAt instanceof Date ? a.startsAt.getTime() : Number.NaN;
    const bMs = b.startsAt instanceof Date ? b.startsAt.getTime() : Number.NaN;
    const aOk = Number.isFinite(aMs);
    const bOk = Number.isFinite(bMs);
    if (aOk && bOk) return aMs - bMs;
    if (aOk) return -1;
    if (bOk) return 1;
    return 0;
  });
}

export interface ImminentItem {
  readonly kind: ProactiveFiredKind;
  readonly id: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly text: string;
  /**
   * Short factual description fed to the agent-synthesis prompt.
   * The flat `text` already contains it, but `factSheet` strips
   * emoji + redundant suffix so the LLM has a clean input.
   */
  readonly factSheet: string;
}

export interface CollectedImminent {
  readonly items: readonly ImminentItem[];
  readonly errors: readonly string[];
}

// A thrown registry/store read is caught and returned as an error string
// (never propagated) so one failing source can't abort the whole tick.
export async function collectImminentCalendar(
  calendarRegistry: CalendarProviderRegistry,
  nowDate: Date,
  cutoff: Date
): Promise<CollectedImminent> {
  const items: ImminentItem[] = [];
  const errors: string[] = [];
  try {
    const events = await calendarRegistry.listEvents({ from: nowDate, to: cutoff });
    for (const event of events) {
      if (event.allDay) continue;
      // A malformed feed / hand-edited ~/.muse/calendar.json yields
      // an Invalid Date here. NaN range comparisons are all false,
      // so without this it slips through and `.toISOString()` below
      // throws — aborting the whole tick (every later imminent item
      // silently lost). Mirrors the task path's dueAt NaN guard.
      if (Number.isNaN(event.startsAt.getTime())) continue;
      if (event.startsAt < nowDate || event.startsAt > cutoff) continue;
      if (isCalendarOptedOut(event)) continue;
      items.push({
        factSheet: calendarFactSheet(event, nowDate),
        id: event.id,
        kind: "calendar",
        startsAt: event.startsAt,
        text: calendarNoticeText(event, nowDate),
        title: event.title
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    errors.push(`calendar.listEvents failed: ${message}`);
  }
  return { errors, items };
}

export async function collectImminentTasks(
  tasksFile: string,
  nowDate: Date,
  cutoff: Date
): Promise<CollectedImminent> {
  const items: ImminentItem[] = [];
  const errors: string[] = [];
  try {
    const tasks = await readTasks(tasksFile);
    for (const task of tasks) {
      if (task.status !== "open") continue;
      if (!task.dueAt) continue;
      if (task.proactive === false) continue;
      const dueAt = new Date(task.dueAt);
      if (Number.isNaN(dueAt.getTime())) continue;
      if (dueAt < nowDate || dueAt > cutoff) continue;
      items.push({
        factSheet: taskFactSheet(task, dueAt, nowDate),
        id: task.id,
        kind: "task",
        startsAt: dueAt,
        text: taskNoticeText(task, dueAt, nowDate),
        title: task.title
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    errors.push(`tasks.readTasks failed: ${message}`);
  }
  return { errors, items };
}

/**
 * Opt-out marker — case-insensitive `[no-proactive]` anywhere in the
 * event's user-visible text (title or notes). Provider-neutral so
 * the same opt-out works against every CalendarProvider without
 * needing per-backend extended-property plumbing.
 */
function isCalendarOptedOut(event: CalendarEvent): boolean {
  const marker = "[no-proactive]";
  if (event.title.toLowerCase().includes(marker)) return true;
  if (event.notes && event.notes.toLowerCase().includes(marker)) return true;
  return false;
}

function calendarNoticeText(event: CalendarEvent, now: Date): string {
  const minutes = minutesUntil(event.startsAt, now);
  const head = minutes === 0
    ? `⏰ ${event.title} starting now`
    : `⏰ ${event.title} in ${minutes} min`;
  return event.location ? `${head} (${event.location})` : head;
}

function taskNoticeText(task: PersistedTask, dueAt: Date, now: Date): string {
  const minutes = minutesUntil(dueAt, now);
  return minutes === 0
    ? `📋 ${task.title} due now`
    : `📋 ${task.title} due in ${minutes} min`;
}

function calendarFactSheet(event: CalendarEvent, now: Date): string {
  const minutes = minutesUntil(event.startsAt, now);
  const parts = [
    `kind: calendar event`,
    `title: ${event.title}`,
    `starts in: ${minutes.toString()} minute(s)`,
    `start ISO: ${event.startsAt.toISOString()}`
  ];
  if (event.location) parts.push(`location: ${event.location}`);
  if (event.notes) parts.push(`notes: ${event.notes.slice(0, 200)}`);
  return parts.join("\n");
}

function taskFactSheet(task: PersistedTask, dueAt: Date, now: Date): string {
  const minutes = minutesUntil(dueAt, now);
  const parts = [
    `kind: task`,
    `title: ${task.title}`,
    `due in: ${minutes.toString()} minute(s)`,
    `due ISO: ${dueAt.toISOString()}`
  ];
  if (task.notes) parts.push(`notes: ${task.notes.slice(0, 200)}`);
  if (task.tags && task.tags.length > 0) parts.push(`tags: ${task.tags.join(", ")}`);
  return parts.join("\n");
}
