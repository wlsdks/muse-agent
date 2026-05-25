/**
 * Pure helpers for the chat's "speaks-first" (proactive) surfacing — the
 * chat polls for imminent reminders / follow-ups and Muse raises them in
 * the transcript unprompted. Store reading is injected; this module only
 * decides what is imminent, what is new, and how to phrase it.
 */

import { stripUntrustedTerminalChars } from "@muse/shared";

export interface ProactiveItem {
  readonly id: string;
  readonly text: string;
  readonly dueAt?: string;
}

/**
 * Items due inside the lead window — from a short grace before `now`
 * (so a just-passed reminder still fires once) to `now + leadMs`. Undated
 * items never count.
 */
export function imminentItems(
  items: readonly ProactiveItem[],
  nowMs: number,
  leadMs: number,
  graceMs = 120_000
): ProactiveItem[] {
  return items.filter((item) => {
    if (!item.dueAt) return false;
    const due = Date.parse(item.dueAt);
    return Number.isFinite(due) && due >= nowMs - graceMs && due <= nowMs + leadMs;
  });
}

/** Items whose id hasn't been surfaced yet this session. */
export function pickUnseen(items: readonly ProactiveItem[], seen: ReadonlySet<string>): ProactiveItem[] {
  return items.filter((item) => !seen.has(item.id));
}

/** A short Korean relative-time label for an upcoming/just-passed due time. */
export function relativeWhen(dueAtIso: string | undefined, nowMs: number): string {
  if (!dueAtIso) return "";
  const due = Date.parse(dueAtIso);
  if (!Number.isFinite(due)) return "";
  const diffMin = Math.round((due - nowMs) / 60_000);
  if (diffMin <= 0 && diffMin > -5) return "now";
  if (diffMin < 0) return "overdue";
  if (diffMin < 60) return `in ${diffMin}m`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** The line Muse speaks when it raises an item first. */
export function proactiveNoticeText(item: ProactiveItem, whenLabel: string): string {
  const when = whenLabel.length > 0 ? ` (${whenLabel})` : "";
  return `📌 ${stripUntrustedTerminalChars(item.text)}${when} — want a hand?`;
}

/**
 * One notice for a batch of imminent items, so a quiet moment with several due
 * things speaks ONCE, not in a wall of 📌 lines (speaks-first, not noisy).
 * 0 → "" (caller skips); 1 → the normal single line; ≥2 → a grouped line.
 */
export function groupProactiveNotice(items: readonly ProactiveItem[], nowMs: number): string {
  if (items.length === 0) return "";
  if (items.length === 1) return proactiveNoticeText(items[0] as ProactiveItem, relativeWhen(items[0]?.dueAt, nowMs));
  const parts = items.map((item) => {
    const when = relativeWhen(item.dueAt, nowMs);
    return `${stripUntrustedTerminalChars(item.text)}${when ? ` (${when})` : ""}`;
  });
  return `📌 ${items.length} things need you: ${parts.join("; ")} — want a hand?`;
}

export interface DueTaskInput {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
}

/**
 * Open tasks whose due time is at or before `horizonMs`, as proactive items —
 * so Muse can nudge "Task due: pay rent" the way it already surfaces reminders.
 * Done tasks and undated ones never qualify; the caller's `imminentItems`
 * window then bounds how early/late they fire (same path as reminders).
 */
export function dueTaskItems(tasks: readonly DueTaskInput[], horizonMs: number): ProactiveItem[] {
  return tasks
    .filter((task) => task.status === "open" && task.dueAt !== undefined && Number.isFinite(Date.parse(task.dueAt)) && Date.parse(task.dueAt) <= horizonMs)
    .map((task) => ({ id: `task:${task.id}`, text: `Task due: ${task.title}`, ...(task.dueAt ? { dueAt: task.dueAt } : {}) }));
}

export interface CalendarEventInput {
  readonly id: string;
  readonly title: string;
  readonly startsAtIso: string;
}

/**
 * Imminent calendar events as proactive items — so Muse nudges "Standup (in
 * 15m)" the way it surfaces reminders/tasks (JARVIS schedule awareness). Events
 * starting at or before `horizonMs` with a parseable start qualify; the caller's
 * `imminentItems` window then bounds how early/late they fire (same path as
 * reminders). The render layer strips untrusted bytes from the title.
 */
export function calendarEventItems(events: readonly CalendarEventInput[], horizonMs: number): ProactiveItem[] {
  return events
    .filter((event) => {
      const startsAt = Date.parse(event.startsAtIso);
      return Number.isFinite(startsAt) && startsAt <= horizonMs;
    })
    .map((event) => ({ id: `event:${event.id}`, text: `Calendar: ${event.title}`, dueAt: event.startsAtIso }));
}

export interface JobDoneInput {
  readonly id: string;
  readonly status: string;
  readonly prompt?: string;
  readonly finalText?: string;
  readonly finishedAt?: string;
}

/** The line Muse speaks unprompted when a background job finishes. */
export function jobDoneNoticeText(job: JobDoneInput): string {
  const label = stripUntrustedTerminalChars(job.prompt ?? job.id).replace(/\s+/gu, " ").trim().slice(0, 50);
  if (job.status === "error") return `✗ Background job failed: ${label}`;
  const result = job.finalText ? ` — ${stripUntrustedTerminalChars(job.finalText).replace(/\s+/gu, " ").trim().slice(0, 80)}` : "";
  return `✓ Background job done: ${label}${result}`;
}

/**
 * Background jobs that finished AFTER the chat opened (`sinceIso`), as
 * pre-phrased proactive items. Unlike reminders, a completion isn't time-
 * windowed — it surfaces once, whenever the poll next notices it; `sinceIso`
 * stops every previously-finished job from announcing on the first tick, and
 * the caller's seen-set dedupes the rest.
 */
export function jobCompletionItems(jobs: readonly JobDoneInput[], sinceIso: string): ProactiveItem[] {
  return jobs
    .filter((job) => (job.status === "done" || job.status === "error") && job.finishedAt !== undefined && job.finishedAt > sinceIso)
    .map((job) => ({ id: `job:${job.id}`, text: jobDoneNoticeText(job), ...(job.finishedAt ? { dueAt: job.finishedAt } : {}) }));
}
