/**
 * "On this day" CLI presentation. The pure date-cued recall logic
 * (collectDatedNotes / extractNoteDate / selectOnThisDay) now lives in
 * `@muse/mcp` so the `on_this_day_notes` agent tool and this command share one
 * implementation; this file re-exports it (call sites keep importing from
 * `./on-this-day.js`) and adds the CLI/brief text rendering.
 */

import { type OnThisDayHit } from "@muse/domain-tools";

export { collectDatedNotes, extractNoteDate, selectOnThisDay, type OnThisDayHit } from "@muse/domain-tools";

const fmtDate = (d: Date): string => d.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });

/** A compact one-line "on this day" beat for the morning brief (top `maxItems`); "" when there are no hits. */
export function formatOnThisDayBrief(hits: readonly OnThisDayHit[], maxItems = 3): string {
  if (hits.length === 0) return "";
  const items = hits.slice(0, Math.max(1, maxItems))
    .map((h) => `${h.id} (${h.yearsAgo.toString()} year${h.yearsAgo === 1 ? "" : "s"} ago)`)
    .join("; ");
  return `\n📅 On this day, you wrote: ${items}\n`;
}

/** Render the "On this day" block; "" when there are no hits. */
export function formatOnThisDay(hits: readonly OnThisDayHit[], now: Date): string {
  if (hits.length === 0) return "";
  const day = now.toLocaleDateString("en-US", { day: "numeric", month: "long" });
  const lines = [`📅 On this day (${day}) — from your notes:`];
  for (const hit of hits) {
    lines.push(`  • ${hit.id} — ${hit.yearsAgo.toString()} year${hit.yearsAgo === 1 ? "" : "s"} ago (${fmtDate(hit.date)})`);
  }
  return `${lines.join("\n")}\n`;
}
