/**
 * The notes RAG core for `muse ask`, lifted out of the commands-ask god-file:
 * embed the query → cosine-rank the live (scope-filtered) note chunks → RAG-Fusion
 * per-clause + hybrid MMR selection → graph-augment from confident seeds' wiki-links
 * → confidence-gated second-hop augment. Fail-open by construction: any embed error
 * degrades to "no notes grounding" (notesUnavailable) and the caller still answers
 * from the other stores + general knowledge. Returns the ranked set plus the
 * pre-gap-cut distribution (for the confidence verdict) and the clause embeddings
 * (for the set-level sufficiency advisory).
 */

import { existsSync } from "node:fs";
import { classifyRetrievalConfidence, resolveRecallConfidentAt, splitCompoundQuery } from "@muse/agent-core";
import { parseBooleanFromEnv } from "@muse/shared";
import { diversifyAskChunks, secondHopAugmentChunks, shouldSecondHop, type FileEntry, type IndexChunk } from "./chunks.js";
import { demoteStale } from "./conflict.js";
import { filterNotesByScope, relativizeNoteSource } from "./present.js";

import { filterLiveNoteIndexFiles } from "./live-files.js";
import { cosine } from "./notes-index.js";
import { linkExpandRefs } from "./notes-links.js";

type ScoredChunk = { chunk: IndexChunk; file: string; score: number };

export interface NoteRetrievalResult {
  /** The selected (MMR + graph + second-hop) chunks for the prompt window. */
  scored: ScoredChunk[];
  /** The untrimmed top-K distribution — the confidence verdict reads THIS so a
   *  gap-cut to 1 chunk can't flip ambiguous→confident by zeroing the runner-up. */
  preGapScored: ScoredChunk[];
  /** Per-clause embeddings of a compound query (for the sufficiency advisory). */
  subqueryEmbeddings: ReadonlyArray<readonly number[]>;
  splitClauses: readonly string[];
  /** True when the embedding endpoint failed — degrade to no-notes grounding. */
  notesUnavailable: boolean;
  queryVec: number[] | undefined;
}

