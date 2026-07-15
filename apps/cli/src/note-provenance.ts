/**
 * Note provenance — which notes were INGESTED from an external source (a web URL)
 * versus authored by the user. A note ingested via `muse notes ingest --url` is
 * third-party content written verbatim into the notes corpus; once indexed it is
 * grounded like any note, so without a provenance signal a poisoned web page
 * laundered into a note grounds as trusted "your own note" (the GROUNDED≠TRUE
 * note-veracity gap; the episode/feed/tool trust machinery never covered notes).
 *
 * This is the recall-time trust signal: recall tags grounding evidence from an
 * externally-ingested note `trusted:false` so an answer resting SOLELY on it trips
 * the untrusted-only source-check cue. User-AUTHORED notes carry no entry and stay
 * trusted (absent ⇒ trusted, mirroring the KnowledgeMatch convention). Keyed by the
 * note's path RELATIVE to the notes root — the same form recall's note evidence uses.
 */
import { readFile } from "node:fs/promises";

import { atomicWriteFile } from "@muse/stores";
import { isRecord } from "@muse/shared";

export interface NoteProvenanceEntry {
  /** Note path relative to the notes root (matches recall's `relativizeNoteSource`). */
  readonly path: string;
  /** The external URL the note was ingested from. */
  readonly sourceUrl: string;
  /** ISO timestamp of the ingest. */
  readonly ingestedAt: string;
}

function isEntry(value: unknown): value is NoteProvenanceEntry {
  if (!isRecord(value)) return false;
  const e = value;
  return typeof e["path"] === "string" && typeof e["sourceUrl"] === "string" && typeof e["ingestedAt"] === "string";
}

/** Read the provenance log. Tolerates a missing / corrupt / wrong-shape file (→ []). */
export async function readNoteProvenance(file: string): Promise<readonly NoteProvenanceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.notes)) {
    return [];
  }
  return parsed.notes.filter(isEntry);
}

/**
 * Record (upsert by path) that a note was ingested from an external URL. Serialised
 * read-modify-write; the newest ingest of a given path wins. Fail-soft is the
 * caller's choice — a provenance write failure must never block the ingest itself.
 */
export async function recordIngestedNote(file: string, entry: NoteProvenanceEntry): Promise<void> {
  const existing = await readNoteProvenance(file);
  const next = [...existing.filter((e) => e.path !== entry.path), entry];
  // Atomic: the note-provenance ledger backs the `[from …]` citation chain — a
  // crash mid-write of a raw writeFile corrupts it, breaking provenance for every
  // ingested note until it's rebuilt.
  await atomicWriteFile(file, JSON.stringify({ notes: next }, null, 2));
}

/**
 * The set of note paths that are externally-ingested (untrusted) — recall tags a
 * note match whose path is in this set `trusted:false`. Pure.
 */
export function untrustedNotePaths(entries: readonly NoteProvenanceEntry[]): ReadonlySet<string> {
  return new Set(entries.map((e) => e.path));
}
