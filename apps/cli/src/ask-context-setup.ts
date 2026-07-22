import { errorMessage } from "@muse/shared";
/**
 * `muse ask` context setup, lifted out of the commands-ask god-file: resolves
 * the user key / top-K / embed model from options, runs the auto-stale
 * incremental reindex, loads (and migrates) the notes index, and emits the
 * first-run onboarding hint. Sits between the deterministic fast-path
 * short-circuit and note retrieval (`ask-note-retrieval.ts`).
 */

import { readFile } from "node:fs/promises";

import { classifyCorpusOverview } from "@muse/agent-core";
import { resolveNotesDir, resolveNotesIndexFile } from "@muse/autoconfigure";
import { corpusOnboardingHint, formatCorpusOverview, queryHasAdHocGrounding, type FileEntry } from "@muse/recall";

import type { AskOptions } from "./ask-command-options.js";
import { listNoteFiles, notesCorpusFileCount } from "./ask-corpus-helpers.js";
import { userHasOtherPersonalData } from "./ask-user-data-presence.js";
import { autoReindexNotes, isNotesIndexStale, loadIndex, type ReindexSummary } from "./commands-notes-rag.js";
import { autoReindexNotice } from "./auto-reindex-budget.js";
import { DEFAULT_EMBED_MODEL, resolveIndexModel } from "./embed-model-default.js";
import { parseBoundedInt } from "./parse-bounded-int.js";
import { resolvePersona } from "./program-helpers.js";
import type { ProgramIO } from "./program.js";
import { resolveDefaultUserKey } from "./user-id.js";

export interface NotesIndex {
  readonly builtAtIso: string;
  readonly version: number;
  readonly model: string;
  readonly files: readonly FileEntry[];
}

export function notesIndexPath(): string {
  return resolveNotesIndexFile(process.env as Record<string, string | undefined>);
}

function defaultUserKey(user: string | undefined, persona: string | undefined): string {
  const base = resolveDefaultUserKey({ override: user });
  const resolved = resolvePersona(persona);
  return resolved ? `${base}@${resolved}` : base;
}

/**
 * Resolved context the rest of the `ask` handler needs to run retrieval:
 * the effective user key / top-K / embed model, the notes directory, the
 * loaded (and migrated) notes index, the on-disk note-file count, and
 * whether this query supplied its own ad-hoc grounding source.
 */
export type AskContextResult =
  | {
      readonly kind: "ready";
      readonly userKey: string;
      readonly topK: number;
      readonly embedModel: string;
      readonly notesDir: string;
      readonly index: NotesIndex;
      readonly noteFileCount: number;
    }
  // Output already written (e.g. a whole-corpus overview) — caller returns,
  // exit code untouched.
  | { readonly kind: "handled" }
  // A message was written to io.stderr — caller sets process.exitCode = 1 and returns.
  | { readonly kind: "error" };

/**
 * `muse ask` pre-retrieval setup: option resolution, the auto-stale
 * incremental reindex, notes-index load/migration, and the first-run
 * onboarding hint. Runs after the deterministic fast-path short-circuit and
 * before `retrieveAndRankNotes`.
 */
