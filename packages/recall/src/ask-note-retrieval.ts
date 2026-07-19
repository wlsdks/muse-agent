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

import { classifyRetrievalConfidence, lexicalOverlap, lexicalTokens, resolveRecallConfidentAt, splitCompoundQuery } from "@muse/agent-core";
import { diversifyAskChunks, secondHopAugmentChunks, shouldSecondHop, type FileEntry, type IndexChunk } from "./chunks.js";
import { demoteStale, detectStaleMarker } from "./conflict.js";
import { filterNotesByScope, relativizeNoteSource } from "./present.js";
import { existsSync } from "node:fs";
import { errorMessage } from "@muse/shared";

import { filterLiveNoteIndexFiles } from "./live-files.js";
import { cosine } from "./notes-index.js";
import { linkExpandRefs } from "./notes-links.js";

type ScoredChunk = { chunk: IndexChunk; file: string; score: number };

// Keep the package boundary aligned with the CLI's `--top` contract without
// introducing a package -> app dependency. This also bounds direct callers.
const MAX_RETRIEVAL_TOP_K = 20;

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
  /** Immutable first-retrieval snapshot for an identity-matching prepare seam. */
  snapshot?: NoteRetrievalSnapshot;
}

export type RecallRerankFn = (query: string, candidateTexts: readonly string[]) => Promise<readonly number[] | undefined>;

export interface NoteRetrievalSnapshotIdentity {
  readonly query: string;
  readonly embedModel: string;
  readonly topK: number;
  readonly scope: string | undefined;
  readonly notesDir: string;
  readonly notesIndexFile: string;
  readonly indexBuiltAtIso: string;
  readonly conflictAwareSelection: boolean;
}

