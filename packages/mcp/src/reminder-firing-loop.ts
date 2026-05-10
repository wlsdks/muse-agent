import type { MessagingProviderRegistry } from "@muse/messaging";

import {
  filterReminders,
  fireReminder,
  readReminders,
  writeReminders,
  type PersistedReminder
} from "./personal-reminders-store.js";

/**
 * Phase B firing engine — see `docs/design/reminder-firing.md`.
 *
 * Reads due reminders, fans out to the messaging registry, marks
 * each delivered one as fired, and persists the new state with one
 * atomic write. Pure code path: no LLM, no daemon. The CLI's
 * `muse remind run` calls it directly; a follow-up iter wires it
 * into a scheduler tick so the same engine runs every minute
 * without the user invoking it.
 *
 * The function is data-only — `registry` and `now` are injected so
 * tests can supply fakes without touching env or the real
 * messenger APIs.
 */

export interface RunDueRemindersOptions {
  readonly file: string;
  readonly registry: MessagingProviderRegistry;
  readonly providerId: string;
  readonly destination: string;
  readonly now?: () => Date;
}

export interface RunDueRemindersSummary {
  readonly delivered: number;
  readonly due: number;
  readonly errors: readonly string[];
  readonly fired: readonly PersistedReminder[];
}

export async function runDueReminders(options: RunDueRemindersOptions): Promise<RunDueRemindersSummary> {
  const now = options.now ?? (() => new Date());
  const all = await readReminders(options.file);
  const due = filterReminders(all, "due", now);

  if (due.length === 0) {
    return { delivered: 0, due: 0, errors: [], fired: [] };
  }

  const errors: string[] = [];
  let delivered = 0;
  const fired: PersistedReminder[] = [];
  let next: readonly PersistedReminder[] = all;

  for (const reminder of due) {
    try {
      // Phase C: per-reminder routing wins when set; the loop's
      // defaults are the fallback when the reminder doesn't
      // declare a destination.
      const providerId = reminder.via?.providerId ?? options.providerId;
      const destination = reminder.via?.destination ?? options.destination;
      await options.registry.send(providerId, {
        destination,
        text: reminder.text
      });
      const updated = fireReminder(next, reminder.id, now().toISOString());
      if (updated) {
        next = updated;
        const justFired = updated.find((entry) => entry.id === reminder.id);
        if (justFired) {
          fired.push(justFired);
        }
      }
      delivered += 1;
    } catch (cause) {
      errors.push(`${reminder.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  if (delivered > 0) {
    await writeReminders(options.file, next);
  }

  return { delivered, due: due.length, errors, fired };
}
