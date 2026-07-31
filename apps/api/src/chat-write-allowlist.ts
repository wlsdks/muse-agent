/**
 * The notes/tasks/calendar/reminders/continuity read+write tool names an approval-gated
 * surface may expose. Shared by the inbound-channel path and the direct
 * `/api/chat` write path (behind `MUSE_CHAT_WRITE_ENABLED`) so both draw the
 * exact same allowlist — a tool absent here is never reachable on either
 * surface, whatever the approval flow decides. Its own module (not
 * `inbound-agent-run.ts`) so importing it into `server-helpers.ts` cannot
 * introduce a load cycle.
 */
export const CHANNEL_APPROVAL_EXPOSURE_ALLOWLIST = [
  "muse.notes.list", "muse.notes.read", "muse.notes.search", "muse.notes.save", "muse.notes.append",
  "muse.tasks.list", "muse.tasks.search", "muse.tasks.add", "muse.tasks.complete", "muse.tasks.update",
  "muse.calendar.providers", "muse.calendar.list", "muse.calendar.availability", "muse.calendar.conflicts", "muse.calendar.add", "muse.calendar.update",
  "muse.reminders.list", "muse.reminders.search", "muse.reminders.add", "muse.reminders.snooze",
  "muse.continuity.thread.create", "muse.continuity.task.link",
  "muse.continuity.pack.preview", "muse.continuity.capsule.prepare",
  "muse.continuity.pack.open", "muse.continuity.delivery.outcome"
] as const;
