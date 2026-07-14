/**
 * Wires Muse's confidence-gated proactive recall (the north star) into the
 * LOCAL daemon over the pre-embedded `~/.muse/notes-index.json`. The proactive
 * loop's `investigate` seam asks "is there something in the user's own notes
 * worth surfacing for this imminent item?" — and this answers with a cited
 * finding ONLY when the recall is confident, reusing the same deterministic
 * CRAG gate (`decideProactiveRecall`) as `muse ask`. Re-embeds only the QUERY
 * each tick (the corpus is already embedded), so it's cheap to run on a timer.
 *
 * Fail-open everywhere: a missing index, an embed error, or a weak recall →
 * `undefined`, and the proactive notice still fires without a finding.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { decideProactiveRecall, FindingResurfaceSuppressor, resolveRecallConfidentAt, type KnowledgeMatch } from "@muse/agent-core";
import { relativizeNoteSource } from "@muse/recall";
import { resolveNoteProvenanceFile, resolveNotesDir } from "@muse/autoconfigure";

import { cosineSimilarity, embed } from "./embed.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { readNoteProvenance, untrustedNotePaths } from "./note-provenance.js";

interface IndexChunk {
  readonly file: string;
  readonly text: string;
  readonly embedding: number[];
}

interface NotesIndex {
  readonly model?: string;
  readonly files?: readonly { readonly chunks?: readonly IndexChunk[] }[];
}

/**
 * Pure: cosine-rank the pre-embedded chunks against an already-embedded query
 * vector and return the top-K as KnowledgeMatch[] (cosine = score). Exported
 * for direct unit coverage without touching disk or Ollama.
 */
export function proactiveMatchesFromIndex(
  queryVec: readonly number[],
  chunks: readonly IndexChunk[],
  topK = 3,
  /** Returns true when a chunk's note FILE is an externally-ingested (untrusted)
   *  note — its match is tagged `trusted:false` so the proactive finding is cued
   *  instead of laundered as "your notes". Absent ⇒ all trusted. Pure/injectable. */
  isUntrusted?: (file: string) => boolean
): KnowledgeMatch[] {
  return chunks
    .map((c): KnowledgeMatch => {
      const cos = cosineSimilarity(queryVec, c.embedding);
      return { cosine: cos, score: cos, source: c.file, text: c.text, ...(isUntrusted?.(c.file) ? { trusted: false } : {}) };
    })
    .sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0))
    .slice(0, Math.max(1, Math.trunc(topK)));
}

export interface IndexedProactiveInvestigatorOptions {
  readonly indexFile?: string;
  readonly embedModel?: string;
  readonly topK?: number;
  readonly confidentAt?: number;
  /** Test seam — defaults to the real Ollama embedder. */
  readonly embedText?: (text: string, model: string) => Promise<readonly number[]>;
  /** Anti-nag re-surface gate (one per investigator instance); injectable for tests. */
  readonly suppressor?: FindingResurfaceSuppressor;
  /** Clock seam for the re-surface cooldown; defaults to Date.now. */
  readonly now?: () => number;
}

export function createIndexedProactiveInvestigator(
  options: IndexedProactiveInvestigatorOptions = {}
): (item: { readonly title: string; readonly kind: string; readonly factSheet: string }) => Promise<string | undefined> {
  const indexFile = options.indexFile ?? join(homedir(), ".muse", "notes-index.json");
  const embedText = options.embedText ?? ((text, model) => embed(text, model));
  // One suppressor per investigator instance (the daemon makes one, reused across
  // ticks) so a recurring item's identical finding isn't re-shown every tick.
  const suppressor = options.suppressor ?? new FindingResurfaceSuppressor();
  const now = options.now ?? Date.now;
  return async (item) => {
    const query = item.title.trim();
    if (query.length === 0) return undefined;
    let index: NotesIndex;
    try {
      index = JSON.parse(await readFile(indexFile, "utf8")) as NotesIndex;
    } catch {
      return undefined;
    }
    const chunks = (index.files ?? []).flatMap((f) => f.chunks ?? []);
    if (chunks.length === 0) return undefined;
    // The embed model the index was built with — drives BOTH the query embed and
    // the confidence bar (the bar is embedder-specific; the v2-moe default tops
    // genuine matches ~0.42–0.46, so the nomic-calibrated 0.55 leaves the proactive
    // "Related in your notes" surface effectively dead on the shipped default).
    const effectiveEmbedModel = options.embedModel ?? index.model ?? DEFAULT_EMBED_MODEL;
    let queryVec: readonly number[];
    try {
      queryVec = await embedText(query, effectiveEmbedModel);
    } catch {
      return undefined;
    }
    // Externally-ingested (untrusted) notes — so the proactive finding for a
    // poisoned URL-ingested note is cued, not laundered as "your notes" (NP-proactive).
    // Fail-open: a provenance read error → no tagging (all trusted), never blocks the nudge.
    let isUntrusted: ((file: string) => boolean) | undefined;
    try {
      const untrusted = untrustedNotePaths(await readNoteProvenance(resolveNoteProvenanceFile(process.env)));
      if (untrusted.size > 0) {
        const notesDir = resolveNotesDir(process.env);
        isUntrusted = (file: string): boolean => untrusted.has(relativizeNoteSource(file, notesDir));
      }
    } catch { /* provenance is best-effort — never block the proactive nudge */ }
    const matches = proactiveMatchesFromIndex(queryVec, chunks, options.topK ?? 3, isUntrusted);
    const decision = decideProactiveRecall(matches, {
      query,
      // Default to the EMBEDDER-AWARE bar (0.45 for v2-moe) so the surface isn't
      // dead on the shipped default; an explicit option still wins.
      confidentAt: options.confidentAt ?? resolveRecallConfidentAt(process.env, effectiveEmbedModel)
    });
    if (!decision.surface || decision.finding === undefined) return undefined;
    // Anti-nag: withhold an identical finding already surfaced within the cooldown.
    return suppressor.shouldSurface(decision.finding, now()) ? decision.finding : undefined;
  };
}
