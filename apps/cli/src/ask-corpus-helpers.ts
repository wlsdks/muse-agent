/**
 * Pure `muse ask` corpus/graph helpers, lifted out of the commands-ask god-file:
 * "does the user have content to ground on" (note-file inventory + count), the
 * authored wiki-link connection structure for the `--connect` footer, and the
 * --with-tools exposure cap. All pure / fs-only; the command action just calls them.
 */

import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { NOTE_FILE_RE } from "./commands-notes-rag.js";
import { noteLinkView, resolveNoteId, type NoteLinkGraph } from "./notes-links.js";

/**
 * The EXPLICIT `[[wiki-link]]` neighbours of the notes that just answered — the
 * notes they link to (resolved) plus the notes that link to them (backlinks) —
 * for the `--connect` footer. This is the user-AUTHORED connection structure the
 * embedding "Related in your brain" footer can't see: a note can be a deliberate
 * Zettelkasten neighbour without being embedding-similar. Pure over an already-
 * loaded graph; the grounded notes themselves are excluded, dups collapse, and
 * the list is capped. Ad-hoc sources (clipboard / url / a one-off `--file`) that
 * aren't in the note graph simply resolve to nothing and contribute no links.
 */
export function selectGraphConnections(
  graph: NoteLinkGraph,
  groundedNoteFiles: readonly string[],
  limit = 6
): string[] {
  const groundedIds = new Set<string>();
  for (const file of groundedNoteFiles) {
    const id = resolveNoteId(graph, file) ?? resolveNoteId(graph, basename(file));
    if (id) groundedIds.add(id);
  }
  const seen = new Set<string>([...groundedIds].map((id) => id.toLowerCase()));
  const out: string[] = [];
  for (const id of groundedIds) {
    const view = noteLinkView(graph, id);
    for (const o of view.outbound) {
      if (o.resolvedId && !seen.has(o.resolvedId.toLowerCase())) {
        seen.add(o.resolvedId.toLowerCase());
        out.push(o.resolvedId);
      }
    }
    for (const source of view.backlinks) {
      if (!seen.has(source.toLowerCase())) {
        seen.add(source.toLowerCase());
        out.push(source);
      }
    }
  }
  return out.slice(0, Math.max(1, limit));
}

/**
 * The user's note files (relative to `dir`), sorted, capped at `max`. Used to
 * answer a whole-corpus overview ("what's in my notes?") with the real
 * inventory instead of a low-confidence refusal. Same walk + filter as
 * `notesCorpusFileCount`. Pure of side effects; exported for direct coverage.
 */
export async function listNoteFiles(dir: string, max = 40): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && NOTE_FILE_RE.test(entry.name)) {
        out.push(relative(dir, full));
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b)).slice(0, max);
}

/**
 * Count note files (`.md/.markdown/.txt/.pdf`) actually present under the
 * notes dir, recursively — the true "does the user have a corpus" signal,
 * independent of whether embedding succeeded. Missing/unreadable dir ⇒ 0.
 */
export async function notesCorpusFileCount(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        stack.push(join(current, entry.name));
      } else if (entry.isFile() && NOTE_FILE_RE.test(entry.name)) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * The --with-tools exposure cap. tool-calling.md: every extra tool raises the
 * wrong-selection probability on a small local model — the relevance-sorted
 * plan keeps the best N, so a browse prompt still sees browser_open and an
 * action prompt its actuator. MUSE_ASK_MAX_TOOLS overrides; 0/'off' uncaps.
 */
export function resolveAskMaxTools(env: Record<string, string | undefined>): number | undefined {
  const raw = env.MUSE_ASK_MAX_TOOLS?.trim().toLowerCase();
  if (raw === "0" || raw === "off") return undefined;
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed > 0) return parsed;
  return 10;
}
