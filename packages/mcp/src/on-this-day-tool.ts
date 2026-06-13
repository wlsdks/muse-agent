/**
 * "On this day" — resurface notes the user wrote on TODAY's calendar date in
 * earlier years. A date is one of the strongest cues for autobiographical
 * memory (Rubin, Wetzler & Nebes, "Autobiographical memory across the
 * lifespan", 1986; the date-cued "On This Day" journaling apps use): the
 * anniversary pulls back context you'd otherwise never search for.
 * Deterministic, no model.
 *
 * The date comes ONLY from an explicit YYYY-MM-DD in the note's path/id (the
 * journaling convention, e.g. `journal/2025-06-06.md`) — NOT the file mtime,
 * which a later edit would move, inventing a false anniversary. A note with no
 * dated path is simply skipped.
 *
 * The pure recall logic lives here (not in the CLI) so BOTH the `muse
 * on-this-day` command and the `on_this_day_notes` agent tool share one
 * implementation — the tool can only be projected to the model from a package
 * the runtime assembly imports.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { JsonObject } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

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

/** Every note under `notesDir` carrying an explicit YYYY-MM-DD in its path, as DatedNotes. Shared by the command, the morning-brief beat, and the agent tool. */
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
    // Project the note's month-day into the year BEFORE, OF, and AFTER `now` and
    // take the smallest gap to today. A single same-year projection breaks across
    // the Jan-1 boundary: with a window, a note dated Dec 31 is ~364 days from a
    // Jan-1 `now` when projected into the same year, so the true 1-day anniversary
    // gap is missed (and the symmetric Jan→Dec case spuriously matched).
    const m = note.date.getMonth();
    const d = note.date.getDate();
    const minGap = Math.min(
      Math.abs(new Date(now.getFullYear() - 1, m, d).getTime() - todayMidnight),
      Math.abs(new Date(now.getFullYear(), m, d).getTime() - todayMidnight),
      Math.abs(new Date(now.getFullYear() + 1, m, d).getTime() - todayMidnight)
    );
    if (minGap > windowDays * DAY_MS) continue;
    out.push({ date: note.date, id: note.id, yearsAgo: now.getFullYear() - note.date.getFullYear() });
  }
  return out.sort((a, b) => b.date.getTime() - a.date.getTime());
}

const pad = (n: number): string => String(n).padStart(2, "0");
const isoDate = (d: Date): string => `${d.getFullYear().toString()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface OnThisDayToolDeps {
  readonly datedNotes: () => Promise<readonly DatedNote[]> | readonly DatedNote[];
  /** Injected clock so the anniversary window is deterministic in tests. */
  readonly now?: () => Date;
}

export function createOnThisDayTool(deps: OnThisDayToolDeps): MuseTool {
  return {
    definition: {
      description:
        "List the user's past notes written on TODAY's calendar date in earlier years (date-cued 'on this day' recall) — answers 'what did I write on this day in past years?' / '오늘 같은 날 예전에 뭐 적었지?'. Use when the user asks for notes from this same date in prior years, or an anniversary look-back. Do NOT use for a general keyword search of notes (use the notes search tool) or for a specific date other than today. Read-only.",
      domain: "notes",
      inputSchema: {
        additionalProperties: false,
        properties: {
          windowDays: { description: "Optional ± window in days around today, e.g. 3 to include a few days either side. Defaults to 0 (today's date exactly).", maximum: 7, minimum: 0, type: "integer" }
        },
        required: [],
        type: "object"
      },
      keywords: ["on this day", "anniversary", "past notes", "years ago", "오늘 같은 날", "예전", "그날", "journal"],
      name: "on_this_day_notes",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const raw = args["windowDays"];
      const windowDays = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.min(7, Math.trunc(raw)) : 0;
      const notes = await Promise.resolve(deps.datedNotes());
      const now = deps.now ? deps.now() : new Date();
      const hits = selectOnThisDay(notes, now, { windowDays });
      return {
        count: hits.length,
        onThisDay: hits.map((h) => ({ date: isoDate(h.date), id: h.id, yearsAgo: h.yearsAgo })),
        windowDays
      };
    }
  };
}
