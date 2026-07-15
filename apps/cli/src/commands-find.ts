/**
 * `muse find <query>` — one fast, deterministic substring search across the
 * user's STRUCTURED local stores (tasks, reminders, contacts) so "where did I
 * mention the dentist?" has a single answer. Distinct from `muse recall`
 * (semantic memory over notes + episodes) and `muse search` (the web), and
 * from `muse notes search` (note bodies) — those stay the right tool for
 * their domain; this stitches the tracked-item stores together.
 */

import { queryContacts, readReminders, readTasks } from "@muse/stores";
import { findAcrossDomains, resolveContactsFile, resolveLocalCalendarFile, resolveRemindersFile, resolveTasksFile, type FindDomain } from "@muse/autoconfigure";
import { LocalCalendarProvider, type CalendarEvent } from "@muse/calendar";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const DOMAIN_LABELS: Record<FindDomain, string> = {
  task: "Tasks",
  reminder: "Reminders",
  contact: "Contacts",
  event: "Calendar"
};

// Derived from DOMAIN_LABELS so the empty-state can never drift out of sync
// with what `find` actually searches (the old literal omitted calendar).
export function formatNoMatches(query: string): string {
  const domains = Object.values(DOMAIN_LABELS).map((label) => label.toLowerCase());
  const list =
    domains.length > 1
      ? `${domains.slice(0, -1).join(", ")}, or ${domains[domains.length - 1]}`
      : (domains[0] ?? "");
  return `No ${list} match "${query}".\n`;
}

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
        io.stdout(formatNoMatches(query));
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
