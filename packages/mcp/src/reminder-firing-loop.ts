import type { MessagingProviderRegistry } from "@muse/messaging";

import { appendReminderHistory } from "./personal-reminder-history-store.js";
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
  /**
   * When set, every delivery attempt (success or failure) is
   * appended to this file via `appendReminderHistory`. Records the
   * resolved providerId/destination so the user can audit "did the
   * 9am reminder actually land?" weeks later — even if the source
   * reminder has since been cleared.
   */
  readonly historyFile?: string;
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
    // Phase C: per-reminder routing wins when set; the loop's
    // defaults are the fallback when the reminder doesn't
    // declare a destination. Resolved before the try so the
    // history record can attribute the failure to the same
    // resolved destination on the failure path.
    const providerId = reminder.via?.providerId ?? options.providerId;
    const destination = reminder.via?.destination ?? options.destination;
    try {
      await options.registry.send(providerId, {
        destination,
        text: reminder.text
      });
      const firedAtIso = now().toISOString();
      const updated = fireReminder(next, reminder.id, firedAtIso);
      if (updated) {
        next = updated;
        const justFired = updated.find((entry) => entry.id === reminder.id);
        if (justFired) {
          fired.push(justFired);
        }
      }
      delivered += 1;
      if (options.historyFile) {
        await appendReminderHistory(options.historyFile, {
          destination,
          firedAtIso,
          providerId,
          reminderId: reminder.id,
          status: "delivered",
          text: reminder.text
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      errors.push(`${reminder.id}: ${message}`);
      if (options.historyFile) {
        await appendReminderHistory(options.historyFile, {
          destination,
          error: message,
          firedAtIso: now().toISOString(),
          providerId,
          reminderId: reminder.id,
          status: "failed",
          text: reminder.text
        });
      }
    }
  }

  if (delivered > 0) {
    await writeReminders(options.file, next);
  }

  return { delivered, due: due.length, errors, fired };
}