export async function prepareAskContext(
  query: string,
  options: AskOptions,
  io: ProgramIO
): Promise<AskContextResult> {
  const userKey = defaultUserKey(options.user, options.persona);
  const topK = parseBoundedInt(options.top, "--top", 1, 20, 3);
  let embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;

  // Auto-stale check + incremental reindex (default on). JARVIS
  // shouldn't make the user remember to run reindex; if a note
  // file is newer than the index, just refresh before search.
  const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
  // Preserve the model the index was built with: a stale
  // refresh must NOT silently re-embed a custom-model index
  // with the default just because --embed-model was omitted.
  // The mismatch is still surfaced by the explicit guard below.
  let existingIndexModel: string | undefined;
  let priorAutoSummary: ReindexSummary | undefined;
  try {
    existingIndexModel = (JSON.parse(await readFile(notesIndexPath(), "utf8")) as NotesIndex).model;
  } catch {
    existingIndexModel = undefined;
  }
  if (options.autoReindex !== false) {
    try {
      const stale = await isNotesIndexStale(notesDir, notesIndexPath());
      if (stale) {
        const summary = await autoReindexNotes({
          dir: notesDir,
          indexPath: notesIndexPath(),
          // resolveIndexModel preserves a custom index model but migrates
          // the legacy default to the shipped multilingual default.
          model: resolveIndexModel(existingIndexModel, embedModel),
          // Stream per-file progress so a first ingest of a real
          // corpus (PDFs embed slowly on CPU) shows life instead of
          // a silent multi-second hang, and a skipped unreadable
          // file is visible rather than swallowed.
          onProgress: (line) => io.stderr(`  ${line}\n`)
        }, process.env);
        priorAutoSummary = summary;
        if (summary.status === "complete" && (summary.embedded > 0 || summary.failed > 0)) {
          io.stderr(`(notes index refreshed: ${summary.embedded.toString()} embedded, ${summary.skipped.toString()} cached, ${summary.failed.toString()} skipped)\n`);
        }
        const notice = autoReindexNotice(summary);
        if (notice) io.stderr(`(${notice})\n`);
      }
    } catch (cause) {
      io.stderr(`(auto-reindex skipped: ${errorMessage(cause)})\n`);
    }
  }

  // Load notes index — soft-fail with hint if missing. MUST go through
  // loadIndex, never a raw JSON.parse: the v2 index keeps embeddings in the
  // Float32 sidecar, so a raw parse yields embedding-less chunks and every
  // cosine ranking throws — silently degrading `muse ask` to lexical-only.
  let index = (await loadIndex(notesIndexPath())) as NotesIndex | undefined;
  if (!index) {
    io.stderr("No notes index at ~/.muse/notes-index.json. Run `muse notes reindex` first.\n");
    return { kind: "error" };
  }
  if (index.model !== embedModel) {
    // One-time legacy migration: an index built with the OLD default
    // re-embeds with the new multilingual default instead of dead-ending —
    // otherwise the embedder upgrade would brick every existing install.
    // A CUSTOM index model still gets the explicit mismatch error.
    if (resolveIndexModel(index.model, embedModel) === embedModel && options.autoReindex !== false) {
      io.stderr(`(embedding default upgraded '${index.model}' → '${embedModel}' — re-indexing your notes once)\n`);
      try {
        const summary = priorAutoSummary ?? await autoReindexNotes({ dir: notesDir, indexPath: notesIndexPath(), model: embedModel, onProgress: (line) => io.stderr(`  ${line}\n`) }, process.env);
        const notice = autoReindexNotice(summary);
        if (notice) io.stderr(`(${notice})\n`);
        index = (await loadIndex(notesIndexPath())) as NotesIndex | undefined;
        if (!index) return { kind: "error" };
        if (index.model !== embedModel && summary.status !== "complete") {
          io.stderr(`(using last complete '${index.model}' index while the upgrade resumes)\n`);
          embedModel = index.model;
        } else if (index.model !== embedModel) {
          return { kind: "error" };
        }
      } catch (cause) {
        io.stderr(`Re-index failed (${errorMessage(cause)}). Try: ollama pull ${embedModel}\n`);
        return { kind: "error" };
      }
    }
    if (index.model !== embedModel) {
      io.stderr(`Index was built with embed model '${index.model}', not '${embedModel}'. Re-index or pass --embed-model ${index.model}.\n`);
      return { kind: "error" };
    }
  }

  // First-run on-ramp: an empty corpus still answers honestly (refusal),
  // but a new user needs to be told HOW to add notes — emit it once here.
  // Gate on note FILES on disk, not indexed chunks: when embedding is
  // down the index has 0 live chunks though the user has notes, and
  // "your corpus is empty" would be a false message.
  const noteFileCount = await notesCorpusFileCount(notesDir);

  // A whole-corpus overview ("what's in my notes?", "list my notes") isn't a
  // top-K recall — every note matches weakly, so the gate would refuse and
  // the warm-close would tell a user WHO HAS NOTES to "add a note". Answer it
  // with the real inventory instead (deterministic, no model call, no
  // fabrication). Only when notes actually exist; empty corpus falls through
  // to the on-ramp.
  if (noteFileCount > 0 && classifyCorpusOverview(query)) {
    const overview = formatCorpusOverview(await listNoteFiles(notesDir), noteFileCount);
    if (options.json) {
      io.stdout(`${JSON.stringify({ corpusOverview: true, noteCount: noteFileCount, query })}\n`);
    } else {
      io.stdout(`${overview}\n`);
    }
    return { kind: "handled" };
  }

  // This query EXPLICITLY supplied its own grounding (a file, a URL, git, or
  // shell history) — the "add notes" on-ramp is irrelevant noise then.
  const hasAdHocGrounding = queryHasAdHocGrounding(options);
  // Only probe the other personal stores when notes ARE empty AND no ad-hoc
  // source was given (the only case the hint could fire) — so a notes-having
  // or source-supplying user pays no extra reads.
  const hasOtherPersonalData = !hasAdHocGrounding && noteFileCount === 0
    ? await userHasOtherPersonalData(userKey, process.env as Record<string, string | undefined>)
    : false;
  const onboardingHint = corpusOnboardingHint(noteFileCount, hasOtherPersonalData || hasAdHocGrounding);
  if (onboardingHint) {
    io.stderr(`${onboardingHint}\n`);
  }

  return { kind: "ready", userKey, topK, embedModel, notesDir, index, noteFileCount };
}
