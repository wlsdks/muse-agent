/**
 * Render a double-booking warning for the morning brief — surfaced
 * deterministically (not left to the model to notice) because a clash in your
 * day is the single thing you most want flagged at a glance.
 */

import type { CalendarConflict } from "@muse/domain-tools";

const clock = (date: Date): string => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** The "🗓️ double-booked" block — empty string when there are no overlaps. */
export function formatBriefConflicts(conflicts: readonly CalendarConflict[]): string {
  if (conflicts.length === 0) return "";
  const lines = conflicts.map((conflict) => `  ⚠️ "${conflict.a.title}" (${clock(conflict.a.startsAt)}) overlaps "${conflict.b.title}" (${clock(conflict.b.startsAt)})`);
  return `\n🗓️  Heads up — you're double-booked:\n${lines.join("\n")}\n`;
}
