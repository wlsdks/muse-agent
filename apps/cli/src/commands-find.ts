/**
 * `muse find <query>` — one fast, deterministic substring search across the
 * user's STRUCTURED local stores (tasks, reminders, contacts) so "where did I
 * mention the dentist?" has a single answer. Distinct from `muse recall`
 * (semantic memory over notes + episodes) and `muse search` (the web), and
 * from `muse notes search` (note bodies) — those stay the right tool for
 * their domain; this stitches the tracked-item stores together.
 */

import { queryContacts, readReminders, readTasks } from "@muse/mcp";
import { resolveContactsFile, resolveLocalCalendarFile, resolveRemindersFile, resolveTasksFile } from "@muse/autoconfigure";
import { LocalCalendarProvider, type CalendarEvent } from "@muse/calendar";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

export type FindDomain = "task" | "reminder" | "contact" | "event";

export interface FindHit {
  readonly domain: FindDomain;
  readonly id: string;
  readonly label: string;
  /** The matched secondary field, shown when it isn't the label itself. */
  readonly context?: string;
}

export interface FindSources {
  readonly tasks?: readonly { readonly id: string; readonly title?: string; readonly notes?: string }[];
  readonly reminders?: readonly { readonly id: string; readonly text?: string }[];
  readonly contacts?: readonly {
    readonly id: string;
    readonly name?: string;
    readonly email?: string;
    readonly handle?: string;
    readonly phone?: string;
    readonly aliases?: readonly string[];
  }[];
  readonly events?: readonly { readonly id: string; readonly title?: string; readonly notes?: string }[];
}

/**
 * Pure substring match (case-insensitive) over the structured stores. A blank
 * query matches nothing (a `find` with no term is a usage error, not "match
 * everything"). Contacts match on name/email/handle/phone/alias.
 */
export function findAcrossDomains(sources: FindSources, query: string): readonly FindHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const has = (value: unknown): boolean => typeof value === "string" && value.toLowerCase().includes(q);
  const hits: FindHit[] = [];
  for (const task of sources.tasks ?? []) {
    if (has(task.title) || has(task.notes)) {
      hits.push({
        domain: "task",
        id: task.id,
        label: task.title ?? "(untitled)",
        ...(has(task.notes) && !has(task.title) ? { context: task.notes } : {})
      });
    }
  }
  for (const reminder of sources.reminders ?? []) {
    if (has(reminder.text)) hits.push({ domain: "reminder", id: reminder.id, label: reminder.text ?? "" });
  }
  for (const contact of sources.contacts ?? []) {
    const aliasHit = (contact.aliases ?? []).some((alias) => has(alias));
    if (has(contact.name) || has(contact.email) || has(contact.handle) || has(contact.phone) || aliasHit) {
      hits.push({ domain: "contact", id: contact.id, label: contact.name ?? "" });
    }
  }
  for (const event of sources.events ?? []) {
    if (has(event.title) || has(event.notes)) {
      hits.push({
        domain: "event",
        id: event.id,
        label: event.title ?? "(untitled)",
        ...(has(event.notes) && !has(event.title) ? { context: event.notes } : {})
      });
    }
  }
  return hits;
}

const DOMAIN_LABELS: Record<FindDomain, string> = {
  task: "Tasks",
  reminder: "Reminders",
  contact: "Contacts",
  event: "Calendar"
};

export function registerFindCommand(program: Command, io: ProgramIO): void {
  program
    .command("find")
    .description("Search your tasks, reminders, contacts, and calendar for a term (local substring). Notes → `muse notes search`; memory → `muse recall`.")
    .argument("<query...>", "Text to look for, e.g. 'dentist' (joined by spaces)")
    .option("--json", "Print the raw hits instead of the grouped list")
    .action(async (parts: readonly string[], options: { readonly json?: boolean }) => {
      const query = parts.join(" ").trim();
      if (query.length === 0) {
        throw new Error("find needs a query, e.g. `muse find dentist`");
      }
      const env = process.env as Record<string, string | undefined>;
      const now = Date.now();
      const readLocalEvents = async (): Promise<readonly CalendarEvent[]> =>
        new LocalCalendarProvider({ file: resolveLocalCalendarFile(env) }).listEvents({
          from: new Date(now - 365 * 86_400_000),
          to: new Date(now + 365 * 86_400_000)
        });
      const [tasks, reminders, contacts, events] = await Promise.all([
        readTasks(resolveTasksFile(env)).catch(() => []),
        readReminders(resolveRemindersFile(env)).catch(() => []),
        queryContacts(resolveContactsFile(env)).catch(() => []),
        readLocalEvents().catch(() => [])
      ]);
      const hits = findAcrossDomains({ contacts, events, reminders, tasks }, query);
      if (options.json) {
        io.stdout(`${JSON.stringify({ hits, query, total: hits.length }, null, 2)}\n`);
        return;
      }
      if (hits.length === 0) {
        io.stdout(`No tasks, reminders, or contacts match "${query}".\n`);
        return;
      }
      io.stdout(`Found ${hits.length.toString()} match(es) for "${query}":\n`);
      for (const domain of ["task", "reminder", "contact", "event"] as const) {
        const group = hits.filter((hit) => hit.domain === domain);
        if (group.length === 0) continue;
        io.stdout(`  ${DOMAIN_LABELS[domain]}:\n`);
        for (const hit of group) io.stdout(`    - ${hit.label}${hit.context ? ` — ${hit.context}` : ""}\n`);
      }
    });
}
