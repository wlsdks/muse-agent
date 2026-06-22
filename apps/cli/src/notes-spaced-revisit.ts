/**
 * mtime-based note views for `muse notes` — spaced revisit (the spacing
 * effect / Leitner intervals), recently-edited, and folder collections.
 * Pure selectors + formatters over pre-walked files; no embeddings, no
 * Ollama. The CLI wiring lives in `commands-notes-rag.ts`.
 */

import { relative as pathRelative } from "node:path";

import { pluralize } from "./pluralize.js";
import { walkMarkdown } from "./notes-index.js";

/**
 * Expanding review intervals (days) for spaced revisiting — the spacing
 * effect (Ebbinghaus 1885, "Über das Gedächtnis") operationalised as a
 * Leitner-style expanding schedule: a note resurfaces as its age first
 * crosses each interval, fighting the forgetting curve.
 */
export const REVISIT_INTERVALS_DAYS = [1, 3, 7, 16, 35, 90, 180] as const;

/**
 * The review interval a note's age (in days) lands on TODAY, or undefined
 * when it isn't due. Day-granular: due when `floor(ageDays)` equals an
 * interval, so a daily `muse notes review` surfaces each note once per
 * interval. Negative / non-finite age ⇒ not due.
 */
export function revisitDueInterval(ageDays: number): number | undefined {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return undefined;
  }
  const day = Math.floor(ageDays);
  return REVISIT_INTERVALS_DAYS.find((interval) => interval === day);
}

export interface RevisitCandidate {
  readonly path: string;
  readonly ageDays: number;
}

export interface RevisitDue {
  readonly path: string;
  readonly intervalDays: number;
  readonly ageDays: number;
}

/** Notes due for a spaced revisit today, soonest-interval first (path tiebreak). */
export function selectNotesForRevisit(notes: readonly RevisitCandidate[]): RevisitDue[] {
  return notes
    .flatMap((note) => {
      const intervalDays = revisitDueInterval(note.ageDays);
      return intervalDays === undefined ? [] : [{ ageDays: note.ageDays, intervalDays, path: note.path }];
    })
    .sort((a, b) => a.intervalDays - b.intervalDays || a.path.localeCompare(b.path));
}

/**
 * Walk the notes dir and return the notes due for a spaced revisit today.
 * Shared by `muse notes review` and the `muse today` briefing so both
 * surface the same set. Fail-soft: an unreadable dir yields []. */
export async function collectDueRevisits(dir: string, nowMs: number = Date.now()): Promise<RevisitDue[]> {
  const files = await walkMarkdown(dir);
  return selectNotesForRevisit(files.map((file) => ({ ageDays: (nowMs - file.mtimeMs) / 86_400_000, path: file.path })));
}

/** Recently-edited notes, newest first — "what was I working on?" Pure (over pre-walked files). */
export function selectRecentNotes(
  files: readonly { readonly path: string; readonly mtimeMs: number }[],
  limit = 10
): readonly { readonly path: string; readonly mtimeMs: number }[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, limit));
}

/** A coarse PAST-relative age — "just now" / "12m ago" / "3h ago" / "2d ago". Pure. */
export function formatRelativeAge(deltaMs: number): string {
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins.toString()}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours.toString()}h ago`;
  const days = Math.round(hours / 24);
  return `${days.toString()}d ago`;
}

/** Human-readable "recently edited" list for `muse notes recent`. Pure. */
export function formatRecentNotes(
  entries: readonly { readonly path: string; readonly mtimeMs: number }[],
  notesDir: string,
  now: Date
): string {
  if (entries.length === 0) {
    return "No notes yet. Capture one with `muse note <thought>` or `muse notes save`.\n";
  }
  const nowMs = now.getTime();
  const lines = entries.map((entry) => `  ${formatRelativeAge(nowMs - entry.mtimeMs)} — ${pathRelative(notesDir, entry.path)}`);
  return `📝 Recently edited:\n${lines.join("\n")}\n`;
}

export interface FolderSummary {
  readonly folder: string;
  readonly count: number;
  /** mtime of the MOST recently edited note in the folder (last activity). */
  readonly newestMs: number;
  /** mtime of the OLDEST note in the folder. */
  readonly oldestMs: number;
}

/**
 * Group notes by their TOP-LEVEL folder under `notesDir` (a root-level note →
 * "(root)") and aggregate the count + the newest/oldest edit time, so the user
 * can see where their knowledge lives and which collections have gone cold.
 * Sorted by note count desc, then folder name. Pure.
 */
export function summarizeNoteFolders(
  files: readonly { readonly path: string; readonly mtimeMs: number }[],
  notesDir: string
): readonly FolderSummary[] {
  const byFolder = new Map<string, { count: number; newestMs: number; oldestMs: number }>();
  for (const file of files) {
    const segments = pathRelative(notesDir, file.path).split(/[/\\]/u);
    const folder = segments.length > 1 ? segments[0]! : "(root)";
    const current = byFolder.get(folder);
    if (current) {
      current.count += 1;
      current.newestMs = Math.max(current.newestMs, file.mtimeMs);
      current.oldestMs = Math.min(current.oldestMs, file.mtimeMs);
    } else {
      byFolder.set(folder, { count: 1, newestMs: file.mtimeMs, oldestMs: file.mtimeMs });
    }
  }
  return [...byFolder.entries()]
    .map(([folder, stats]) => ({ folder, ...stats }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

/** A note collection whose NEWEST note hasn't changed in this long has gone cold. */
const FOLDER_STALE_MS = 90 * 86_400_000;

/** Human-readable note-collection overview for `muse notes folders`. Pure. */
export function formatNoteFolders(summaries: readonly FolderSummary[], now: Date): string {
  if (summaries.length === 0) {
    return "📁 No notes yet. Capture one with `muse note <thought>` or `muse notes save`.\n";
  }
  const nowMs = now.getTime();
  const totalNotes = summaries.reduce((sum, summary) => sum + summary.count, 0);
  const width = Math.max(...summaries.map((summary) => summary.folder.length));
  const lines = summaries.map((summary) => {
    const cold = nowMs - summary.newestMs > FOLDER_STALE_MS ? "  ⚠ gone cold" : "";
    const noun = summary.count === 1 ? "note " : "notes";
    return `  ${summary.folder.padEnd(width)}  ${summary.count.toString().padStart(3)} ${noun}   last edit ${formatRelativeAge(nowMs - summary.newestMs)}${cold}`;
  });
  const folderWord = summaries.length === 1 ? "collection" : "collections";
  return `📁 Your note ${folderWord} (${summaries.length.toString()} ${pluralize(summaries.length, "folder")}, ${totalNotes.toString()} ${pluralize(totalNotes, "note")}):\n${lines.join("\n")}\n`;
}
