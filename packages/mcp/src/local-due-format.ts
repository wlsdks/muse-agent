/**
 * Render a due instant (a UTC ISO timestamp) as a human-friendly string in
 * the SERVER'S LOCAL timezone — the same wall clock the relative-time parser
 * (`resolveRelativeTimePhrase` / `parseTaskDueAt`) resolved the user's phrase
 * against. Shared by the reminders AND tasks MCP tool surfaces so a chat
 * confirmation echoes the time the user actually asked for.
 *
 * The bug this closes: the chat model echoed the raw ISO hour ("…T06:00:00Z"
 * → "6:00 AM") when the user had said "3pm" (KST), because the ISO is in UTC.
 * Handing the model a pre-formatted local string removes the misread. It is a
 * leaf util (no store imports) so both stores can depend on it without a cycle.
 */

const DUE_LOCAL_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true
};

function relativeDueHint(due: Date, now: Date): string | undefined {
  const diffMs = due.getTime() - now.getTime();
  if (diffMs < 0) {
    return "overdue";
  }
  if (diffMs < 60 * 60_000) {
    const mins = Math.max(1, Math.round(diffMs / 60_000));
    return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const localDayIndex = (d: Date): number =>
    Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / 86_400_000);
  const days = localDayIndex(due) - localDayIndex(now);
  if (days <= 0) {
    return "today";
  }
  if (days === 1) {
    return "tomorrow";
  }
  return `in ${days} days`;
}

/**
 * "Fri, Jun 5, 2026, 3:00 PM (tomorrow)" — absolute local time plus a relative
 * hint. Unparseable input is echoed verbatim so the model never silently loses
 * the value.
 */
export function formatDueLocal(dueAt: string, now: () => Date = () => new Date()): string {
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) {
    return dueAt;
  }
  const absolute = due.toLocaleString("en-US", DUE_LOCAL_FORMAT);
  const relative = relativeDueHint(due, now());
  return relative ? `${absolute} (${relative})` : absolute;
}