export interface NoteRetrievalSnapshot {
  readonly identity: NoteRetrievalSnapshotIdentity;
  readonly rerankFn: RecallRerankFn | undefined;
  readonly result: Omit<NoteRetrievalResult, "snapshot">;
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
  /**
   * Optional listwise reranker over the candidate window (the CLI binds a
   * local-LLM picker behind MUSE_RECALL_RERANK). Receives the query + candidate
   * texts, returns candidate indices best-first — or undefined to fail open.
   */
  readonly rerankFn?: RecallRerankFn;
  /** Internal A/B switch. Production defaults ON; false reproduces baseline selection. */
  readonly conflictAwareSelection?: boolean;
  /** Index generation identity required to mint a reusable first-retrieval snapshot. */
  readonly snapshotIdentity?: { readonly notesIndexFile: string; readonly indexBuiltAtIso: string };
}): Promise<NoteRetrievalResult> {
  const { query, embedModel, indexFiles, notesDir, scope, json, onStderr, embedFn, rerankFn } = params;
  const topK = normalizeRetrievalTopK(params.topK);

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
    // Hybrid (cosine + lexical + per-clause RRF) MMR selection. With a reranker
    // bound, MMR gathers a wider window and a local LLM picks which chunks make
    // the prompt — cosine ranking is fooled by lexical-overlap distractors
    // (measured 2026-07-15: cosine top-1 3/8 vs LLM-reranked 8/8 at ~200-540ms).
    if (rerankFn) {
      const window = diversifyAskChunks(allScored, topK + 4, undefined, query, subqueryEmbeddings);
      scored = window.slice(0, topK);
      if (window.length > topK) {
        try {
          const order = await rerankFn(query, window.map((s) => s.chunk.text));
          const valid = [...new Set((order ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < window.length))];
          if (valid.length > 0) {
            const chosen = valid.slice(0, topK).map((i) => window[i]!);
            for (const s of window) {
              if (chosen.length >= topK) break;
              if (!chosen.includes(s)) chosen.push(s);
            }
            scored = chosen;
          }
        } catch {
          // reranker is best-effort — a dead model never fails the ask
        }
      }
    } else {
      scored = diversifyAskChunks(allScored, topK, undefined, query, subqueryEmbeddings);
    }
    if (params.conflictAwareSelection !== false) {
      scored = preserveConflictPairs(scored, allScored, topK);
    }
    // Graph-augmented recall (HippoRAG / GraphRAG): pull in chunks from notes 1-hop
    // LINKED from the CONFIDENT matches. Fabrication-SAFE: only the user's own real
    // notes, fires ONLY from a confident seed, the linked chunk keeps its real cosine.
    const confidentAt = resolveRecallConfidentAt(process.env, embedModel);
    const singleHopVerdict = classifyRetrievalConfidence(
      scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text })),
      { confidentAt }
    );
    const graphHopEnabled = process.env.MUSE_RECALL_GRAPH_HOP !== "false";
    try {
      const seedMatches = scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text }));
      // From a CONFIDENT seed any linked neighbor may ride along; from an
      // AMBIGUOUS seed the graph hop is exactly the independent signal the
      // failed cosine ranking needs, but only a neighbor clearing the floor
      // is promoted. Floor = bar − 0.2 (min 0.2): measured 2026-07-15 on
      // nomic-v2-moe, same-topic neighbors sit at 0.35-0.42 vs ≤0.21 for
      // off-topic, so bar 0.45 → floor 0.25 splits the two populations.
      const ambiguousFloor = Math.max(0.2, confidentAt - 0.2);
      if (graphHopEnabled && (singleHopVerdict === "confident" || singleHopVerdict === "ambiguous")) {
        const noteBodies = scopedNoteFiles
          .map((f) => ({ body: f.chunks.map((c) => c.text).join("\n"), id: relativizeNoteSource(f.path, notesDir) }));
        const seen = new Set(seedMatches.map((m) => m.source));
        // Gather wide (both link directions), then promote by REAL query cosine
        // — document order of a hub note's links is not a relevance signal.
        const promoted = linkExpandRefs({ noteBodies, seedRefs: seedMatches.map((m) => m.source), cap: 8 })
          .filter((ref) => !seen.has(ref))
          .map((ref) => allScored
            .filter((s) => relativizeNoteSource(s.file, notesDir) === ref)
            .sort((a, b) => b.score - a.score)[0])
          .filter((best): best is NonNullable<typeof best> => best !== undefined && !scored.includes(best))
          .filter((best) => singleHopVerdict === "confident" || best.score >= ambiguousFloor)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        scored = [...scored, ...promoted];
      }
    } catch {
      // graph expansion is best-effort — a malformed graph never fails the ask
    }
    // Second-hop AUGMENT (pseudo-relevance feedback): from the top seed(s) re-rank the
    // SAME in-memory chunks by cosine to the seed's embedding and APPEND the best
    // non-present chunk(s). CONFIDENCE-GATED (skipped when single-hop is confident);
    // MUSE_RECALL_SECOND_HOP=false overrides; the citation gate is the hard backstop.
    const secondHopEnabled = process.env.MUSE_RECALL_SECOND_HOP !== "false";
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
    const detail = errorMessage(cause);
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
  const result: Omit<NoteRetrievalResult, "snapshot"> = {
    notesUnavailable,
    preGapScored: [...preGapScored],
    queryVec: queryVec ? [...queryVec] : undefined,
    scored: demoteStale(scored, (s) => s.chunk.text),
    splitClauses: [...splitClauses],
    subqueryEmbeddings: subqueryEmbeddings.map((embedding) => [...embedding])
  };
  if (!params.snapshotIdentity) return result;
  const identity: NoteRetrievalSnapshotIdentity = {
    conflictAwareSelection: params.conflictAwareSelection !== false,
    embedModel,
    indexBuiltAtIso: params.snapshotIdentity.indexBuiltAtIso,
    notesDir,
    notesIndexFile: params.snapshotIdentity.notesIndexFile,
    query,
    scope: normalizedScope(scope),
    topK
  };
  const snapshotResult: Omit<NoteRetrievalResult, "snapshot"> = {
    ...result,
    preGapScored: [...result.preGapScored],
    queryVec: result.queryVec ? [...result.queryVec] : undefined,
    scored: [...result.scored],
    splitClauses: [...result.splitClauses],
    subqueryEmbeddings: result.subqueryEmbeddings.map((embedding) => [...embedding])
  };
  Object.freeze(snapshotResult.preGapScored);
  if (snapshotResult.queryVec) Object.freeze(snapshotResult.queryVec);
  Object.freeze(snapshotResult.scored);
  Object.freeze(snapshotResult.splitClauses);
  for (const embedding of snapshotResult.subqueryEmbeddings) Object.freeze(embedding);
  Object.freeze(snapshotResult.subqueryEmbeddings);
  Object.freeze(snapshotResult);
  const snapshot = Object.freeze({ identity: Object.freeze(identity), rerankFn, result: snapshotResult });
  return { ...result, snapshot };
}

function normalizedScope(scope: string | undefined): string | undefined {
  const value = scope?.trim();
  return value ? value : undefined;
}

function preserveConflictPairs(selected: readonly ScoredChunk[], candidates: readonly ScoredChunk[], topK: number): ScoredChunk[] {
  const out = [...selected];
  const protectedItems = new Set<ScoredChunk>();
  for (const stale of [...out]) {
    if (!detectStaleMarker(stale.chunk.text)) continue;
    const staleTokens = lexicalTokens(stale.chunk.text);
    const current = candidates
      .filter((candidate) => !out.includes(candidate) && !detectStaleMarker(candidate.chunk.text))
      .map((candidate) => ({
        candidate,
        semantic: cosine(stale.chunk.embedding, candidate.chunk.embedding),
        topicOverlap: lexicalOverlap(staleTokens, candidate.chunk.text)
      }))
      .filter(({ semantic, topicOverlap }) => semantic >= 0.92 && topicOverlap >= 1)
      .sort((a, b) => b.semantic - a.semantic || b.candidate.score - a.candidate.score)[0]?.candidate;
    if (!current) continue;
    if (out.length < topK) {
      out.push(current);
    } else {
      const replaceAt = out.findLastIndex((candidate) => !detectStaleMarker(candidate.chunk.text) && !protectedItems.has(candidate));
      if (replaceAt < 0) continue;
      out[replaceAt] = current;
    }
    protectedItems.add(stale);
    protectedItems.add(current);
  }
  return out;
}

function normalizeRetrievalTopK(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, MAX_RETRIEVAL_TOP_K);
}
