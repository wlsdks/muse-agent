import { readReminders, writeReminders, type PersistedReminder } from "@muse/stores";

/**
 * Event↔reminder lifecycle sync. `--remind` links a reminder to its event by
 * `eventId`; the recorded lesson is that linking two stores means EVERY
 * lifecycle op on every surface must maintain the link — the audit found the
 * cleanup lived only on the CLI commands while the agent/chat (MCP) and API
 * surfaces deleted/rescheduled events and left the reminder to fire for a
 * cancelled or moved meeting.
 */

/** Drop the reminders linked (by exact event id) to a deleted event. Matches
 *  ONLY on `eventId` (never title), so unrelated reminders are untouched. Pure. */
export function removeRemindersForEvent(
  reminders: readonly PersistedReminder[],
  eventId: string
): { readonly kept: readonly PersistedReminder[]; readonly removed: number } {
  const kept = reminders.filter((reminder) => reminder.eventId !== eventId);
  return { kept, removed: reminders.length - kept.length };
}

/**
 * Shift the reminders linked to a RESCHEDULED event by the same start-time
 * delta (newDueAt = oldDueAt + (newStart − oldStart)). A FIRED reminder whose
 * shifted due time lands in the future resets to `pending` (and clears
 * `firedAt`) so it actually fires again — the user was told it was shifted; a
 * shifted-but-still-past one stays fired (never an instant re-fire). Pure.
 */
export function rescheduleRemindersForEvent(
  reminders: readonly PersistedReminder[],
  eventId: string,
  oldStart: Date,
  newStart: Date,
  now: () => Date = () => new Date()
): { readonly next: readonly PersistedReminder[]; readonly shifted: number } {
  const deltaMs = newStart.getTime() - oldStart.getTime();
  if (deltaMs === 0 || !Number.isFinite(deltaMs)) {
    return { next: reminders, shifted: 0 };
  }
  let shifted = 0;
  const next = reminders.map((reminder) => {
    if (reminder.eventId !== eventId) {
      return reminder;
    }
    const due = Date.parse(reminder.dueAt);
    if (Number.isNaN(due)) {
      return reminder;
    }
    shifted += 1;
    const dueAt = new Date(due + deltaMs).toISOString();
    if (reminder.status === "fired" && due + deltaMs > now().getTime()) {
      const { firedAt: _firedAt, ...rest } = reminder;
      return { ...rest, dueAt, status: "pending" as const };
    }
    return { ...reminder, dueAt };
  });
  return { next, shifted };
}

/** Applied delete-sync: best-effort read→remove→write; returns removed count (0 on any failure). */
export async function syncRemindersOnEventDelete(remindersFile: string, eventId: string): Promise<number> {
  try {
    const reminders = await readReminders(remindersFile);
    const { kept, removed } = removeRemindersForEvent(reminders, eventId);
    if (removed > 0) {
      await writeReminders(remindersFile, kept);
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Applied reschedule-sync: best-effort; returns shifted count (0 on any failure). */
export async function syncRemindersOnEventReschedule(
  remindersFile: string,
  eventId: string,
  oldStart: Date,
  newStart: Date
): Promise<number> {
  try {
    const reminders = await readReminders(remindersFile);
    const { next, shifted } = rescheduleRemindersForEvent(reminders, eventId, oldStart, newStart);
    if (shifted > 0) {
      await writeReminders(remindersFile, next);
    }
    return shifted;
  } catch {
    return 0;
  }
}