export async function retrieveAndRankNotes(params: {
  readonly query: string;
  readonly embedModel: string;
  readonly indexFiles: readonly FileEntry[];
  readonly notesDir: string;
  readonly topK: number;
  readonly scope: string | undefined;
  readonly json: boolean;
  readonly onStderr: (text: string) => void;
  /** Embed via the caller's resolved endpoint (the CLI binds the models.json merge). */
  readonly embedFn: (text: string, model: string) => Promise<number[]>;
}): Promise<NoteRetrievalResult> {
  const { query, embedModel, indexFiles, notesDir, topK, scope, json, onStderr, embedFn } = params;

  let scored: ScoredChunk[] = [];
  let preGapScored: ScoredChunk[] = [];
  let subqueryEmbeddings: ReadonlyArray<readonly number[]> = [];
  let splitClauses: readonly string[] = [];
  let notesUnavailable = false;
  let queryVec: number[] | undefined;
  try {
    // S3 narrate-the-wait: a REAL stage delta before the embed — on a 10-40s local
    // model the pre-answer gap reads as a hang; this makes it read as thinking.
    if (!json) {
      onStderr("🔎 searching your notes…\n");
    }
    queryVec = await embedFn(query, embedModel);
    const liveNoteFiles = filterLiveNoteIndexFiles(indexFiles, existsSync);
    const scopedNoteFiles = scope ? filterNotesByScope(liveNoteFiles, notesDir, scope) : liveNoteFiles;
    if (scope && liveNoteFiles.length > 0 && scopedNoteFiles.length === 0 && !json) {
      onStderr(`muse: no notes under '${scope}/' — grounding on nothing for this question.\n`);
    }
    const allScored = scopedNoteFiles.flatMap((f) => f.chunks.map((chunk) => ({
      chunk,
      file: f.path,
      score: cosine(queryVec!, chunk.embedding)
    })));
    preGapScored = [...allScored].sort((a, b) => b.score - a.score).slice(0, topK);
    // RAG-Fusion (arXiv:2402.03367): for a compound question each clause gets its
    // own embedding → its own cosine ranking → all rankings fused via RRF. Fail-open:
    // any embed error leaves clause vectors empty (byte-identical to non-compound).
    try {
      const clauses = splitCompoundQuery(query);
      if (clauses.length >= 2) {
        splitClauses = clauses;
        subqueryEmbeddings = await Promise.all(clauses.map((c) => embedFn(c, embedModel)));
      }
    } catch {
      subqueryEmbeddings = [];
      splitClauses = [];
    }
    // Hybrid (cosine + lexical + per-clause RRF) MMR selection.
    scored = diversifyAskChunks(allScored, topK, undefined, query, subqueryEmbeddings);
    // Graph-augmented recall (HippoRAG / GraphRAG): pull in chunks from notes 1-hop
    // LINKED from the CONFIDENT matches. Fabrication-SAFE: only the user's own real
    // notes, fires ONLY from a confident seed, the linked chunk keeps its real cosine.
    const singleHopVerdict = classifyRetrievalConfidence(
      scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text })),
      { confidentAt: resolveRecallConfidentAt(process.env, embedModel) }
    );
    try {
      const seedMatches = scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text }));
      if (singleHopVerdict === "confident") {
        const noteBodies = scopedNoteFiles
          .map((f) => ({ body: f.chunks.map((c) => c.text).join("\n"), id: relativizeNoteSource(f.path, notesDir) }));
        const seen = new Set(seedMatches.map((m) => m.source));
        for (const ref of linkExpandRefs({ noteBodies, seedRefs: seedMatches.map((m) => m.source), cap: 2 })) {
          if (seen.has(ref)) continue;
          const best = allScored
            .filter((s) => relativizeNoteSource(s.file, notesDir) === ref)
            .sort((a, b) => b.score - a.score)[0];
          if (best && !scored.includes(best)) {
            scored = [...scored, best];
            seen.add(ref);
          }
        }
      }
    } catch {
      // graph expansion is best-effort — a malformed graph never fails the ask
    }
    // Second-hop AUGMENT (pseudo-relevance feedback): from the top seed(s) re-rank the
    // SAME in-memory chunks by cosine to the seed's embedding and APPEND the best
    // non-present chunk(s). CONFIDENCE-GATED (skipped when single-hop is confident);
    // MUSE_RECALL_SECOND_HOP=false overrides; the citation gate is the hard backstop.
    const secondHopEnabled = parseBooleanFromEnv(process.env.MUSE_RECALL_SECOND_HOP, true);
    if (secondHopEnabled && shouldSecondHop(singleHopVerdict) && queryVec && scored.length > 0) {
      try {
        const additions = secondHopAugmentChunks(queryVec, cosine, allScored, scored.slice(0, 2), scored, 2);
        for (const add of additions) {
          if (!scored.includes(add)) scored = [...scored, add];
        }
      } catch {
        // second-hop is best-effort — never fails the ask
      }
    }
  } catch (cause) {
    notesUnavailable = true;
    const detail = cause instanceof Error ? cause.message : String(cause);
    onStderr(
      `(notes search unavailable — embedding via '${embedModel}' failed: ${detail}. ` +
      `Answering without notes context. To restore RAG grounding: ` +
      `\`ollama pull ${embedModel}\` (and ensure Ollama is running).)\n`
    );
  }

  // A note that explicitly marks itself superseded ("used to …", "예전에 …")
  // must not outrank its current counterpart in the answer evidence — demote it
  // below, never drop it. Confidence classification reads `preGapScored`
  // (untouched), so this only reorders which chunk the model sees/cites first.
  return { notesUnavailable, preGapScored, queryVec, scored: demoteStale(scored, (s) => s.chunk.text), splitClauses, subqueryEmbeddings };
}
