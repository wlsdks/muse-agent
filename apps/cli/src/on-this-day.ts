/**
 * "On this day" — resurface notes you wrote on TODAY's calendar date in earlier
 * years. A date is one of the strongest cues for autobiographical memory (Rubin,
 * Wetzler & Nebes, "Autobiographical memory across the lifespan", 1986; the
 * date-cued "On This Day" that journaling apps use): the anniversary pulls back
 * context you'd otherwise never search for. Deterministic, no model.
 *
 * The date comes ONLY from an explicit YYYY-MM-DD in the note's path/id (the
 * journaling convention, e.g. `journal/2025-06-06.md`) — NOT the file mtime,
 * which a later edit would move, inventing a false anniversary. A note with no
 * dated path is simply skipped.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface DatedNote {
  readonly id: string;
  readonly date: Date;
}

/** Recursively collect every `.md` file under `dir`, as paths relative to `base` (so a journal/YYYY-MM-DD.md keeps its dated path). */
async function walkMarkdown(dir: string, base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full, base)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(relative(base, full));
  }
  return out;
}

/** Every note under `notesDir` carrying an explicit YYYY-MM-DD in its path, as DatedNotes. Shared by the command and the morning-brief beat. */
export async function collectDatedNotes(notesDir: string): Promise<DatedNote[]> {
  const dated: DatedNote[] = [];
  for (const relPath of await walkMarkdown(notesDir, notesDir)) {
    const date = extractNoteDate(relPath);
    if (date) dated.push({ date, id: relPath });
  }
  return dated;
}

const DATE_IN_PATH = /(\d{4})-(\d{2})-(\d{2})/u;

/** Parse an explicit YYYY-MM-DD from a note id/path into a local Date; undefined if absent or not a real calendar date. */
export function extractNoteDate(noteId: string): Date | undefined {
  const m = DATE_IN_PATH.exec(noteId);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(year, month - 1, day);
  // Reject an overflowed date (e.g. 2025-02-30 → Mar 2): the round-trip must match.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  return date;
}

export interface OnThisDayHit {
  readonly id: string;
  readonly date: Date;
  /** Whole years between the note's date and now (>= 1). */
  readonly yearsAgo: number;
}

const DAY_MS = 86_400_000;

/**
 * Notes whose date falls on today's calendar day (±`windowDays`) in a PRIOR
 * year, most-recent first. The ± window is computed by projecting each note's
 * month-day into the current year, so it handles year boundaries cleanly. A note
 * dated today (this year) is not "on this day" — only earlier years count.
 */
export function selectOnThisDay(notes: readonly DatedNote[], now: Date, options: { readonly windowDays?: number } = {}): OnThisDayHit[] {
  const windowDays = Math.max(0, Math.trunc(Number.isFinite(options.windowDays) ? options.windowDays! : 0));
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const out: OnThisDayHit[] = [];
  for (const note of notes) {
    if (note.date.getFullYear() >= now.getFullYear()) continue; // only prior years
    const projected = new Date(now.getFullYear(), note.date.getMonth(), note.date.getDate()).getTime();
    if (Math.abs(projected - todayMidnight) > windowDays * DAY_MS) continue;
    out.push({ date: note.date, id: note.id, yearsAgo: now.getFullYear() - note.date.getFullYear() });
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

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
